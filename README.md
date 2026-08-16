# dsh-hindsight-plugins

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-生态插件-4D6BFE?logo=deepseek&logoColor=white)
![GitHub Stars](https://img.shields.io/github/stars/With-With/dsh-hindsight-plugins?logo=github)
![License](https://img.shields.io/github/license/With-With/dsh-hindsight-plugins)
![Version](https://img.shields.io/badge/version-0.3.1-blue)
![类型](https://img.shields.io/badge/类型-客户端%2B服务端插件-blueviolet)
![平台](https://img.shields.io/badge/平台-Web%20GUI-lightgrey)

DSH（DeepSeek Harness）的 **Hindsight 外部记忆管家**：设置页图形界面 + 官方适配器自动检测与自动安装 + 主动同步开关，装完即用，全程无需命令行。

> 🧠 底层使用官方 [Hindsight](https://hindsight.vectorize.io) 记忆系统
> （[Coding Agents 集成](https://hindsight.vectorize.io/sdks/integrations/coding-agents)）。
> 本插件是它的**包装与管家**，不修改官方运行时。

---

<!-- TOC -->
- [⚡ 一键安装（复制即用）](#-一键安装复制即用)
- [✨ 功能特性](#-功能特性)
- [📦 安装本插件](#-安装本插件)
- [🚀 使用方法](#-使用方法)
- [🔧 工作原理](#-工作原理)
- [📡 HTTP 接口](#-http-接口)
- [⚙️ 配置](#️-配置)
- [🔒 安全说明](#-安全说明)
- [🔄 已知限制](#-已知限制)
- [🛠️ 开发与维护](#️-开发与维护)
- [📝 更新日志](#-更新日志)
- [📄 许可](#-许可)
<!-- /TOC -->

## ⚡ 一键安装（复制即用）

**喂给 AI 的一句话**（AI 具备命令执行能力即可，无需解释）：

> 安装 DSH 插件 dsh-hindsight-plugins（Hindsight 外部记忆管家）：克隆 https://github.com/With-With/dsh-hindsight-plugins 到 ~/.dsh/profiles/web/node_modules/dsh-hindsight-plugins，在 ~/.dsh/cordis.patch.yml 追加 `- insert:` 条目（id: hindsight-plugins，name: dsh-hindsight-plugins，config.autoInstall: true），然后重启 dsh web 并刷新页面。

**或者直接复制命令执行：**

| 平台 | 命令 |
|---|---|
| Windows (PowerShell) | `git clone https://github.com/With-With/dsh-hindsight-plugins.git "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-hindsight-plugins"` |
| macOS / Linux | `git clone https://github.com/With-With/dsh-hindsight-plugins.git ~/.dsh/profiles/web/node_modules/dsh-hindsight-plugins` |

> 克隆后还需注册 patch 条目（见下文 📦 安装本插件）并重启 DSH。也可以在 [DSH插件市场](https://github.com/bradeGithub/DSH-Plugins-Marketplace) 中一键安装（自动完成克隆 + 注册）。

---

## ✨ 功能特性

- **自动检测与自动安装**：插件启动时检查官方 DSH 适配器（`npx @vectorize-io/hindsight-coding-agents install dsh`）是否已安装挂载；缺失时自动非交互执行官方安装器（地址依次取自：现有 `coding-agent.json` -> 本插件 sidecar 的内网地址 -> 插件配置 `defaultApiUrl`）。也可在界面点「一键安装官方适配器」，安装日志实时滚动
- **重复注册检测与一键收敛**：精确审计所有补丁层的 `id: hindsight` 注册数（0 = 缺失 / 1 = 健康 / ≥2 = 重复）。重复会导致 `dsh web` 启动失败（duplicate loader entry id）--此时界面显示琥珀色警告与「一键收敛」按钮：保留 profile bundle 注册、移除官方安装器写入的 home 补丁行（改动前自动备份）。收敛只在用户点击或安装完成后执行，绝不明动
- **设置页 GUI**：设置 -> 插件 -> 「外部记忆」标签页
  - 状态卡：当前路由 + 写入范围（首行）、当前内/外网地址、Hindsight 服务端版本号（`GET /version` 官方同款端点）、Coding Agents 版本号、安装状态（绿/红）
  - 「管理」弹窗：编辑内网地址 / 外网地址 / 当前路由（内网|外网），逐地址「测试」连通性，保存设置
- **双路由管理**：内网/外网两套地址 + 一键切换；写入固定走 `harnesses.dsh.apiUrl` 分节（仅 DSH 生效），不影响 Codex 等其他客户端
- **主动同步开关（默认关闭）**：区分两种同步方式
  - **不主动同步（默认）**：不自动写入会话记录；对话中明确要求记住的内容（"把这个存进记忆"）依然正常入库--被动同步不受影响
  - **主动同步（开关开启）**：AI 每轮答完后自动写入 Hindsight（官方 `retainSessions` 机制，服务端折叠去重，不浪费提取）
  - 映射官方 `harnesses.dsh.retainSessions`（显式 true/false），对新会话生效；插件首次启动会把缺失的键迁移为显式 `false`
- **安全写入**：原子写 + 改动前自动备份 `coding-agent.json`（`*.hindsight-settings-backup`），保留全部未知字段
- **未安装警示**：适配器缺失时红色横幅 + 一键安装按钮 + 安装命令 + [官方文档](https://hindsight.vectorize.io/sdks/integrations/coding-agents)链接 + 「?」帮助
- **零构建零依赖**：宿主半边仅用 Node 内建模块（≥ 20），npm / 市场克隆 / 目录复制任何方式均可运行

---

## 📦 安装本插件

### 方式一：DSH 插件市场（推荐）

在 [DSH插件市场](https://github.com/bradeGithub/DSH-Plugins-Marketplace) 中搜索「hindsight」一键安装（本仓库带 `dsh-plugin` topic，市场索引自动收录）。

### 方式二：命令安装

```bash
dsh plugin --profile web add git+https://github.com/With-With/dsh-hindsight-plugins.git
```

### 方式三：手动挂载

本插件位于 `~/.dsh/profiles/web/node_modules/dsh-hindsight-plugins/`（零运行时依赖，克隆/复制/目录联接均可），并在用户 patch 层（`~/.dsh/cordis.patch.yml`）注册：

```yaml
- insert:
    - id: hindsight-plugins
      name: dsh-hindsight-plugins
      config:
        autoInstall: true          # 启动时检测并自动安装官方适配器（默认开启）
        # defaultApiUrl: 'http://192.168.1.100:18888'   # 地址兜底（示例）
```

> ⚠️ **重启生效**：首次安装后需重启 DSH（重新运行 `dsh web`）再刷新页面；宿主半边的后续代码更新同样需要重启（浏览器半边刷新即生效）。

前置条件：一台可达的 [Hindsight 服务器](https://hindsight.vectorize.io)（自建或云端）；无需任何 API Key。

---

## 🚀 使用方法

1. 重启 DSH 后打开 Web GUI，进入 **设置 -> 插件 -> 外部记忆**
2. 首次使用：
   - 适配器已安装 -> 状态卡直接显示绿色「已安装」
   - 适配器缺失 -> 红色横幅，点「一键安装官方适配器」（或等启动 3 秒后的自动安装）
3. 点「管理」：填写内网地址（如 `http://192.168.1.100:18888`）->「测试」连通 -> 选择当前路由 ->「保存设置」
4. 按需使用「主动同步」开关：开启 = 每轮自动入库；关闭 = 不主动同步，仅按需入库
5. 所有配置对新会话生效（官方适配器在会话启动时读取）

---

## 🔧 工作原理

```
设置 -> 插件 -> 「外部记忆」（浏览器半边，settings.plugins.tab slot）
        │  fetch /plugins/dsh-hindsight-plugins/{config,test,install,retain}
        ▼
宿主半边（node，webServer 路由，仅接受 loopback）
        ▼
~/.hindsight/dsh-route.json       ← 双地址与当前路由（本插件 sidecar）
~/.hindsight/coding-agent.json    ← 解析后的地址（harnesses.dsh.apiUrl 分节）+ retainSessions
        ▼
官方 dsh.js 适配器（零改动）在会话启动时读取 -> 对新会话生效
        ▼
Hindsight 服务器（自建 NAS / 云端）：会话写回 + 事实提取 + 知识页
```

主动同步的写回时机（官方机制）：DSH 无「会话结束」概念，等价物是 **idle 写回**--AI 每答完一轮即写入一次；服务端把同一会话的多次写回**折叠成一次提取**，频繁写回不浪费资源。

---

## 📡 HTTP 接口

| 接口 | 方法 | 说明 |
|---|---|---|
| `/plugins/dsh-hindsight-plugins/config` | GET | 读取路由、生效配置、适配器状态、安装进度、同步开关、服务端版本 |
| `/plugins/dsh-hindsight-plugins/config` | POST | 保存地址/路由（原子写 + 自动备份） |
| `/plugins/dsh-hindsight-plugins/test` | POST | 地址连通性探测（状态码 + 延迟） |
| `/plugins/dsh-hindsight-plugins/install` | POST | 一键安装官方适配器（启动时也会自动检测） |
| `/plugins/dsh-hindsight-plugins/retain` | POST | 主动同步开关（写 `harnesses.dsh.retainSessions`，对新会话生效） |
| `/plugins/dsh-hindsight-plugins/dedupe` | POST | 一键收敛重复注册（保留 bundle 注册、移除 home 行，自动备份） |

## ⚙️ 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `autoInstall` | `true` | 启动时检测官方适配器，缺失则自动安装 |
| `defaultApiUrl` | `''` | 自动安装时的地址兜底（现有配置与 sidecar 均无地址时使用） |

## 🔒 安全说明

- 路由仅接受 loopback Host 请求（与 DSH GUI 自身同一姿态），请勿将 DSH web 端口暴露到不可信网络
- 自动安装固定 `--server self-hosted` 非交互模式，绝不把记忆发往云端；5 分钟超时自动终止
- 安装日志完整记录并显示在界面横幅中
- 改动 `coding-agent.json` 前自动备份，保留全部未知字段

## 🔄 已知限制

- 宿主半边（路由/安装逻辑）改动需重启 `dsh web` 生效；浏览器半边（UI）刷新即生效
- 配置与同步开关均对新会话生效（官方适配器会话启动时读取）
- 服务端版本号由宿主中转获取（Hindsight 服务器无 CORS 头，浏览器直连不可行）；宿主未重启加载新版前显示「未知」
- 关闭主动同步只停止自动写回；手动入库文档、记忆检索、深度推理均不受影响
- 需要一台可达的 Hindsight 服务器（本插件不带服务器）

## 🛠️ 开发与维护

```bash
node --check lib/index.js && node --check lib/client.js   # 语法
npm pack                                                   # 打包 tgz
```

- 修改服务端逻辑：编辑 `lib/index.js`；修改页面 UI：编辑 `lib/client.js`（web2 模块格式，`window.__ModuleLoader__.load`）
- 浏览器半边即改即生效（刷新页面）；宿主半边更新需重启 `dsh web`

## 📝 更新日志

| 版本 | 变更 |
|---|---|
| v0.1.0 | 首个版本：设置页 GUI + 官方适配器自动检测/自动安装/一键安装 |
| v0.1.1 ~ v0.1.3 | 写入范围默认并固定为仅 DSH；管理弹窗精简；状态卡重排（版本/状态行、字体统一） |
| v0.2.0 ~ v0.2.2 | 服务端版本探测（GET /version）；发布前隐私清理 |
| v0.3.0 | 会话同步开关（POST /retain，映射官方 retainSessions） |
| v0.3.1 | 开关语义明确为「主动同步」：关闭 = 不主动同步，被动按需入库不受影响；README 按插件市场风格重写 |
| v0.3.2 | 防御官方安装器的裸 `[]` 补丁占位 bug（触发前清除、安装后修复） |
| v0.4.0 | **注册审计重写**：adapterStatus 从字符串匹配升级为逐层精确计数 `id: hindsight`（0/1/≥2 三态）；重复注册时琥珀色警告 +「一键收敛」（POST /dedupe，保留 bundle 注册、剥离 home 标记块，自动备份）；手动安装完成后自动收敛一次；绝不明动清理 |
| v0.4.1 | **主动同步默认改为关闭**：开关两态均显式写 `retainSessions: true/false`；插件启动时把缺失键迁移为显式 `false`（备份先行）；仅显式 `true` 视为开启 |
| v0.4.2 | **界面精简**：「管理」按钮移至标题行右上角；「?」圆标改为「说明」按钮与其并排；移除同步开关切换提示语与底部操作提示语（开关状态本身即反馈） |
| v0.4.3 | 「说明」弹窗增加本项目 GitHub 地址链接 |

## 📄 许可

MIT
