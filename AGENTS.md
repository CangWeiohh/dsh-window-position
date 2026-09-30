# AGENTS.md — dsh-window-position 插件协作指南

> 本文件供任意 AI 编码 Agent（Cursor、Copilot、Codex、Claude Code 等）在安装、调试或修改本插件时阅读。核心结论与踩坑经验都写在这里，避免重复踩坑。

---

## 插件定位

**dsh-window-position** 是一个 DeepSeek Harness（DSH）桌面客户端插件，解决一个问题：

> 客户端每次启动，主窗口都出现在**主显示器居中**、用默认大小，不会记住上次关闭时的屏幕、位置和大小。

**根因**（已实证，两个客户端同款问题）：桌面客户端主进程 `createWindow()` 只给了固定尺寸（DeepSeek Harness 1280×820 / DSH Desktop 1380×900），不传 `x`/`y`，也没有任何窗口状态持久化。Electron 默认行为就是「未指定坐标 → 主显示器居中」。本插件同时记住并恢复**位置和大小**（保存 `x`、`y`、`width`、`height` 四个值）。

支持的客户端（宿主端启动时自动探测进程名，顺序：`DeepSeek Harness` → `DSH Desktop`；环境变量 `DSH_WINDOW_PROCESS_NAME` 可强制指定）：

| 客户端 | 进程名 | profile | DSH_HOME | 说明 |
| --- | --- | --- | --- | --- |
| DeepSeek Harness（官方） | `DeepSeek Harness` | `desktop` | `~/.dsh` | 主要目标 |
| DSH Desktop（社区，≤0.9.x） | `DSH Desktop` | `web` | `~/Library/Application Support/dsh-desktop/harness` | 0.10.0 起官方已内置原生窗口状态持久化，**不需要本插件** |

---

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `client.js` | 浏览器端（渲染进程）：启动时请求宿主端移动窗口并恢复大小，之后每 3 秒保存当前窗口的位置和大小 |
| `index.js` | 宿主端（harness 进程）：注册 HTTP 路由，持久化窗口坐标和尺寸，用 osascript 移动/调整窗口（进程名自动探测） |
| `cordis.patch.yml` | 插件加载声明（一个 loader entry） |
| `package.json` | 包清单，`dsh.client` 声明浏览器端入口 |
| `index.test.js` | 宿主端单测（路由 + 持久化 + 鉴权 + AppleScript 生成） |

---

## 安装方式（本地 link，无 npm 账号）

本插件**没有发布到 npm**，只能通过本地路径链接安装。

### DeepSeek Harness 客户端（desktop profile）

```bash
/Applications/DeepSeek\ Harness.app/Contents/Resources/runtime/cli/bin/dsh \
  plugin --profile desktop add link:/绝对路径/dsh-window-position
```

关键点：

- App 自带完整 CLI（`runtime/cli/bin/dsh` 是官方启动脚本：`ELECTRON_RUN_AS_NODE=1` + Electron 二进制 + `app.asar/dsh/.../dsh-desktop-host/lib/cli.js`），无需自备 node。
- desktop profile 必须已由 App 初始化过（`~/.dsh/profiles/desktop/package.json` 存在），否则报「Open DeepSeek Harness Desktop once to initialize its profile」。
- CLI `add` 对 desktop profile 是**带 package.json 文件锁的 pnpm add**（锁等待 120s），安装后自动 reconcile `dsh.profile.bundles`（新装且声明 `dsh.bundle` 的包会自动追加）。
- desktop profile 用 pnpm 11.7 + `pnpm-workspace.yaml` 的 `overrides`（不是 package.json 的 pnpm 字段——pnpm 11 不再读那个）。`link:` 本地依赖会以符号链接装入 node_modules，**不物化 Generation 快照**（Generation 是市场通道的行为）。
- 安装后**必须完全退出并重启客户端**（关窗只是最小化到后台，要从菜单退出）。

### DSH Desktop ≤ 0.9.x（web profile，旧路径）

```bash
export DSH_HOME="$HOME/Library/Application Support/dsh-desktop/harness"
"$DSH_HOME/.desktop-bin/node" \
  "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add link:/绝对路径/dsh-window-position
```

> 注意：必须用 `add`，不是 `install`。`install` 是修复用途，且 pnpm 10 不认 `--no-frozen-lockfile`。

卸载：`dsh plugin --profile desktop remove dsh-window-position`（或对应 profile）。

---

## 关键机制（踩坑结论，务必理解）

### 1. 为什么用 osascript，而不是 window.moveTo()

这是本插件开发过程中最大的坑，结论如下：

- `window.moveTo()` 在**独立 Electron** 里可以跨屏移动窗口（实测成功）。
- 但在**真实客户端**里，`window.moveTo()` 到外接屏坐标会被 Chromium **钳制回内建屏右边缘**，无法跨屏（窗口几乎占满内建屏时无水平余量）。
- **`osascript` + System Events 可以跨屏移动窗口、调整窗口大小**（实测成功），所以宿主端用 osascript 移动，而不是渲染进程的 moveTo。

### 1b. 大小恢复也走 osascript

- `bounds.json` 里保存 `{x, y, width, height}` 四个值，位置和大小一起恢复。
- osascript 脚本同时执行 `set position of window 1 to {x, y}` 和 `set size of window 1 to {w, h}`。
- 旧的（没有 `width`/`height` 的）历史数据仍然兼容：只移动位置、不改变大小。
- 恢复校验：位置用 4px 容差，大小用 8px 容差（`client.js` 里的 `POSITION_EPSILON` / `SIZE_EPSILON`）。

### 2. 移动窗口需要 Accessibility 权限

osascript 移动窗口依赖 macOS 的「辅助功能（Accessibility）」权限。TCC 按发起进程树归因：插件运行在客户端 App 的 harness 子进程里，所以**要给客户端 App 本身授权**。如果移动失败（osascript 报 -25211「不允许辅助访问」），检查：

- 系统设置 → 隐私与安全性 → 辅助功能，确认 `DeepSeek Harness`（或 `DSH Desktop`）已勾选。

### 3. 持久化为什么走宿主端路由，而不是 localStorage

DSH Desktop 的 harness webserver 端口**每次启动随机分配**，页面 origin 每次都变，localStorage 无法跨启动保留。所以窗口坐标持久化到宿主端的文件：

```
$DSH_HOME/plugin-data/dsh-window-position/bounds.json
```

（DeepSeek Harness 客户端的 desktop profile 端口固定 19387，但文件持久化对两个客户端都更稳。）

### 4. DeepSeek Harness 的 dsh-app://app 协议转发

官方客户端的 Electron 窗口从 `dsh-app://app` 加载页面（静态前端由协议处理器直接服务），非静态路径（如本插件的 API）由主进程 `forwardWebRequest` 转发到 harness webserver（127.0.0.1:19387），转发时**删除 `Host`/`Origin`/`Cookie`/`Sec-Fetch-Site` 再附上 harness 鉴权 Cookie**。本插件的 `isTrustedRequest` 网关（loopback Host + 拒绝 cross-site + Origin 同源）在这种转发下自然放行，无需特判。浏览器直接访问 19387 时则走同源直连，同样放行。

### 5. 恢复必须短、快、不打架

- 恢复是**短的有界尝试**（延迟 0.8s + 最多 10 次重试，每次间隔 0.3s），失败就放弃。
- 恢复结束后**立即开始保存当前实际位置**，这样用户手动拖动的位置总能被记住。
- 早期版本曾犯过两个错：重试 20 次（10 秒）和用户拖动「打架」；恢复失败后永久禁止保存，导致用户拖到外接屏的位置永远不保存（死循环）。
- DSH Desktop 0.9.x 启动慢的教训：osascript 超时从 5s 降到 2s、重试从 3 次升到 10 次——单次挂死不再拖长整体恢复。

---

## 验证方式

1. 完全退出客户端（DeepSeek Harness 要从菜单退出，关窗只是最小化），重新打开。
2. 窗口先在主屏居中、用默认大小（主进程默认，插件改不了），约 1~3 秒后自动移到上次保存的位置、恢复上次的大小。
3. 手动把窗口拖到目标屏幕和位置、调整到想要的大小，停留 3 秒以上（让插件保存），再次重启验证恢复。

诊断信息（可选，DeepSeek Harness 为例）：

```bash
# 查看保存的坐标
cat "$HOME/.dsh/plugin-data/dsh-window-position/bounds.json"

# 查看恢复诊断（最近 60 条时间线）
cat "$HOME/.dsh/plugin-data/dsh-window-position/diagnostic.json"

# 手动探测进程名（验证 Accessibility + 探测逻辑）
osascript -e 'tell application "System Events" to exists process "DeepSeek Harness"'
```

---

## 已知限制

- 窗口启动时**先在主屏居中、用默认大小**，约 1~3 秒后才跳到保存位置并恢复大小（只有官方主进程支持窗口状态持久化才能消除这次跳动）。
- 全屏状态不记录、不恢复。
- 外接屏拔掉后，osascript 移动可能失败，插件会保留旧坐标，下次启动重试。
- 若同时用浏览器打开 harness 网页端（127.0.0.1:19387），浏览器标签页也会运行保存逻辑并可能移动客户端窗口——建议只用客户端窗口。
