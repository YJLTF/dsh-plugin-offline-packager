# dsh-plugin-offline-packager

DeepSeek Harness（DSH）离线打包插件 — 在**联网环境**中把任意 DSH 插件打包成**自包含**的离线安装包（`.tgz`），拷贝到无网络的 DSH 环境后用一条命令直接安装，全程无需访问 npm registry。

它同时为 [dsh-admin](https://github.com/YJLTF/dsh-admin) 的插件市场提供离线包来源：打包生成的 `.tgz` 可上传到 dsh-admin 插件市场，借助其插件管理功能在离线环境中分发与安装 DSH 插件。

## 它解决什么问题

`dsh plugin add` 本质是把参数转发给离线 profile 目录里的 `pnpm add`。对普通插件执行这条命令时，pnpm 需要联网解析并下载插件的每一个 npm 依赖，离线环境必然失败。本插件把"依赖下载"这一步提前到联网机器上完成：在暂存目录装好插件的全部生产依赖，再通过 npm 的 `bundleDependencies` 机制把整个 `node_modules` 依赖闭包一起塞进 tarball。离线机器拿到的就是一个不缺文件的完整安装包。

## 特性

- **对话即打包**：注册一个名为 `offline-pack` 的 Tool，在 DSH Web UI 里用自然语言让 AI 调用即可，无需记命令。
- **三种插件来源**：npm 包名（`@deepseek-ai/dsh-base`）、GitHub 仓库（`github:user/repo`、`https://github.com/user/repo`，支持 `#branch` 指定分支）、本地路径（`./my-plugin`）。
- **自包含离线包**：完整生产依赖闭包随 tarball 携带（`bundleDependencies`），离线安装零 registry 访问。
- **peerDependencies 智能排除**：由 DSH 宿主（cordis）提供的 peer 依赖不打入离线包，也顺带清除构建阶段混入的 peer 传递依赖，避免与宿主的实例重复、类型不兼容。
- **自动构建**：GitHub / 本地来源会自动在暂存目录内安装依赖并执行 `prepare` / `build`，构建产物直接进包，不污染原目录。
- **离线元数据**：每次打包生成同名 `.meta.json`（包名、来源、打包时间、DSH 版本、打包器版本、捆绑依赖清单），便于离线环境审计与管理。
- **内建离线安装指引**：打包结果会附带针对 pnpm ≥ 11 供应链策略（`minimumReleaseAge`）的离线安装注意事项与解决命令，AI 可直接转述给用户。
- **自身零依赖**：本插件经 esbuild 打成单文件 `lib/index.js`，自身 `.tgz` 也不声明任何运行时依赖，同样可以离线安装。
- **兼容 dsh 0.1.6-alpha.2**：基于 `@deepseek-ai/dsh-tools@0.1.6-alpha.2`、`@deepseek-ai/cordis@^4.0.2` 构建与类型校验。

## 工作原理

1. 按来源把插件源码放入临时暂存目录：npm 来源直接 `npm pack` 下载解压；GitHub 来源浅克隆；本地来源复制（跳过 `node_modules` 与 `.git`）。
2. 需要构建的插件（GitHub / 本地来源、存在构建脚本而产物缺失）在暂存目录内 `npm install` 并执行 `prepare` / `build`。
3. 安装生产依赖（显式排除 peer），把实际装出的顶层依赖写入 `bundleDependencies`，使 `npm pack` 携带完整 `node_modules`。
4. `npm pack --ignore-scripts` 出包（构建早已完成，避免 prepare 重复执行），并写出 `.meta.json`。

## 安装本插件

### 前提条件

- 已安装 [DeepSeek Harness (DSH)](https://deepseek-harness.github.io/deepseek-harness/)（已在 0.1.5-alpha.1 / 0.1.5-alpha.2 / 0.1.6-alpha.2 上验证）
- Node.js >= 22，npm，以及系统里有 pnpm（`dsh plugin` 依赖它转发）
- 从 GitHub 来源打包时需要 `git`

### 步骤

```bash
# 1. 克隆或进入项目目录
cd dsh-plugin-offline-packager

# 2. 安装依赖并构建
npm install

# 3. 安装到 DSH profile（以 web profile 为例）
dsh plugin --profile web add .
```

> 若 pnpm 提示忽略了本包的构建脚本（`prepare` 负责构建，会重新生成 `lib/`），按提示允许即可：`pnpm approve-builds`，或在 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 映射中加入 `dsh-plugin-offline-packager`。

安装完成后重启 DSH，即可在 Web UI 中使用 `offline-pack` 工具。

### 验证安装

```bash
dsh --profile web --dump-config | grep offline-packager
```

看到 `offline-packager` 相关输出即安装成功。

## 使用本插件打包其他插件

### 通过 AI 对话（推荐）

在 DSH Web UI 中直接说：

```
请将 @deepseek-ai/dsh-base 打包为离线安装包
```

AI 会调用 `offline-pack` 工具，返回结果类似：

```
离线包已生成: F:\offline-packages\deepseek-ai-dsh-base-0.1.5-alpha.2.tgz

在离线环境的 DSH 中执行以下命令安装:
  dsh plugin --profile web add "F:\offline-packages\deepseek-ai-dsh-base-0.1.5-alpha.2.tgz"

离线安装注意（pnpm ≥ 11）: ……
```

### 工具参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `source` | string，必填 | 插件来源，见下方示例 |
| `output` | string，可选 | 输出文件名（默认 `包名-版本.tgz` 自动生成） |
| `includeDeps` | boolean，可选 | 是否打入 npm 依赖，默认 `true`；`false` 时仅打包插件本身 |

### 来源示例

```
@deepseek-ai/dsh-base              # npm 包
@deepseek-ai/dsh-web-app           # npm scope 包
github:Wanbinyu/dsh-billing        # GitHub（默认分支）
https://github.com/Wanbinyu/dsh-error-lens#main   # GitHub（指定分支）
./my-plugin                        # 本地相对路径
C:\Users\me\projects\my-dsh-plugin # 本地绝对路径
```

### 输出文件

每次打包在输出目录（默认 `./offline-packages`，见[配置](#配置)）生成两个文件：

| 文件 | 说明 |
|------|------|
| `*.tgz` | 自包含离线安装包，可直接用于离线安装 |
| `*.meta.json` | 元数据：包名、来源、打包时间、DSH 版本、打包器版本、捆绑依赖清单 |

## 把离线包装到目标机器

将 `.tgz`（可选拷新式 `.meta.json`）拷贝到离线机器后执行：

```bash
dsh plugin --profile web add ./deepseek-ai-dsh-base-0.1.5-alpha.2.tgz
```

DSH 会解析 tarball 内 `package.json` 的 `dsh.bundle` 声明（本包自带 `cordis.patch.yml` 补丁），自动注册插件层并追加到 profile 的 `bundles` 列表。

### pnpm ≥ 11 离线安装必读

`dsh plugin add` 会把参数转发成 profile 目录里的 `pnpm add`。pnpm 11 起 `minimumReleaseAge` 供应链策略默认开启（1440 分钟），`pnpm add` 不只解析新包，还会为 profile 中**已装好的整个依赖树**联网拉取发布时间元数据，离线环境因此报错：

```
ERR_PNPM_RESOLVING_NPM_RESOLVER_NETWORK_ERROR: Failed to fetch metadata from
https://registry.npmjs.org/...: error sending request for url ...
```

注意：报错的包名是**宿主框架依赖树里的传递依赖**，每次失败点可能不同，与离线包本身是否自包含无关。

**解决**：编辑 profile 目录下的 `pnpm-workspace.yaml`（如 `C:\Users\<user>\.dsh\profiles\web\pnpm-workspace.yaml`，dsh 首次初始化时生成、之后不会覆盖）：

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
minimumReleaseAge: 0            # 关键：关闭 24h 供应链延迟，离线 add 不再需要元数据
dangerouslyAllowAllBuilds: true # 若改后报 ERR_PNPM_IGNORED_BUILDS 则加上；
                                # 更细粒度可改用 allowBuilds 映射，按 pnpm 报错提示填包名
```

保存后重新执行安装即可（之前失败残留的 `package.json` 条目无需手动清理，重跑 add 会自愈）。也可不改文件，在安装命令末尾追加参数——`dsh` 会把多余参数原样透传给 pnpm：

```bash
dsh plugin --profile web add ./xxx.tgz --config.minimum-release-age=0
```

> `--prefer-offline` / `--offline` 对 `minimumReleaseAge` 的元数据校验无效，不要浪费时间尝试。

### Windows：路径不能含空格

`.tgz` 所在完整路径（含各级目录）不能包含空格：`dsh plugin add` 在 Windows 上以 shell 模式转发参数且不补引号，路径会在空格处被截断，报 `ENOENT`。手动加引号也无效（引号在传参给 dsh 时已被 shell 消费）。先把文件移到不含空格的目录再安装：

```powershell
copy "D:\DSH Desktop\offline-packages\xxx.tgz" C:\temp\
cd C:\temp
dsh plugin --profile web add .\xxx.tgz
```

### 验证安装

```bash
dsh --profile web --dump-config
```

确认目标插件的配置层已正确加载。

## 配置

本插件支持以下配置（在 `cordis.yml` 或 profile 的 patch 中设置）：

```yaml
- id: offline-packager
  name: dsh-plugin-offline-packager
  config:
    outputDir: ./offline-packages    # 离线包输出目录，默认 ./offline-packages
```

## 注意事项

- **打包过程需要联网**（npm 下载 / GitHub 克隆），离线的是安装端
- **含原生二进制依赖的插件需在与目标离线机相同的平台（OS/arch）上打包**：离线包携带的是打包机装到的依赖版本，平台相关的 `optionalDependencies`（原生模块）跨平台不可用
- **插件的 `peerDependencies` 不打入离线包**：由 DSH 宿主在 profile 中提供，目标机器需已具备对应的 DSH 基础框架
- **本地路径打包不保证所有项目成功**：会自动尝试安装依赖与构建，构建失败会把 npm 的报错原样抛出
- **pnpm ≥ 11 目标机需先按上文关闭 `minimumReleaseAge`** 再离线安装，详见[离线安装必读](#pnpm--11-离线安装必读)
- **Windows 下 `.tgz` 存放路径不能包含空格**，详见[上文解法](#windows路径不能含空格)

## 开发

```bash
npm run build   # esbuild 单文件打包 + tsc 类型声明
npm run smoke   # 冒烟测试：本地来源（构建/捆绑/peer 排除）、includeDeps=false、npm 来源、自定义文件名
```
