import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { packPlugin } from './pack.js'

export const name = 'offline-packager'
export const inject = ['tools']

export interface Config {
  outputDir: string
}

export const Config: Schema<Config> = Schema.object({
  outputDir: Schema.string().default('./offline-packages'),
})

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'offline-pack',
    description: '将指定的 DeepSeek Harness 插件打包为离线安装包（.tgz），可在无网络的 DSH 环境中通过 `dsh plugin add <file>.tgz` 安装',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: '插件来源：npm 包名（如 @deepseek-ai/dsh-base）、GitHub URL（如 github:user/repo）或本地路径',
      },
      output: {
        type: 'string',
        description: '输出文件名（可选，默认自动生成）',
      },
      includeDeps: {
        type: 'boolean',
        description: '是否包含 npm 依赖（默认 true，仅对本地路径有效）',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args: Record<string, any>) {
      const result = await packPlugin(
        String(args.source),
        config.outputDir,
        args.output ? String(args.output) : undefined,
        args.includeDeps !== false,
      )
      return `离线包已生成: ${result}\n\n在离线环境的 DSH 中执行以下命令安装:\n  dsh plugin add "${result}"`
    },
  }))
}