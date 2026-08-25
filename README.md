# dsh-plugin-offline-packager

DeepSeek Harness 离线打包插件 — 在联网环境下将 DSH 插件打包为离线安装包（`.tgz`），传输到离线 DSH 环境中加载安装。

本项目可为 [dsh-admin](https://github.com/YJLTF/dsh-admin) 的插件市场和插件管理提供离线插件包：打包生成的自包含 `.tgz` 安装时无需访问 registry，可上传到 dsh-admin 的插件市场，通过其插件管理功能在离线环境中分发与安装 DSH 插件。

## 工作原理

本插件注册了一个名为 `offline-pack` 的 Tool，在 DSH Web UI 中通过 AI 对话调用。它支持三种来源：

- **npm 包名**（如 `@deepseek-ai/dsh-base`）— 直接 `npm pack` 下载打包
- **GitHub 仓库**（如 `github:user/repo`）— 克隆后构建再打包
- **本地路径**（如 `./my-plugin`）— 构建后打包

生成的 `.tgz` 文件可转移到离线机器，通过 DSH 自带的 `dsh plugin --profile web add` 命令安装。

## 安装本插件

### 前提条件

- 已安装 [DeepSeek Harness (DSH)](https://deepseek-harness.github.io/deepseek-harness/)
- Node.js >= 22
- pnpm 或 npm

### 步骤

```bash
# 1. 克隆或进入项目目录
cd dsh-plugin-offline-packager

# 2. 安装依赖
npm install

# 3. 构建 TypeScript
npm run build

# 4. 安装到 DSH profile（以 web profile 为例）
dsh plugin --profile web add .
```

安装完成后，重启 DSH 即可在 Web UI 中使用 `offline-pack` 工具。

### 验证安装

```bash
dsh --profile web --dump-config | grep offline-packager
```

如果看到 `offline-packager` 相关输出，说明安装成功。

## 使用本插件打包其他插件

### 方式一：通过 AI 对话（推荐）

在 DSH Web UI 中向 AI 发送消息，例如：

```
请将 @deepseek-ai/dsh-base 打包为离线安装包
```

AI 会自动调用 `offline-pack` 工具，输出类似：

```
离线包已生成: /path/to/offline-packages/deepseek-ai-dsh-base-0.1.1-rc.2.tgz

在离线环境的 DSH 中执行以下命令安装:
  dsh plugin --profile web add "deepseek-ai-dsh-base-0.1.1-rc.2.tgz"
```

### 方式二：直接调用工具

在对话中明确要求使用 `offline-pack` 工具：

```
Use the offline-pack tool to package @deepseek-ai/dsh-base
```

### 支持的来源示例

#### npm 包

```
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app
@deepseek-ai/dsh-headless
```

#### GitHub 仓库

```
github:Wanbinyu/dsh-billing
https://github.com/Wanbinyu/dsh-error-lens
```

#### 本地路径

```
./my-plugin
C:\Users\me\projects\my-dsh-plugin
```

### 自定义输出文件名

```
请将 @deepseek-ai/dsh-base 打包为离线安装包，输出文件名为 my-dsh-base.tgz
```

## 在离线环境安装打包好的插件

将生成的 `.tgz` 文件拷贝到离线机器，执行：

```bash
dsh plugin --profile web add ./deepseek-ai-dsh-base-0.1.1-rc.2.tgz
```

DSH 会解析 tarball 中的 `dsh.bundle` 声明，自动注册插件层并追加到 profile 的 `bundles` 列表。

> **Windows 注意**：`.tgz` 文件所在的完整路径（含各级目录）不能包含空格，否则 `dsh plugin --profile web add` 会报 `ENOENT`，详见下方[注意事项](#注意事项)。

### 验证安装

```bash
dsh --profile web --dump-config
```

确认 `dsh-base` 的配置层已正确加载。

## 配置项

本插件支持以下配置（在 `cordis.yml` 或 profile 的 patch 中设置）：

```yaml
- id: offline-packager
  name: dsh-plugin-offline-packager
  config:
    outputDir: ./offline-packages    # 离线包输出目录，默认 ./offline-packages
```

## 构建产物说明

每次打包会生成两个文件：

| 文件 | 说明 |
|------|------|
| `*.tgz` | 自包含的 npm tarball，可直接用于离线安装 |
| `*.meta.json` | 元数据文件（包名、打包时间、来源、DSH 版本、`bundledDependencies` 依赖清单等） |

离线包是**自包含**的，安装时无需访问 registry：

- 本插件自身通过 esbuild 将 `@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools` 等运行时依赖内联进单文件 `lib/index.js`，`.tgz` 不声明任何运行时依赖。
- 打包其他插件时，会在暂存目录中安装其完整生产依赖树，通过 `bundleDependencies` 让 `npm pack` 把 `node_modules` 一并携带进 tarball，离线机器上 pnpm 直接使用包内依赖。
- `peerDependencies` 不打入，由 DSH 宿主在 profile 中满足。

## 注意事项

- 打包过程需要联网（npm 下载 / GitHub 克隆）
- 从 GitHub 打包时，需要系统已安装 `git`
- 离线安装要求目标机器已有 DSH 基础框架（`@deepseek-ai/dsh`）
- 打包本地路径时，会自动尝试安装依赖和构建，但不保证所有项目都能成功
- **含原生二进制依赖的插件需在与目标离线机相同的平台（OS/arch）上打包**：离线包携带的是打包机上安装到的依赖版本，平台相关的 `optionalDependencies`（如原生模块）跨平台不可用
- **插件的 `peerDependencies` 不会打入离线包**：它们由 DSH 宿主在 profile 中提供（如 cordis），目标机器需已具备对应的 DSH 基础框架
- **Windows 下 `.tgz` 的存放路径不能包含空格**：`dsh plugin --profile web add` 在 Windows 上以 shell 模式把参数转发给 pnpm，且不会为参数补引号，路径会在空格处被截断。例如在 `D:\DSH Desktop\offline-packages` 下执行 `dsh plugin --profile web add ./xxx.tgz`，pnpm 实际会去 `<profile 目录>\Desktop\offline-packages\xxx.tgz` 找文件，报 `ENOENT: no such file or directory`。此问题与 tar 包格式无关，手动加引号也无效（引号在传参给 dsh 时已被 shell 消费）。解决办法是先把 `.tgz` 移到不含空格的目录再安装：

  ```powershell
  copy "D:\DSH Desktop\offline-packages\xxx.tgz" C:\temp\
  cd C:\temp
  dsh plugin --profile web add .\xxx.tgz
  ```