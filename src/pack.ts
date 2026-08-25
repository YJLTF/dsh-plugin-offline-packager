import { execSync, type ExecSyncOptions } from 'child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { resolve, join, basename } from 'path'
import { randomUUID } from 'crypto'

const execOptions: ExecSyncOptions = {
  encoding: 'utf-8',
  stdio: 'pipe',
  timeout: 300_000,
}

/**
 * 将指定的 DSH 插件打包为离线安装包（.tgz）。
 *
 * 打包在暂存目录中进行：先把插件源码放入 stage，安装其生产依赖，
 * 再通过 bundleDependencies 将整个依赖闭包写入 tarball（npm pack 对
 * bundleDependencies 列出的包会携带 node_modules），使离线机器安装时
 * 无需访问 registry。peerDependencies 不打入（由 DSH 宿主提供）。
 *
 * @param source   - npm 包名、GitHub URL 或本地路径
 * @param outputDir - 输出目录
 * @param outputName - 可选输出文件名
 * @param includeDeps - 是否将 npm 依赖打入离线包（默认 true）
 * @returns 生成的 .tgz 文件绝对路径
 */
export async function packPlugin(
  source: string,
  outputDir: string,
  outputName?: string,
  includeDeps = true,
): Promise<string> {
  const outDir = resolve(outputDir)
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true })
  }

  const tmpDir = join(outDir, '.tmp-' + randomUUID())
  mkdirSync(tmpDir, { recursive: true })

  try {
    const stage = join(tmpDir, 'stage')
    mkdirSync(stage, { recursive: true })

    // 1. 将插件源码放入暂存目录（构建在暂存目录内完成，不触碰原目录）
    await prepareStage(source, stage, tmpDir)

    // 2. 安装生产依赖并写入 bundleDependencies
    let bundled: string[] = []
    if (includeDeps) {
      bundled = bundleDeps(stage)
    } else {
      pruneNodeModules(stage)
    }

    // 3. 打包（--ignore-scripts：构建已在暂存阶段完成，避免 prepare 重复执行）
    const tarballPath = packStage(stage, outDir, outputName)

    // 4. 生成离线元数据文件
    const meta: OfflineMetadata = {
      packageName: normalizeSourceName(source),
      packagedAt: new Date().toISOString(),
      originalSource: source,
      harnessVersion: getHarnessVersion(),
      packagerVersion: '0.2.0',
      bundledDependencies: bundled,
    }
    const metaPath = join(outDir, basename(tarballPath, '.tgz') + '.meta.json')
    writeFileSync(metaPath, JSON.stringify(meta, null, 2))

    return tarballPath
  } finally {
    cleanup(tmpDir)
  }
}

interface OfflineMetadata {
  packageName: string
  packagedAt: string
  originalSource: string
  harnessVersion: string
  packagerVersion: string
  bundledDependencies: string[]
}

type SourceType = 'npm' | 'github' | 'local'

function detectSourceType(source: string): SourceType {
  // GitHub URL 或 github:user/repo 格式
  if (
    source.startsWith('github:') ||
    source.startsWith('http://github.com') ||
    source.startsWith('https://github.com') ||
    source.startsWith('git@github.com')
  ) {
    return 'github'
  }

  // 本地路径（以 / 或 . 或 ~ 开头，或包含路径分隔符，或路径存在）
  if (
    source.startsWith('.') ||
    source.startsWith('~') ||
    source.startsWith('/') ||
    source.includes('\\') ||
    existsSync(resolve(source))
  ) {
    return 'local'
  }

  // 默认视为 npm 包名
  return 'npm'
}

/**
 * 将插件源码放入暂存目录：
 * - npm：npm pack 下载已发布 tarball 后解压
 * - GitHub：克隆后安装依赖并构建
 * - 本地：复制源码（排除 node_modules / .git）后按需构建
 */
async function prepareStage(source: string, stage: string, tmpDir: string) {
  switch (detectSourceType(source)) {
    case 'npm': {
      const result = String(execSync(
        `npm pack ${source} --pack-destination "${tmpDir}"`,
        execOptions,
      ))
      const filename = result.trim().split('\n').pop()?.trim() ?? ''
      if (!filename || !filename.endsWith('.tgz')) {
        throw new Error(`npm pack 失败: 未获取到文件名，输出: ${result}`)
      }
      // 使用相对路径调用 tar：Windows 上 GNU tar 会把 "F:\..." 的冒号
      // 解析为远程主机，bsdtar 则兼容两者，相对路径对两种实现都安全
      execSync(`tar -xzf "${filename}" -C stage --strip-components=1`, {
        ...execOptions,
        cwd: tmpDir,
      })
      return
    }
    case 'github': {
      const repoUrl = source.startsWith('github:')
        ? `https://github.com/${source.slice(7)}`
        : source
      execSync(`git clone --depth 1 ${repoUrl} "${stage}"`, execOptions)
      if (!existsSync(join(stage, 'package.json'))) {
        throw new Error(`GitHub 仓库 ${repoUrl} 中未找到 package.json`)
      }
      buildInStage(stage)
      return
    }
    case 'local': {
      const absPath = resolve(source)
      if (!existsSync(join(absPath, 'package.json'))) {
        throw new Error(`本地路径 ${absPath} 中未找到 package.json`)
      }
      cpSync(absPath, stage, {
        recursive: true,
        filter: (src) => {
          const rel = src.slice(absPath.length).replace(/^[\\/]/, '')
          return rel !== 'node_modules' && !rel.startsWith('node_modules/') && !rel.startsWith('node_modules\\') && rel !== '.git' && !rel.startsWith('.git/')
        },
      })
      // 有构建脚本产物缺失时先构建（例如存在 tsconfig.json 但没有 lib/）
      const pkg = readPackageJson(stage)
      const needsBuild = (pkg.scripts?.prepare || pkg.scripts?.build) &&
        (existsSync(join(stage, 'tsconfig.json')) && !existsSync(join(stage, 'lib')))
      if (needsBuild) buildInStage(stage)
      return
    }
  }
}

/**
 * 在暂存目录内安装全部依赖并执行构建脚本，
 * 随后修剪掉开发依赖，只保留生产依赖闭包。
 */
function buildInStage(stage: string) {
  execSync('npm install --no-audit --no-fund', { ...execOptions, cwd: stage })
  const pkg = readPackageJson(stage)
  if (pkg.scripts?.prepare) {
    try {
      execSync('npm run prepare', { ...execOptions, cwd: stage })
    } catch {
      // prepare 可能失败，继续尝试 build
    }
  }
  if (pkg.scripts?.build) {
    execSync('npm run build', { ...execOptions, cwd: stage })
  }
}

function readPackageJson(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
}

function writePackageJson(dir: string, pkg: Record<string, any>) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
}

/**
 * 安装生产依赖闭包，并将其标记为 bundleDependencies 写入 package.json。
 * 返回打入的依赖名列表。
 *
 * - 暂存目录里已有 node_modules（本地/GitHub 构建后）则先 prune 到仅生产依赖；
 *  npm 来源的已发布 tarball 尚无 node_modules，直接安装生产依赖。
 * - peerDependencies 不打入：DSH 宿主（如 cordis）会在 profile 中满足它们，
 *  打入反而会使插件持有独立实例导致与宿主类型不兼容。
 * - 安装前临时摘掉根包的 scripts，避免根包自身的 prepare 在缺少开发依赖的
 *  暂存目录里被 npm install 触发执行而失败。
 */
function bundleDeps(stage: string): string[] {
  const pkg = readPackageJson(stage)
  const hasProdDeps = Object.keys(pkg.dependencies ?? {}).length > 0
    || Object.keys(pkg.optionalDependencies ?? {}).length > 0
  if (!hasProdDeps) {
    pruneNodeModules(stage)
    return []
  }

  const nmDir = join(stage, 'node_modules')
  if (existsSync(nmDir)) {
    execSync('npm prune --omit=dev --no-audit --no-fund', { ...execOptions, cwd: stage })
  } else {
    // JSON.stringify 会丢弃值为 undefined 的键，此处临时隐藏 scripts
    writePackageJson(stage, { ...pkg, scripts: undefined })
    execSync('npm install --omit=dev --no-audit --no-fund', { ...execOptions, cwd: stage })
  }

  const peers = new Set(Object.keys(pkg.peerDependencies ?? {}))
  const regularDeps = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ])

  // 收集 node_modules 顶层生产依赖名（展开 scope 目录）
  const names: string[] = []
  for (const entry of readdirSync(nmDir)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      for (const sub of readdirSync(join(nmDir, entry))) {
        names.push(`${entry}/${sub}`)
      }
    } else {
      names.push(entry)
    }
  }

  const bundled: string[] = []
  for (const name of names) {
    // 同名的常规依赖优先于 peer 保留
    if (peers.has(name) && !regularDeps.has(name)) {
      rmSync(join(nmDir, ...name.split('/')), { recursive: true, force: true })
      continue
    }
    bundled.push(name)
  }

  // 基于原始 package.json 写回（npm 来源流程中安装时曾临时隐藏 scripts）
  writePackageJson(stage, { ...pkg, bundleDependencies: bundled })
  return bundled
}

/** 丢弃暂存目录中的 node_modules（includeDeps = false 时使用）。 */
function pruneNodeModules(stage: string): void {
  rmSync(join(stage, 'node_modules'), { recursive: true, force: true })
}

function packStage(stage: string, outDir: string, outputName: string | undefined): string {
  const result = String(execSync(
    `npm pack --ignore-scripts --pack-destination "${outDir}"`,
    { ...execOptions, cwd: stage },
  ))
  const filename = result.trim().split('\n').pop()?.trim() ?? ''
  if (!filename) {
    throw new Error('npm pack 失败')
  }

  const tarballPath = join(outDir, filename)

  if (outputName) {
    const finalName = outputName.endsWith('.tgz') ? outputName : outputName + '.tgz'
    const finalPath = join(outDir, finalName)
    renameSync(tarballPath, finalPath)
    return finalPath
  }

  return tarballPath
}

function normalizeSourceName(source: string): string {
  if (source.startsWith('github:') || source.includes('github.com')) {
    // 提取 repo 名
    const match = source.match(/(?:github\.com\/|github:)([\w.-]+)\/([\w.-]+)/)
    return match ? `${match[1]}/${match[2]}` : source
  }
  return source
}

function getHarnessVersion(): string {
  try {
    const result = String(execSync('dsh --version', { encoding: 'utf-8', timeout: 5000 }))
    return result.trim()
  } catch {
    return 'unknown'
  }
}

function cleanup(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // 忽略清理错误
  }
}
