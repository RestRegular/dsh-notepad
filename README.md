# dsh-notepad

在 DeepSeek Harness 的会话界面里放一张**属于当前工作区**的便签浮窗：记录开发中遇到的问题、踩过的坑，或者下一阶段要做的事；需要时一键把整段内容插进对话输入框。

> A per-workspace floating notepad for DeepSeek Harness sessions. Jot down problems and next steps, insert the whole note into the composer with one click, drag it anywhere, minimize it, or hide it with a shortcut. Notes live in `<workspace>/.dsh/notepad.json` and are shared by every session opened from that workspace.

## 安装

```bash
dsh plugin --profile web add @restregular/dsh-notepad
```

安装后重启 / 重新打开 DSH（或刷新页面），打开任意一个会话即可看到右下角的「记事本」浮窗。

## 功能

| 操作 | 入口 | 说明 |
| --- | --- | --- |
| 记录 / 修改 | 点击文本区直接输入 | 停止输入约 0.5 秒后自动保存，脚注显示「保存中 / 已保存 / 保存失败」 |
| 插入到输入框 | 标题栏的向下箭头按钮，或 `Ctrl/Cmd + Enter` | 把整段笔记插入当前会话的输入框（只插入，不发送）；输入框暂时不可用时自动复制到剪贴板 |
| 复制全部 | 标题栏复制按钮 | 复制整段笔记 |
| 拖动位置 | 按住标题栏拖动 | 位置按浏览器记忆，刷新后仍在原处 |
| 最小化 / 展开 | 标题栏的减号按钮 | 只保留标题栏，内容仍在后台自动保存 |
| 隐藏 / 显示 | 标题栏的隐藏按钮，或 `Ctrl/Cmd + Shift + N` | 隐藏后只在右下角保留一个小图标；再按快捷键或点图标恢复 |
| 查看工作区 | 标题栏的工作区徽标 | 悬停可看完整路径 |

同一个工作区里的不同会话共用同一份笔记：在 A 会话写的内容，切到同工作区的 B 会话仍然在。切换工作区时浮窗自动加载对应工作区的文件。

## 数据与边界

- 笔记保存在 **`<工作区>/.dsh/notepad.json`**，是普通 UTF-8 JSON：

  ```json
  {
    "version": 1,
    "text": "遇到的问题\n下一步：补测试",
    "updatedAt": "2026-10-23T02:36:21.000Z"
  }
  ```

  如果该文件被手动改成纯文本，浮窗会把它当作笔记正文读出来，不会丢内容。
- 浮窗位置、最小化状态、隐藏状态保存在浏览器 `localStorage` 的 `dsh-notepad.ui.v1` 中，按浏览器/设备生效，不写入工作区。
- 每个工作区一份笔记，最多 **512 KB**（输入框限制 16 万字符）。笔记是纯文本，不做 Markdown 渲染。
- 浮窗只在**会话视图**出现：打开设置等非会话页面时自动隐藏，回到会话后恢复。
- 写入走宿主同源回环路由 `/dsh-notepad/api/note`，只接受 127.0.0.1 的同源请求，并且只允许当前会话的 cwd 或已注册工作区，不能用来读写工作区里的其它文件。
- 窗口重新获得焦点时，如果本地没有未保存的修改，会自动读取磁盘上的最新内容；多窗口同时编辑时以最后一次保存为准。

## 实现

- **Host**（`index.js` + `lib/note-store.js`）：`ctx.inject(['webServer'])` 注册 `/dsh-notepad/api` 下的 `GET/PUT /note`，用临时文件 + rename 原子写入 `.dsh/notepad.json`。
- **Client**（`client.js`）：整个 bundle 包在 IIFE 里；通过 `shell.overlay` 注册浮窗，读取 `uiSession.adapter.current` 得到当前会话与工作区，通过会话绑定里的 `inputActions.captureInsertion()/insertText()` 写入输入框。没有 `inputActions` 时降级为复制。
- 文案通过宿主 `locale` 服务注册中英文；找不到 locale 时按浏览器语言回退。

## 开发

```bash
# 语法
node --check index.js
node --check client.js

# 宿主存储与路由
node test/note-store.test.mjs
node test/route.test.mjs

# 客户端离线冒烟（迷你 React + 浏览器垫片）
node test/client-smoke.mjs

# 包清单、导出、locale 元数据与图标
node test/package.test.mjs

# 或一次跑完
npm test
```

`test/client-smoke.mjs` 会真正执行 `apply(ctx)` 并渲染浮窗，覆盖：加载、自动保存、插入输入框、最小化、隐藏/恢复、全局快捷键、重复执行 bundle 的兼容性。

## 已知限制

- 浮窗不会自动把内容推给 Agent；需要让 Agent 看到时，用「插入到输入框」或让 Agent 读取 `.dsh/notepad.json`。
- 不做富文本、附件、多便签或跨工作区共享。
- 位置是全局的（不按工作区分别记忆）；如果同时打开多个 DSH 窗口，它们在同一个浏览器里共享这份位置设置。

## License

MIT
