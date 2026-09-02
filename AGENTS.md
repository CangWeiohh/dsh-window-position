# AGENTS.md — dsh-window-position 插件协作指南

> 本文件供任意 AI 编码 Agent（Cursor、Copilot、Codex、Claude Code 等）在安装、调试或修改本插件时阅读。核心结论与踩坑经验都写在这里，避免重复踩坑。

---

## 插件定位

**dsh-window-position** 是一个 DeepSeek Harness（DSH）桌面版插件，解决一个问题：

> DSH Desktop 每次启动，主窗口都出现在**主显示器居中**、用默认大小，不会记住上次关闭时的屏幕、位置和大小。

**根因**（已实证）：DSH Desktop 主进程 `createWindow()` 只给了固定尺寸（1380×900），不传 `x`/`y`，也没有任何窗口状态持久化。Electron 默认行为就是「未指定坐标 → 主显示器居中」。本插件同时记住并恢复**位置和大小**（保存 `x`、`y`、`width`、`height` 四个值）。

---

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `client.js` | 浏览器端（渲染进程）：启动时请求宿主端移动窗口并恢复大小，之后每 3 秒保存当前窗口的位置和大小 |
| `index.js` | 宿主端（harness 进程）：注册 HTTP 路由，持久化窗口坐标和尺寸，用 osascript 移动/调整窗口 |
| `cordis.patch.yml` | 插件加载声明（一个 loader entry） |
| `package.json` | 包清单，`dsh.client` 声明浏览器端入口 |
| `index.test.js` | 宿主端单测（路由 + 持久化 + 鉴权） |

---

## 安装方式（本地 link，无 npm 账号）

本插件**没有发布到 npm**，只能通过本地路径链接安装。安装命令：

```bash
# 1. 设置 DSH_HOME 指向桌面版的 harness 目录
export DSH_HOME="$HOME/Library/Application Support/dsh-desktop/harness"

# 2. 用桌面版自带的 node 运行 dsh CLI，把插件 link 进 web profile
"$DSH_HOME/.desktop-bin/node" \
  "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add link:/绝对路径/dsh-window-position
```

关键点：

- **必须用 `add`，不是 `install`**。`install` 是修复用途，且 pnpm 10 不认 `--no-frozen-lockfile`。
- `add` 会自动把声明了 `dsh.bundle` 的包加入 `dsh.profile.bundles` 列表。
- 安装后**必须完全退出并重启 DSH Desktop**，新代码才会生效（打包版没有 HMR）。
- 卸载：`dsh plugin --profile web remove dsh-window-position`。

---

## 关键机制（踩坑结论，务必理解）

### 1. 为什么用 osascript，而不是 window.moveTo()

这是本插件开发过程中最大的坑，结论如下：

- `window.moveTo()` 在**独立 Electron** 里可以跨屏移动窗口（实测成功）。
- 但在**真实 DSH Desktop** 里，`window.moveTo()` 到外接屏坐标会被 Chromium **钳制回内建屏右边缘**，无法跨屏。原因是窗口 1380×900 几乎占满内建屏 1440×900（只剩 60px 水平余量）。
- **`osascript` + System Events 可以跨屏移动窗口、调整窗口大小**（实测成功），所以宿主端用 osascript 移动，而不是渲染进程的 moveTo。

### 1b. 大小恢复也走 osascript

- `bounds.json` 里保存 `{x, y, width, height}` 四个值，位置和大小一起恢复。
- osascript 脚本同时执行 `set position of window 1 to {x, y}` 和 `set size of window 1 to {w, h}`。
- 旧的（没有 `width`/`height` 的）历史数据仍然兼容：只移动位置、不改变大小。
- 恢复校验：位置用 4px 容差，大小用 8px 容差（`client.js` 里的 `POSITION_EPSILON` / `SIZE_EPSILON`）。

### 2. 移动窗口需要 Accessibility 权限

osascript 移动窗口依赖 macOS 的「辅助功能（Accessibility）」权限。如果移动失败，检查：

- 系统设置 → 隐私与安全性 → 辅助功能，确认调用 osascript 的进程（终端 / DSH Desktop）已勾选。

### 3. 持久化为什么走宿主端路由，而不是 localStorage

DSH Desktop 的 harness webserver 端口**每次启动随机分配**，页面 origin 每次都变，localStorage 无法跨启动保留。所以窗口坐标持久化到宿主端的文件：

```
$DSH_HOME/plugin-data/dsh-window-position/bounds.json
```

### 4. 恢复必须短、快、不打架

- 恢复是**短的有界尝试**（延迟 0.8s + 最多 3 次重试），失败就放弃。
- 恢复结束后**立即开始保存当前实际位置**，这样用户手动拖动的位置总能被记住。
- 早期版本曾犯过两个错：重试 20 次（10 秒）和用户拖动「打架」；恢复失败后永久禁止保存，导致用户拖到外接屏的位置永远不保存（死循环）。

---

## 验证方式

1. 完全退出 DSH Desktop（Cmd+Q），重新打开。
2. 窗口先在内建屏居中、用默认大小（主进程默认，插件改不了），约 1~2 秒后自动移到上次保存的位置、恢复上次的大小。
3. 手动把窗口拖到目标屏幕和位置、调整到想要的大小，停留 3 秒以上（让插件保存），再次重启验证恢复。

诊断信息（可选）：

```bash
# 查看保存的坐标
cat "$HOME/Library/Application Support/dsh-desktop/harness/plugin-data/dsh-window-position/bounds.json"

# 查看恢复诊断
cat "$HOME/Library/Application Support/dsh-desktop/harness/plugin-data/dsh-window-position/diagnostic.json"
```

---

## 已知限制

- 窗口启动时**先在内建屏居中、用默认大小**，约 1~2 秒后才跳到保存位置并恢复大小（只有官方主进程支持窗口状态持久化才能消除这次跳动）。
- 全屏状态不记录、不恢复。
- 外接屏拔掉后，osascript 移动可能失败，插件会保留旧坐标，下次启动重试。