// 将插件及其全部运行时依赖打包为单文件产物，使发布出的 .tgz 零依赖、
// 可在离线环境直接安装（npm pack 不会携带 node_modules）。
import { rmSync } from 'node:fs'
import { build } from 'esbuild'

rmSync('lib', { recursive: true, force: true })

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'lib/index.js',
})
