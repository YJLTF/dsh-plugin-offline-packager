import { execSync, type ExecSyncOptions } from 'child_process'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { resolve, join, basename } from 'path'
import { randomUUID } from 'crypto'

const execOptions: ExecSyncOptions = {
  encoding: 'utf-8',
  stdio: 'pipe',
  timeout: 120_000,
}

/**
 * 将指定的 DSH 插件打包为离线安装包（.tgz）。
 *
 * @param source   - npm 包名、GitHub URL 或本地路径
 * @param outputDir - 输出目录
 * @param outputName - 可选输出文件名
 * @param includeDeps - 是否包含依赖（仅本地路径有效）
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
    // 判断来源类型并执行打包
    const tarballPath = await doPack(source, tmpDir, outDir, outputName, includeDeps)

    // 生成离线元数据文件
    const meta: OfflineMetadata = {
      packageName: normalizeSourceName(source),
      packagedAt: new Date().toISOString(),
      originalSource: source,
      harnessVersion: getHarnessVersion(),
      packagerVersion: '0.1.0',
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
}

async function doPack(
  source: string,
  tmpDir: string,
  outDir: string,
  outputName: string | undefined,
  includeDeps: boolean,
): Promise<string> {
  // 判断 source 类型
  const sourceType = detectSourceType(source)

  switch (sourceType) {
    case 'npm': {
      return packFromNpm(source, tmpDir, outDir, outputName)
    }
    case 'github': {
      return packFromGitHub(source, tmpDir, outDir, outputName)
    }
    case 'local': {
      return packFromLocal(source, tmpDir, outDir, outputName, includeDeps)
    }
    default: {
      throw new Error(`无法识别的插件来源: ${source}`)
    }
  }
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
 * 从 npm 打包插件。
 * 使用 `npm pack` 下载并打包。
 */
function packFromNpm(
  packageName: string,
  _tmpDir: string,
  outDir: string,
  outputName: string | undefined,
): string {
  const result = String(execSync(
    `npm pack ${packageName} --pack-destination "${outDir}"`,
    execOptions,
  ))
  const filename = result.trim().split('\n').pop()?.trim() ?? ''
  if (!filename) {
    throw new Error(`npm pack 失败: 未获取到文件名，输出: ${result}`)
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

/**
 * 从 GitHub 克隆并打包插件。
 * 克隆仓库后检测构建脚本，构建后再打包。
 */
function packFromGitHub(
  source: string,
  tmpDir: string,
  outDir: string,
  outputName: string | undefined,
): string {
  // 规范化 GitHub URL
  const repoUrl = source.startsWith('github:')
    ? `https://github.com/${source.slice(7)}`
    : source

  const repoDir = join(tmpDir, 'repo')
  execSync(`git clone --depth 1 ${repoUrl} "${repoDir}"`, execOptions)

  // 检查 package.json 是否存在
  const pkgPath = join(repoDir, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new Error(`GitHub 仓库 ${repoUrl} 中未找到 package.json`)
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

  // 尝试构建
  if (pkg.scripts?.prepare) {
    try {
      execSync('npm run prepare', { ...execOptions, cwd: repoDir })
    } catch {
      // prepare 可能失败，继续尝试 build
    }
  }
  if (pkg.scripts?.build) {
    execSync('npm run build', { ...execOptions, cwd: repoDir })
  }

  const result = String(execSync(
    `npm pack --pack-destination "${outDir}"`,
    { ...execOptions, cwd: repoDir },
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

/**
 * 从本地路径打包插件。
 * 可选的依赖打包：将 node_modules 一起打包。
 */
function packFromLocal(
  localPath: string,
  tmpDir: string,
  outDir: string,
  outputName: string | undefined,
  includeDeps: boolean,
): string {
  const absPath = resolve(localPath)

  if (!existsSync(join(absPath, 'package.json'))) {
    throw new Error(`本地路径 ${absPath} 中未找到 package.json`)
  }

  // 如果 includeDeps 且存在 node_modules，先安装依赖
  if (includeDeps && !existsSync(join(absPath, 'node_modules'))) {
    try {
      execSync('npm install --production', { ...execOptions, cwd: absPath })
    } catch {
      // 安装失败不阻塞，继续打包
    }
  }

  // 如果存在 tsconfig.json 且未构建，尝试构建
  if (existsSync(join(absPath, 'tsconfig.json')) && !existsSync(join(absPath, 'lib'))) {
    try {
      execSync('npm run build', { ...execOptions, cwd: absPath })
    } catch {
      // 构建失败不阻塞
    }
  }

  const result = String(execSync(
    `npm pack --pack-destination "${outDir}"`,
    { ...execOptions, cwd: absPath },
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