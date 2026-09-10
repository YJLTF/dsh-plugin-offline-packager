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
    description: '将指定的 DeepSeek Harness 插件打包为离线安装包（.tgz），可在无网络的 DSH 环境中通过 `dsh plugin --profile web add <file>.tgz` 安装',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: '插件来源：npm 包名（如 @deepseek-ai/dsh-base）、GitHub URL（如 github:user/repo，可用 #branch 指定分支）或本地路径',
      },
      output: {
        type: 'string',
        description: '输出文件名（可选，默认自动生成）',
      },
      includeDeps: {
        type: 'boolean',
        description: '是否将插件的 npm 依赖一并打入离线包（默认 true；peerDependencies 由 DSH 宿主提供，不打入）',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const result = await packPlugin(
        args.source,
        config.outputDir,
        args.output,
        args.includeDeps !== false,
      )
      return `离线包已生成: ${result}

在离线环境的 DSH 中执行以下命令安装:
  dsh plugin --profile web add "${result}"

离线安装注意（pnpm ≥ 11）:
pnpm 11 起 minimumReleaseAge 供应链策略默认开启（1440 分钟），pnpm add 会为 profile 中已装的依赖树联网拉取发布时间元数据，离线环境因此报 "Failed to fetch metadata from .../ error sending request for url"。报错的包名是 DSH 宿主框架的传递依赖（每次可能不同），与本离线包是否自包含无关。解决：在 profile 目录（如 ~/.dsh/profiles/web）的 pnpm-workspace.yaml 中加入:
  minimumReleaseAge: 0
若改后报 ERR_PNPM_IGNORED_BUILDS，按 pnpm 报错提示在 pnpm-workspace.yaml 的 allowBuilds 映射中加入对应包名，或加入:
  dangerouslyAllowAllBuilds: true
也可不改文件，在安装命令末尾追加 --config.minimum-release-age=0（dsh 会原样透传给 pnpm）`
    },
  }))
}
