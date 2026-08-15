# dsh-hindsight-plugins

DSH（DeepSeek Harness）的 **Hindsight 外部记忆管家**：设置页图形界面 + 官方适配器自动检测与自动安装，装完即用，全程无需命令行。

> 🧠 底层使用官方 [Hindsight](https://hindsight.vectorize.io) 记忆系统
> （[Coding Agents 集成](https://hindsight.vectorize.io/sdks/integrations/coding-agents)）。
> 本插件是它的**包装与管家**，不修改官方运行时。

## ✨ 功能特性

- **自动检测与自动安装**：插件启动时检查官方 DSH 适配器
  （`npx @vectorize-io/hindsight-coding-agents install dsh`）是否已安装挂载；
  缺失时自动非交互执行官方安装器（地址依次取自：现有 `coding-agent.json`
  → 本插件 sidecar 的内网地址 → 插件配置 `defaultApiUrl`）。
  也可在界面点「一键安装官方适配器」
- **设置页 GUI**：设置 → 插件 → 「外部记忆」标签页
  - 当前状态展示：生效地址 (apiUrl)、DSH 专属覆盖、当前路由、写入范围、
    serverMode、官方 runtime 版本、适配器挂载状态
  - 「管理」弹窗：编辑内网地址 / 外网地址 / 当前路由（内网|外网）/
    写入范围（全部客户端|仅 DSH），逐地址「测试」连通性，保存设置
- **双路由管理**：内网/外网两套地址 + 一键切换；`仅 DSH` 模式写入
  `harnesses.dsh.apiUrl` 分节，不影响 Codex 等其他客户端
- **安全写入**：原子写 + 改动前自动备份 `coding-agent.json`
  （`*.hindsight-settings-backup`），保留全部未知字段
- **未安装警示**：适配器缺失时红色横幅 + 安装命令 + [官方文档](https://hindsight.vectorize.io/sdks/integrations/coding-agents)链接 + 「?」帮助
- **零构建**：浏览器半边以 web2 模块格式手写，Node ≥ 20 即可运行

## 📦 安装

### 方式一：DSH 插件市场

在 [DSH插件市场](https://github.com/bradeGithub/DSH-Plugins-Marketplace) 中搜索
「hindsight」一键安装（本仓库带 `dsh-plugin` topic，市场索引自动收录）。

### 方式二：命令安装

```bash
dsh plugin --profile web add dsh-hindsight-plugins            # npm（发布后）
dsh plugin --profile web add git+https://github.com/a771853580/dsh-hindsight-plugins.git
```

### 方式三：手动挂载（无需重启，用户 patch 层有实时监听）

把本包放入 profile 的 `node_modules`（本包运行时零依赖，目录联接/复制即可），
然后在任一用户 patch 层（如 `~/.dsh/cordis.patch.yml`）追加：

```yaml
- insert:
    - id: hindsight-plugins
      name: dsh-hindsight-plugins
      config:
        autoInstall: true    # 启动时检测并自动安装官方适配器（默认开启）
        # defaultApiUrl: 'http://192.168.1.100:18888'   # 地址兜底（示例）
```

刷新浏览器页面，打开 设置 → 插件 → 外部记忆。

## 🔧 工作原理

```
设置 → 插件 → 「外部记忆」（浏览器半边，settings.plugins.tab slot）
        │  fetch /plugins/dsh-hindsight-plugins/{config,test,install}
        ▼
宿主半边（node，webServer 路由，仅接受 loopback）
  GET  /config   读取路由 + 生效配置 + 适配器状态 + 安装进度
  POST /config   保存（原子写 + 自动备份 coding-agent.json）
  POST /test     地址连通性探测（状态码 + 延迟）
  POST /install  一键安装官方适配器（启动时也会自动检测）
        ▼
~/.hindsight/dsh-route.json       ← 双地址与当前路由（本插件 sidecar）
~/.hindsight/coding-agent.json    ← 解析后的地址（apiUrl 或 harnesses.dsh.apiUrl）
        ▼
官方 dsh.js 适配器（零改动）在会话启动时读取 → 对新会话生效
```

## ⚙️ 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `autoInstall` | `true` | 启动时检测官方适配器，缺失则自动安装 |
| `defaultApiUrl` | `''` | 自动安装时的地址兜底（现有配置与 sidecar 均无地址时使用） |

## 🔒 安全说明

- 路由仅接受 loopback Host 请求（与 DSH GUI 自身同一姿态）
- 自动安装固定 `--server self-hosted` 非交互模式，绝不把记忆发往云端
- 安装日志完整记录并显示在界面横幅中；5 分钟超时自动终止

## 🛠️ 开发

```bash
node --check lib/index.js && node --check lib/client.js   # 语法
node test/e2e.mjs                                          # 端到端（需 dsh web 运行中）
npm pack                                                   # 打包 tgz
```

- **浏览器半边即改即生效**（刷新页面）
- **宿主半边更新需重启 `dsh web`**：运行中的实例持有路由注册，热重挂会被安全拒绝

## 📋 提交到 DSH 插件市场

市场索引来自 GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin)
（CI 每 2 小时重建）：

1. 在 GitHub 创建仓库（建议与包同名 `dsh-hindsight-plugins`），推送本目录
2. 仓库 Settings → Topics 添加 **`dsh-plugin`**
3. 更新 `package.json` 的 `repository.url` 为你的仓库地址
4. 完成（最迟 2 小时进入市场索引；急用可跑市场的 `update-registry` 触发重建）

## 📄 许可

MIT
