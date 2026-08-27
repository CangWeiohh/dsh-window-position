# dsh-window-position

一个 DeepSeek Harness（DSH）桌面版插件，让 DSH Desktop 记住窗口上次关闭时的屏幕和位置，启动后自动恢复。

## 解决的问题

DSH Desktop 每次启动，主窗口都出现在**主显示器居中**，不会记住上次关闭时的屏幕和位置。本插件在启动后自动把窗口移回上次的位置（支持跨屏，例如恢复到外接显示器）。

## 安装

本插件**未发布到 npm**，只能通过本地路径链接安装。

### 方式一：让 AI 帮你安装（推荐）

本仓库根目录的 [`AGENTS.md`](./AGENTS.md) 是写给 AI 的协作指南，包含了完整的安装命令、关键机制和踩坑结论。把本仓库交给任意 AI 编码 Agent（Cursor、Copilot、Codex、Claude Code 等），让它阅读 `AGENTS.md` 后执行安装即可。

### 方式二：手动安装

```bash
# 1. 设置 DSH_HOME 指向桌面版的 harness 目录
export DSH_HOME="$HOME/Library/Application Support/dsh-desktop/harness"

# 2. 用桌面版自带的 node 运行 dsh CLI，把插件 link 进 web profile
"$DSH_HOME/.desktop-bin/node" \
  "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add link:/绝对路径/dsh-window-position
```

安装后**完全退出并重启 DSH Desktop**（Cmd+Q 再打开），新代码才会生效。

> 注意：必须用 `add`，不是 `install`。`install` 是修复用途，且 pnpm 10 不认 `--no-frozen-lockfile`。

## 使用

1. 重启 DSH Desktop，窗口会先在内建屏居中，约 1~2 秒后自动移到上次保存的位置。
2. 手动把窗口拖到想要的屏幕和位置，**停留 3 秒以上**（让插件保存）。
3. 再次重启，窗口会自动恢复到那个位置。

## 工作原理

- **浏览器端**（`client.js`）：启动时请求宿主端移动窗口，之后每 3 秒保存当前窗口位置。
- **宿主端**（`index.js`）：注册 HTTP 路由，把窗口坐标持久化到 `harness/plugin-data/dsh-window-position/bounds.json`，并用 `osascript` 移动窗口。
- **为什么用 osascript 而不是 `window.moveTo()`**：真实 DSH Desktop 里 `window.moveTo()` 到外接屏坐标会被 Chromium 钳制回内建屏（窗口 1380×900 几乎占满内建屏 1440×900），而 osascript + System Events 可以跨屏移动。

## 依赖

- macOS（osascript 移动窗口依赖 macOS 的「辅助功能」权限）
- DSH Desktop（DeepSeek Harness 桌面版）

## 已知限制

- 窗口启动时先在内建屏居中，约 1~2 秒后才跳到保存位置（只有官方主进程支持窗口状态持久化才能消除这次跳动）。
- 全屏状态不记录、不恢复。
- 外接屏拔掉后，osascript 移动可能失败，插件会保留旧坐标，下次启动重试。

## 许可证

MIT