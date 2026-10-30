# My AI Chat

浏览器里的 Gemini 聊天应用。Vite 打包静态页面，Vercel Node.js Function 持有密钥并调用 `@google/genai`。聊天记录存在这台设备上，没有登录，也没有服务端数据库。

## 模型

内置 8 个模型，定义在 `shared/models.js`：

- `gemini-3.1-pro-preview`
- `gemini-3.8-flash`
- `gemini-3.7-flash`
- `gemini-3.6-flash`
- `gemini-3.5-flash`
- `gemini-3-flash-preview`
- `gemini-3.5-flash-lite`
- `gemini-3.1-flash-lite`

`GET /api/models` 还会从 Gemini 列出可 `generateContent` 的聊天模型。自动发现的模型不能自定义安全设置，也不能调整采样参数。图片、语音、embedding、computer-use、deep-research 等专用模型会被滤掉。

## API

这三个 Vercel Function 都会读取服务端环境变量 `GEMINI_API_KEY`。不要加 `VITE_` 前缀，也不要把真实密钥放进仓库。

| 路径 | 作用 |
| --- | --- |
| `POST /api/chat` | 流式聊天。请求字段白名单由 `server/chat.js` 校验，客户端不能传入 `tools` |
| `GET /api/models` | 模型目录。只接受无查询或 `?refresh=1` |
| `POST /api/story-memory` | 从当前可见分支提取故事记忆 |

`vercel.json` 里 `api/chat.js` 最长 120 秒并开启取消，`api/story-memory.js` 最长 90 秒并开启取消，`api/models.js` 最长 30 秒。

## 本地存储

IndexedDB 数据库 `my-ai-chat`，版本 4，四个 object store：

| store | 内容 |
| --- | --- |
| `chats` | 对话、分支、故事模式 |
| `assets` | 壁纸 Blob |
| `storyMemories` | 按分支锚点保存的故事记忆 |
| `styleReferences` | 最多 5 条风格参考 |

`localStorage` 保存全局设置（`my-ai-chat-global-settings`）、主题、当前聊天 id，以及模型目录缓存。

## 功能

- 故事模式：构思、写正文、继续、退出。写正文时不会附带 Google 搜索。
- 故事记忆：只沿当前可见分支继承，整理时不联网搜索。
- 风格参考：保存回复，供后续生成模仿文风。
- 设置码 V1（`MAICFG1.`）：只搬设置和主题。
- 备份 V1：按聊天 `updatedAt` 合并。旧备份没有联网搜索字段时仍可导入。
- 联网搜索：设置里可以关闭，文案会提示可能产生 Google 搜索费用。模型自己决定要不要查。查到网页后，回复下方显示来源和 Google 搜索建议。Gemini 3 及更新模型按搜索查询计费，每月有免费额度，超额后按次收费。

发给模型的上下文只包含当前可见分支上已经完成的回复。

## 本地命令

在 `my-ai-chat-vercel-reviewed` 目录：

```sh
npm install
npm run dev
npm run build
npm test
npm run verify
```

`npm run verify` 会先构建，再跑完整测试。直接 `npm test` 时，如果还没有 `dist/client`，检查构建产物的那一项会失败，并提示先运行 `npm run build` 或 `npm run verify`。

测试拦截 SDK 请求，不访问 Google。

## 部署

部署这个目录。Vercel 执行 `npm run build`，静态文件来自 `dist/client`。在 Project Settings 里把 `GEMINI_API_KEY` 配成 Production（以及需要的话 Preview）的 Secret。

浏览器点停止后，`supportsCancellation` 会把取消传到 Gemini 的 `abortSignal`。
