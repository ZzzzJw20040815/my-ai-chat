# My AI Chat

浏览器里的 Gemini 聊天应用。Vite 打包静态页面，Vercel Node.js Function 持有密钥并调用上游接口。聊天记录存在这台设备上，没有登录，也没有服务端数据库。界面仍是现有玻璃布局，没有换成另一套视觉方案。

## 模型

精选模型定义在 `shared/models.js`。默认模型仍是 `gemini-3.1-pro-preview`。自动发现的聊天模型可以继续使用，但只有精选模型暴露思考档位。

- `gemini-3.1-pro-preview`（默认）
- `gemini-3.8-flash`
- `gemini-3.7-flash`
- `gemini-3.6-flash`
- `gemini-3.5-flash`
- `gemini-3-flash-preview`
- `gemini-3.5-flash-lite`
- `gemini-3.1-flash-lite`
- `gemini-4-carbon`：low、medium、high
- `gemini-4-argon`：low、medium、high
- `gemini-4-hydrogen`：low、medium、high、xhigh

未选择档位时不写 `thinkingLevel`，也不写 `thinkingBudget`。不支持的档位返回 `INVALID_REQUEST`，不会被改写成另一个具体档。

`GET /api/models` 在 Gemini API 通道会列出可 `generateContent` 的聊天模型。自动发现的模型不能自定义安全设置，也不能调整采样参数。图片、语音、embedding、computer-use、deep-research 等专用模型会被滤掉。Vertex 通道不调用 AI Studio 的模型列表，只使用上面的精选目录；目录里有模型，不等于当前 Google Cloud 项目或区域已经开通它。

## API 通道

请求可以带 `apiChannel`：`ai-studio` 或 `vertex`。缺省是 `ai-studio`。非法值直接拒绝，不会改走另一条通道。

Gemini API 使用服务端 `GEMINI_API_KEY`。Vertex 使用服务端 `VERTEX_PROJECT_ID`、可选的 `VERTEX_LOCATION`（空则 `global`）和 `GOOGLE_CREDENTIALS_JSON`（`authorized_user`，含 `client_id`、`client_secret`、`refresh_token`）。这些都只放在服务器 Secret 里，不要加 `VITE_` 前缀，不要写进仓库或上传的 `.env`。浏览器拿不到 access token、refresh token、client secret 或凭据 JSON。切换通道不会删除本地 `my-ai-chat-gemini-api-key`，两条通道的请求体也不携带这把本地 key。

这个应用没有登录。同源访客可以调用聊天、故事记忆和模型接口。公开站点启用 Vertex 之前，需要另行加上由站点所有者控制的访问限制，否则这些请求会消耗该 Google Cloud 项目的配额。

| 路径 | 作用 |
| --- | --- |
| `POST /api/chat` | 流式聊天。请求字段白名单由 `server/chat.js` 校验，客户端不能传入 `tools` |
| `GET /api/models` | 模型目录。只接受无查询或 `?refresh=1` |
| `POST /api/story-memory` | 从当前可见分支提取故事记忆。不附带 Google 搜索 |

`vercel.json` 里 `api/chat.js` 最长 120 秒并开启取消，`api/story-memory.js` 最长 90 秒并开启取消，`api/models.js` 最长 30 秒。

## 本地存储

IndexedDB 数据库 `my-ai-chat`，版本 4，四个 object store：

| store | 内容 |
| --- | --- |
| `chats` | 对话、分支、故事模式 |
| `assets` | 壁纸 Blob |
| `storyMemories` | 按分支锚点保存的故事记忆 |
| `styleReferences` | 最多 5 条风格参考 |

`localStorage` 保存全局设置（`my-ai-chat-global-settings`）、主题、当前聊天 id，以及按通道分开的模型目录缓存。

## 功能

- 故事模式：构思、写正文、继续、退出。写正文时不附带 Google 搜索。
- 故事记忆：只沿当前可见分支继承，整理时不联网搜索。
- 风格参考：保存回复，供后续生成模仿文风。
- 主界面思考深度和设置里的思考档位共用同一偏好。切换模型或通道不会改写已保存档位；当前模型不支持时，这一次请求不发送该档。
- 设置码 V1（`MAICFG1.`）：只搬设置和主题，包含 `apiChannel` 与 `webSearch`。非法已知字段会拒绝整份设置码。
- 备份 V1：按聊天 `updatedAt` 合并。旧备份没有联网搜索字段时仍可导入。
- 联网搜索：默认开启，设置里可以关闭，文案会提示可能产生 Google 搜索费用。关闭后 SDK 请求不包含搜索工具。开启后，普通聊天和构思会附上 `googleSearch`，由模型决定是否查询；写正文保持关闭。查到网页后，回复下方显示来源和经过 DOMPurify 隔离的 Google 搜索建议。

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

测试拦截 SDK 和 Vertex HTTP，使用假密钥，不访问 Google。

## 部署

部署这个目录。Vercel 执行 `npm run build`，静态文件来自 `dist/client`。在 Project Settings 里把 `GEMINI_API_KEY` 配成 Production（以及需要的话 Preview）的 Secret。Vertex 变量同样只放服务器 Secret。

浏览器点停止后，`supportsCancellation` 会把取消传到上游 `abortSignal`。

Markdown 仍由 marked 渲染，再经 DOMPurify 清理。
