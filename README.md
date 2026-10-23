# dsh-notepad

在 DeepSeek Harness 的会话界面里放一张**属于当前工作区**的分段便签浮窗：一行一个问题、一段一个卡片，回车就能新建下一段；需要时把某一段、或勾选后的多段一起插入 / 替换 / 发送到对话框。除了文字，也可以直接**粘贴或选择图片**，输入框里会用缩略芯片显示，插入 / 发送时按路径引用。

> A per-workspace floating segmented notepad for DeepSeek Harness sessions. Enter creates a new segment card; paste or pick images as in-input thumbnail chips; insert, replace, or send one segment or a multi-selection; sending archives the segment automatically. Notes live in `<workspace>/.dsh/notepad.json`, pasted images in `<workspace>/.dsh/notepad/images/`, and every session opened from that workspace shares the same note.

## 安装

```bash
dsh plugin --profile web add @restregular/dsh-notepad
```

安装后重启 / 重新打开 DSH（或刷新页面），打开任意一个会话即可看到右下角的「记事本」浮窗。

## 界面

```
┌────────────────────────────────────────────┐
│ ● 记事本  [workspace]  复制 归档+ 折叠 最小化 │
│ ☐ 全选   勾选分段可批量操作   ↙ ⇄ ➤ 归档       │
│ ┌────────────────────────────────────────┐ │
│ │ ☐ 01                               ↙ ⇄ ➤ 归档 │
│ │ 记录第一段……                               │ │
│ └────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────┐ │
│ │ ☐ 02                               ↙ ⇄ ➤ 归档 │
│ │ 记录第二段……                               │ │
│ └────────────────────────────────────────┘ │
│  已保存 · 42 字符 · 2 段      Enter 新建分段… │
└────────────────────────────────────────────┘
```

- **回车 / Enter**：把当前分段从光标处拆开，创建一张新的分段卡片（光标前的文字留在原卡片，光标后的文字进入新卡片）。在末尾回车就是新建一个空分段。
- **Shift + Enter**：分段内换行。
- **Ctrl / Cmd + Enter**：把当前分段（有勾选时改为勾选的多段）插入对话框。
- 卡片上的 **↙** 插入此段；**⇄** 用此段替换整个对话框内容；**➤** 直接发送此段。

## 功能

| 操作 | 入口 | 说明 |
| --- | --- | --- |
| 新建分段 | 标题栏 `+`，或分段末尾按回车 | 新卡片自动获得焦点 |
| 编辑分段 | 点击卡片文本区 | 停止输入约 0.5 秒后自动保存 |
| 添加图片（选择） | 卡片头部的图片按钮 | 桌面端直接用所选文件的宿主路径引入，不复制文件 |
| 添加图片（粘贴） | 在分段文本区粘贴截图 / 图片 | 写入 `.dsh/notepad/images/`，再以该路径引入 |
| 添加图片（拖入） | 把图片拖到分段文本区 | 优先使用宿主路径，浏览器拿不到路径时按粘贴方式保存 |
| 图片芯片 | 分段输入框内 | 缩略图 + 文件名 + 移除按钮；点击缩略图打开原图 |
| 带图插入 / 发送 | 与文字相同入口 | 图片以 `![名称](路径)` 追加在分段文字之后 |
| 单段插入 | 卡片上的左下箭头 | 插入到当前会话输入框光标处，不发送 |
| 多段插入 | 勾选分段 → 工具栏左下箭头，或全选后操作 | 按卡片顺序用空行合并后一次插入 |
| 替换对话框 | 卡片上的 ⇄，或勾选后工具栏 ⇄ | 用该段 / 多段合并内容替换整个输入框 |
| 单段发送 | 卡片上的纸飞机 | 直接发进当前会话；发送成功后自动归档该段 |
| 多段发送 | 勾选分段 → 工具栏纸飞机 | 合并成一条消息发送；发送成功后自动归档这些段 |
| 全选 | 列表上方「全选」复选框 | 一键选中所有未归档分段，再点一次取消 |
| 归档 | 卡片上的归档图标，或工具栏归档图标 | 把分段移入归档区（不发送） |
| 显示 / 隐藏归档 | 标题栏归档图标（带数量角标） | 展开 / 收起归档区，状态按浏览器记忆 |
| 恢复 | 归档卡片上的恢复图标 | 把归档分段放回未归档列表 |
| 删除 | 归档卡片上的垃圾桶 | **只有已归档分段可以删除**，可撤销 |
| 清空归档 | 归档区标题「清空归档」 | 批量删除归档，可撤销 |
| 复制全部 | 标题栏复制按钮 | 复制所有分段（含归档），用空行合并 |
| 调整尺寸 | 拖动右下角斜纹手柄 | 宽高按浏览器记忆，最小 320 × 240 |
| 折叠 / 展开 | 标题栏上下折叠箭头 | 只保留标题栏，内容继续自动保存 |
| 最小化 / 恢复 | 标题栏最小化图标，或 `Ctrl/Cmd + Shift + N` | 收成右下角小图标，带平滑过渡 |
| 拖动位置 | 按住标题栏拖动 | 位置按浏览器记忆 |

同一个工作区里的不同会话共用同一份笔记：在 A 会话写的内容，切到同工作区的 B 会话仍然在。切换工作区时浮窗自动加载对应工作区的文件。

## 深色模式与字体

- 浮窗使用 DSH 主题变量（`--dsw-alias-*`）和 DSH 的正文字体变量 `--dsw-font-family`，与系统 / 设置里的界面字体一致，不再使用等宽字体。
- 深色模式跟随宿主 `body[data-ds-dark-theme]`，对卡片阴影、选中底色、归档弱化等做了单独适配。
- 折叠、显示 / 隐藏、归档展开都有过渡动画，并尊重 `prefers-reduced-motion`。

## 数据与边界

- 笔记保存在 **`<工作区>/.dsh/notepad.json`**，是普通 UTF-8 JSON：

  ```json
  {
    "version": 3,
    "segments": [
      { "id": "seg-1", "text": "遇到的问题\n下一步：补测试" },
      {
        "id": "seg-2",
        "text": "看这张报错截图",
        "images": [{ "path": ".dsh/notepad/images/m1x2-image.png", "name": "image.png" }]
      },
      { "id": "seg-3", "text": "已发送的分段", "archived": true, "archivedAt": "2026-10-23T03:20:00.000Z" }
    ],
    "text": "遇到的问题\n下一步：补测试\n\n看这张报错截图\n![image.png](.dsh/notepad/images/m1x2-image.png)\n\n已发送的分段",
    "updatedAt": "2026-10-23T03:20:01.000Z"
  }
  ```

  `text` 是 `segments`（含图片引用）用空行合并后的副本，方便人工查看，也兼容旧版本。旧版单段文件（只有 `text`）、v2 分段文件和手动改成纯文本的文件会在读取时迁移。`images[].path` 工作区内用相对路径，工作区外保留绝对路径；`name` 仅用于显示和 Markdown 替代文本。
- **粘贴的图片**保存在 `<工作区>/.dsh/notepad/images/`，由宿主接口原子写入，只接受 PNG / JPEG / WebP / GIF，单张最大 20 MB；笔记只保存路径，不内嵌 base64。**选择的图片**直接引用原路径，不复制。每段最多 20 张。
- 移除图片芯片只删除笔记里的引用，不会自动删除磁盘上的图片文件（与 DSH 附件的行为一致）。
- 浮窗位置、尺寸、折叠 / 最小化 / 隐藏状态、归档区是否展开保存在浏览器 `localStorage` 的 `dsh-notepad.ui.v1` 中，按浏览器 / 设备生效，不写入工作区。
- 每个工作区一份笔记，最多 **200 段 / 512 KB**（单段输入框限制 16 万字符，每段最多 20 张图片）。浮窗内是纯文本编辑，不做 Markdown 渲染；图片以缩略芯片展示。
- 浮窗只在**会话视图**出现：打开设置等非会话页面时自动隐藏，回到会话后恢复。
- 写入走宿主同源回环路由 `/dsh-notepad/api/note`，粘贴图片走 `/dsh-notepad/api/image`；两者都只接受 127.0.0.1 的同源请求，并且只允许当前会话的 cwd 或已注册工作区。图片接口只会在固定的 `.dsh/notepad/images/` 下写入合法的图片字节，不能用来读写工作区里的其它文件。
- 窗口重新获得焦点时，如果本地没有未保存的修改，会自动读取磁盘上的最新内容；多窗口同时编辑时以最后一次保存为准。

## 实现

- **Host**（`index.js` + `lib/note-store.js` + `lib/image-store.js`）：`ctx.inject(['webServer'])` 注册 `/dsh-notepad/api` 下的 `GET/PUT /note` 与 `POST /image`，用临时文件 + rename 原子写入 `.dsh/notepad.json`；`GET` 返回 `segments`（含 `images`）与合并后的 `text`，`PUT` 接受 `{ segments: [...] }`，也兼容旧的 `{ text }`。`POST /image` 校验 base64、MIME 与文件签名后写入 `.dsh/notepad/images/`，返回工作区相对路径。
- **Client**（`client.js`）：整个 bundle 包在 IIFE 里；通过 `shell.overlay` 注册浮窗，读取 `uiSession.adapter.current` 得到当前会话与工作区。粘贴图片用 `FileReader` 读成 base64 交给宿主保存；选择 / 拖入图片优先通过桌面桥 `__DSH_HOST_PATHS__.pathFor(file)` 拿宿主路径。插入 / 替换通过会话绑定里的 `inputActions.captureInsertion()/insertText()` 与 `setDraft()`；发送优先走 `sessions.scope(id).conversation.send()`，并回退到 `sessions.binding(id).session.prompt()`。图片在插入 / 发送时以 Markdown 图片语法追加，聊天记录里的 DSH 渲染器会按工作区 cwd 解析这些路径。
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

`test/client-smoke.mjs` 会真正执行 `apply(ctx)` 并渲染浮窗，覆盖：分段加载、编辑自动保存、回车拆分、单段/多段插入与替换、单段/多段发送与自动归档、归档显示隐藏、归档恢复与删除（含撤销）、全选、折叠、最小化 / 恢复、拖动调整尺寸、全局快捷键、深色模式与字体 CSS、重复执行 bundle 的兼容性，以及粘贴 / 选择图片、图片芯片与带图插入发送。

## 已知限制

- 浮窗不会自动把内容推给 Agent；发送使用当前会话的排队发送，需要 Agent 可接收消息。
- 发送按钮依赖 DSH 的会话接口；接口不可用时降级为插入输入框并提示。
- 图片只支持 PNG / JPEG / WebP / GIF，单张最大 20 MB、每段最多 20 张；其它附件类型暂不支持。
- 删除图片芯片不会删除磁盘文件；笔记被清空后，粘贴产生的图片仍保留在 `.dsh/notepad/images/` 下。
- 网页版没有 `__DSH_HOST_PATHS__` 桥，选择 / 拖入的图片会像粘贴一样先复制到 `.dsh/notepad/images/`。
- 图片在浮窗里用缩略芯片表示，不提供富文本行内图文混排；插入 / 发送后由聊天记录按 Markdown 渲染。
- 位置和尺寸是全局的（不按工作区分别记忆）；如果同时打开多个 DSH 窗口，它们在同一个浏览器里共享这份设置。

## License

MIT
