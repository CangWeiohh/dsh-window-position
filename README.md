# dsh-window-position

一个 DeepSeek Harness（DSH）桌面客户端插件，让客户端窗口记住上次关闭时的**屏幕、位置和大小**，启动后自动恢复。

支持两个桌面客户端（自动探测，无需配置）：

- **DeepSeek Harness**（官方客户端，`/Applications/DeepSeek Harness.app`，desktop profile，DSH_HOME=`~/.dsh`）
- **DSH Desktop**（社区桌面版 ≤ 0.9.x；0.10.0 起官方已内置 `WindowStateManager` 原生窗口状态持久化，无需本插件）

## 解决的问题

客户端每次启动，主窗口都出现在**主显示器居中**，且尺寸是主进程写死的默认值（DeepSeek Harness 为 1280×820），不会记住上次关闭时的屏幕、位置和大小。本插件在启动后自动把窗口移回上次的位置、恢复上次的大小（支持跨屏，例如恢复到外接显示器）。

## 安装

本插件**未发布到 npm**，只能通过本地路径链接安装。

### 方式一：让 AI 帮你安装（推荐）

本仓库根目录的 [`AGENTS.md`](./AGENTS.md) 是写给 AI 的协作指南，包含了完整的安装命令、关键机制和踩坑结论。把本仓库交给任意 AI 编码 Agent，让它阅读 `AGENTS.md` 后执行安装即可。

### 方式二：手动安装

**DeepSeek Harness 客户端**（desktop profile，用 App 自带 CLI）：

```bash
/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh \
  plugin --profile desktop add link:/绝对路径/dsh-window-position
```

**DSH Desktop ≤ 0.9.x**（web profile，老路径）：

```bash
export DSH_HOME="$HOME/Library/Application Support/dsh-desktop/harness"
"$DSH_HOME/.desktop-bin/node" \
  "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add link:/绝对路径/dsh-window-position
```

安装后**完全退出并重启客户端**再打开，新代码才会生效。注意 DeepSeek Harness 关窗是最小化到后台，必须从菜单真正退出。

> 注意：必须用 `add`，不是 `install`。`install` 是修复用途，且 pnpm 10 不认 `--no-frozen-lockfile`。

## 使用

1. 重启客户端，窗口会先在主屏居中，约 1~3 秒后自动移到上次保存的位置、恢复上次的大小。
2. 手动把窗口拖到想要的屏幕和位置，再调整到你想要的大小，**停留 3 秒以上**（让插件保存）。
3. 再次重启，窗口会自动恢复到那个位置和大小。

## 工作原理

- **浏览器端**（`client.js`）：启动时请求宿主端移动窗口并恢复大小，之后每 3 秒保存当前窗口的位置和大小。
- **宿主端**（`index.js`）：注册 HTTP 路由，把窗口坐标和尺寸持久化到 `${DSH_HOME}/plugin-data/dsh-window-position/bounds.json`，并用 `osascript` 移动/调整窗口。进程名自动探测（`DeepSeek Harness` → `DSH Desktop`，可用环境变量 `DSH_WINDOW_PROCESS_NAME` 强制指定）。
- **为什么用 osascript 而不是 `window.moveTo()`**：客户端窗口几乎占满内建屏时，`window.moveTo()` 到外接屏坐标会被 Chromium 钳制回内建屏，而 osascript + System Events 可以跨屏移动窗口、调整窗口大小。
- **DeepSeek Harness 的 `dsh-app://app` 协议**：Electron 窗口从自定义协议加载页面，API 请求由主进程转发到 harness webserver（转发时剥离 `Origin`/`Sec-Fetch-Site`/`Cookie`），本插件的回环信任网关无需修改即可通过。

## 依赖

- macOS（osascript 移动窗口依赖 macOS 的「辅助功能」权限，需授予客户端 App）
- DeepSeek Harness 官方客户端（或 DSH Desktop ≤ 0.9.x）

## 已知限制

- 窗口启动时先在主屏居中、用默认大小，约 1~3 秒后才跳到保存位置并恢复大小。
- 全屏状态不记录、不恢复。
- 外接屏拔掉后，osascript 移动可能失败，插件会保留旧坐标，下次启动重试。
- 若同时用浏览器打开 harness 网页端（127.0.0.1:19387），浏览器标签页也会运行保存逻辑并可能移动客户端窗口——建议只用客户端窗口。

## 许可证

MIT
