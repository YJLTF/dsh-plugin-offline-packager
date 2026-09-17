import { execSync, type ExecSyncOptions } from 'child_process'
import { createRequire } from 'module'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { resolve, join, basename } from 'path'
import { randomUUID } from 'crypto'

const require = createRequire(import.meta.url)

const execOptions: ExecSyncOptions = {
  encoding: 'utf-8',
  stdio: 'pipe',
  // 重依赖插件（如渲染类插件带 vite / puppeteer）的安装可能远超 5 分钟
  timeout: 900_000,
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
    prepareStage(source, stage, tmpDir)

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
      packagerVersion: getPackagerVersion(),
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

/** 执行 npm pack 并从输出中解析出生成的 .tgz 文件名。 */
function packTgz(args: string, packDestination: string, cwd?: string): string {
  const result = String(execSync(`npm pack ${args} --pack-destination "${packDestination}"`, {
    ...execOptions,
    cwd,
  }))
  const filename = result.trim().split('\n').pop()?.trim() ?? ''
  if (!filename || !filename.endsWith('.tgz')) {
    throw new Error(`npm pack 失败: 未获取到文件名，输出: ${result}`)
  }
  return filename
}

/**
 * 将插件源码放入暂存目录：
 * - npm：npm pack 下载已发布 tarball 后解压
 * - GitHub：克隆（支持 #branch 指定分支）后安装依赖并构建
 * - 本地：复制源码（排除 node_modules / .git）后按需构建
 */
function prepareStage(source: string, stage: string, tmpDir: string) {
  switch (detectSourceType(source)) {
    case 'npm': {
      // 使用相对路径调用 tar：Windows 上 GNU tar 会把 "F:\..." 的冒号
      // 解析为远程主机，bsdtar 则兼容两者，相对路径对两种实现都安全
      const filename = packTgz(`"${source}"`, tmpDir)
      execSync(`tar -xzf "${filename}" -C stage --strip-components=1`, {
        ...execOptions,
        cwd: tmpDir,
      })
      return
    }
    case 'github': {
      const repoSpec = source.startsWith('github:')
        ? source.slice(7)
        : source.replace(/^https?:\/\/github\.com\//, '')
      // npm 风格的 #branch / #tag 后缀转换为 clone 分支参数
      const hashIndex = repoSpec.indexOf('#')
      const branch = hashIndex >= 0 ? repoSpec.slice(hashIndex + 1) : undefined
      const repoUrl = `https://github.com/${hashIndex >= 0 ? repoSpec.slice(0, hashIndex) : repoSpec}`
      execSync(
        `git clone --depth 1 ${branch ? `--branch "${branch}" ` : ''}"${repoUrl}" "${stage}"`,
        execOptions,
      )
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
          // 按路径段匹配，任意深度的 node_modules / .git 都排除——
          // monorepo 插件（pnpm workspace）的子包里有自己的 node_modules，
          // 其中往往包含指向工作区的符号链接，复制会失败或污染产物
          const rel = src.slice(absPath.length).replace(/^[\\/]/, '')
          const segments = rel.split(/[\\/]/)
          return !segments.includes('node_modules') && !segments.includes('.git')
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
  // npm install 生命周期会自动执行根包的 prepare，无需再显式跑一遍
  execSync('npm install --no-audit --no-fund', { ...execOptions, cwd: stage })
  const pkg = readPackageJson(stage)
  // prepare 未涵盖构建（或项目只有 build 脚本）时补一次构建
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
 * - 安装以 --legacy-peer-deps 进行，peerDependencies 不进入依赖树、
 *  不打入离线包：DSH 宿主（如 cordis）会在 profile 中满足它们，
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
    // 临时摘除 peerDependencies：构建阶段的 npm install 会自动安装 peer，
    // 摘除后 prune 会把 peer 及其传递依赖视为多余包一并清除，避免孤儿依赖混入离线包
    writePackageJson(stage, { ...pkg, peerDependencies: undefined })
    execSync('npm prune --omit=dev --no-audit --no-fund', { ...execOptions, cwd: stage })
  } else {
    // JSON.stringify 会丢弃值为 undefined 的键，此处临时隐藏 scripts
    writePackageJson(stage, { ...pkg, scripts: undefined })
    execSync('npm install --omit=dev --legacy-peer-deps --no-audit --no-fund', { ...execOptions, cwd: stage })
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
  const filename = packTgz('--ignore-scripts', outDir, stage)
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
    // 提取 repo 名（去掉 .git 后缀）
    const match = source.match(/(?:github\.com\/|github:)([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:#.*)?$/)
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

/** 从本包的 package.json 读取版本号，避免与 package.json 重复维护。 */
function getPackagerVersion(): string {
  try {
    return require('../package.json').version as string
  } catch {
    return 'unknown'
  }
}

function cleanup(dir: string) {
  // Windows 上杀毒软件等可能短暂锁定目录，重试几次再放弃
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      if (attempt === 2) {
        process.stderr.write(`offline-packager: 清理暂存目录失败，请手动删除 ${dir}\n`)
      } else {
        sleepSync(250)
      }
    }
  }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
