// 冒烟测试：对打包器的公共入口（lib/index.js 导出的 apply → offline-pack 工具）
// 做端到端验证，覆盖本地来源（构建 + 依赖捆绑 + peer 排除）、includeDeps=false、
// npm 来源与自定义输出文件名四条路径。
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

let failures = 0
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok - ${name}`)
  } else {
    failures++
    console.error(`  FAIL - ${name}${detail ? `: ${detail}` : ''}`)
  }
}

function tarballList(tgz) {
  // 与 pack.ts 同理：Windows 下 GNU tar 会把 "C:\..." 的冒号解析为远程主机，须用相对路径
  const dir = dirname(tgz)
  const name = tgz.slice(dir.length + 1)
  return execSync(`tar -tzf "${name}"`, { encoding: 'utf-8', cwd: dir }).split('\n')
}

// ---- 工作目录与本地 fixture 插件：依赖 ms、peer @deepseek-ai/cordis、prepare 构建标记 ----
const work = mkdtempSync(join(tmpdir(), 'offline-packager-smoke-'))
const fixture = join(work, 'fixture-plugin')
mkdirSync(fixture, { recursive: true })
writeFileSync(join(fixture, 'package.json'), JSON.stringify({
  name: '@smoke/fixture-plugin',
  version: '1.2.3',
  description: 'smoke fixture',
  scripts: { prepare: 'node -e "require(\'fs\').writeFileSync(\'built.txt\',\'ok\')"' },
  dependencies: { ms: '^2.1.3' },
  peerDependencies: { '@deepseek-ai/cordis': '>=4' },
}, null, 2))
writeFileSync(join(fixture, 'index.js'), 'export const x = 1\n')
writeFileSync(join(fixture, 'tsconfig.json'), '{}\n')

// 从 lib/index.js 的 apply() 中捕获注册的工具定义
const { apply } = await import('../lib/index.js')
let tool
apply({ tools: { register(def) { tool = def } } }, { outputDir: join(work, 'offline-packages') })
check('apply 注册了 offline-pack 工具', tool?.name === 'offline-pack')

function firstPath(message) {
  return resolve(message.split('\n')[0].replace('离线包已生成: ', '').trim().replace(/^"|"$/g, ''))
}

try {
  console.log('case A: 本地来源，includeDeps 默认 true')
  const messageA = await tool.execute({ source: fixture })
  const tgzA = firstPath(messageA)
  {
    check('工具返回了生成消息', messageA.includes('离线包已生成') && messageA.includes('dsh plugin --profile web add'))
    check('tgz 位于配置的输出目录', dirname(tgzA) === join(work, 'offline-packages'), tgzA)
    check('tgz 已生成', existsSync(tgzA), tgzA)

    const meta = JSON.parse(readFileSync(tgzA.replace(/\.tgz$/, '.meta.json'), 'utf8'))
    check('meta.json 版本号来自 package.json（非硬编码）', meta.packagerVersion === version, `${meta.packagerVersion} != ${version}`)
    check('meta.json 记录原始来源', meta.originalSource === fixture)
    check('meta.json 记录了捆绑依赖', Array.isArray(meta.bundledDependencies) && meta.bundledDependencies.includes('ms'), JSON.stringify(meta.bundledDependencies))

    const files = tarballList(tgzA)
    check('tarball 携带依赖 ms', files.some(f => f.includes('node_modules/ms/')))
    check('tarball 不携带 peer 依赖 cordis', !files.some(f => f.includes('node_modules/@deepseek-ai/')))
    check('prepare 脚本产物进入了 tarball', files.some(f => f.endsWith('package/built.txt')))
    const packedPkg = JSON.parse(execSync(`tar -xzOf "${tgzA.slice(dirname(tgzA).length + 1)}" package/package.json`, { encoding: 'utf8', cwd: dirname(tgzA) }))
    check('打包内 package.json 声明 bundleDependencies', JSON.stringify(packedPkg.bundleDependencies) === JSON.stringify(['ms']))
    check('临时暂存目录已被清理', readdirSync(join(work, 'offline-packages')).every(f => !f.startsWith('.tmp-')))
  }

  console.log('case B: includeDeps = false')
  {
    const tgzB = firstPath(await tool.execute({ source: fixture, includeDeps: false }))
    const files = tarballList(tgzB)
    check('tarball 不携带任何 node_modules', !files.some(f => f.includes('node_modules/')))
  }

  console.log('case C: npm 来源（真实 registry 下载）')
  {
    const tgzC = firstPath(await tool.execute({ source: 'ms' }))
    check('npm 来源 tgz 已生成', existsSync(tgzC), tgzC)
    const meta = JSON.parse(readFileSync(tgzC.replace(/\.tgz$/, '.meta.json'), 'utf8'))
    check('meta.json 记录 npm 来源', meta.originalSource === 'ms')
    const files = tarballList(tgzC)
    check('ms 无生产依赖，tarball 无 node_modules', !files.some(f => f.includes('node_modules/')))
  }

  console.log('case D: 自定义输出文件名')
  {
    const tgzD = firstPath(await tool.execute({ source: 'ms', output: 'my-ms' }))
    check('输出重命名为 my-ms.tgz', tgzD.endsWith('my-ms.tgz') && existsSync(tgzD), tgzD)
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures) {
  console.error(`\n${failures} 个断言失败`)
  process.exit(1)
}
console.log('\n全部断言通过')
