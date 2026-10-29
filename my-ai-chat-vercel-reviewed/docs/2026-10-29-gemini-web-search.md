# 2026-10-29 Gemini 联网搜索改动总结

这次改动的目标：在现有项目上，让聊天使用的 Gemini 模型可以调用 Google 搜索。故事记忆整理不开启搜索。

工作区是 `my-ai-chat-vercel-reviewed`。改动开始前，当前分支是 `main`，与 `origin/main` 的提交 `cb7393b`（Merge pull request #18）一致。

## 结论

聊天接口现在会在发给 Gemini 的请求里附上官方的 `google_search` 工具。模型自己决定某条消息要不要搜索。搜索到网页时，回复下方显示来源链接和 Google 返回的搜索建议。来源和搜索建议保存在本机聊天记录里，不会写进下一次发给模型的对话正文。

故事记忆的 `generateContent` 没有这个工具，仍然只做结构化提取。

## 改过的文件

| 文件 | 做了什么 |
| --- | --- |
| `shared/web-search.js` | 新文件。定义搜索工具、清洗来源和搜索建议、生成回复下方的 HTML |
| `server/chat.js` | 每条聊天请求附上 `googleSearch`。流式响应里收集 `groundingMetadata`，在 `done` 事件里带回 `webSources` 和 `searchSuggestionHtml` |
| `ui/app.js` | 收到 `done` 后记下来源和搜索建议，并画在回复正文下面 |
| `ui/state.js` | 回复分支复制时保留来源和搜索建议 |
| `ui/storage.js` | IndexedDB 保存和读回这两项。只保留最多 8 条 `https` 来源，并丢掉不安全的搜索建议 HTML |
| `ui/styles.css` | 来源链接和搜索建议的样式。有来源或搜索建议时，回复气泡与建议同宽 |
| `ui/index.html` | 设置页说明：聊天会启用 Google 搜索，查到网页时显示来源和搜索建议 |
| `vite.config.js` | 本地开发服务器按浏览器实际访问的主机名构造 `/api/chat` 请求。原先固定写成 `http://terminal.local:4173`，浏览器从 `localhost` 打开时会被同源检查拒绝 |
| `tests/web-search.test.js` | 新测试：工具开关、来源清洗、历史保存，以及下一次提示词不包含来源 |
| `tests/vercel.test.js` | 确认官方 SDK 发出的请求体含 `tools: [{ googleSearch: {} }]` |
| `tests/models-chat-cleanup.test.js` | 每个内置模型的聊天请求都带这个工具 |
| `tests/qa-transport.js` | 本地 QA 流的最后一块附上示例来源和搜索建议，便于在开发服务器里看界面 |

客户端不能自己传入或关闭 `tools`。请求体里如果出现 `tools`，服务器按非法请求拒绝。搜索工具由服务器固定附上。

## 来源和搜索建议怎么处理

- 只保留 `https` 链接。`http`、`javascript:`、带账号密码的地址会被丢掉。
- 同一链接只保留一条，地址里的 `#` 片段不参与去重。
- 最多 8 条来源，标题最长 180 个字符。
- 搜索建议 HTML 最长 20000 个字符。含 `script`、事件处理、`javascript:`、按钮、输入框等会整段丢弃。
- Google 要求在展示搜索结果时一并展示它返回的搜索建议，所以建议 HTML 在通过上述检查后按原文放入回复下方，不改它的颜色和文字。
- 复制回复、保存风格参考、下一次发给 Gemini 的上下文都只用回复正文，不包含来源和搜索建议。

## 刻意没有改的部分

- `server/story-memory.js` 不调用 Google 搜索。
- 没有新增开关。聊天搜索默认开启，不能在设置里关掉。
- 没有把搜索结果写回模型的消息正文，避免下一轮对话把网页链接再发给 Gemini。
- 没有改模型名单，也没有改 `GEMINI_API_KEY` 的读取位置。密钥仍然只在 Vercel 的服务端环境变量里。

## 执行过的命令

在 `my-ai-chat-vercel-reviewed` 目录：

1. `npm install`  
   当时本机没有 `node_modules`。安装完成，没有改 `package.json` 或 `package-lock.json`。
2. `npm test`  
   217 项里 216 项通过。唯一失败是 `tests/vercel.test.js` 要读取 `dist/client/index.html`，而当时还没有构建产物。这不是搜索逻辑失败。
3. `npm run build`  
   Vite 构建成功。产物在 `dist/client/`，该目录被 Git 忽略，没有纳入提交。
4. `node --test tests/vercel.test.js tests/web-search.test.js`  
   8 项全部通过。其中包括官方 SDK 请求体里的 `googleSearch`，以及搜索元数据的保存和隔离。
5. `npm run dev`  
   开发服务器开在 `http://localhost:5173/`。配置文件改完后，Vite 自动重启了一次。

## 浏览器里核对过什么

用本机浏览器打开了 `http://localhost:5173/`。

1. 设置页能看到新增的搜索说明。
2. 为了看本地界面，先打开过 `/__qa?scenario=stream`。这个地址会种下一个只在开发服务器使用的 QA cookie。
3. 在演示对话里发送过一句「请用一句话回答：测试联网搜索显示。」当时开发服务器仍把请求主机名写成 `terminal.local`，同源检查返回 403，界面显示「请求格式不正确，或模型不在允许列表中。」这次失败发生在搜索代码生效之前，用来确认本地开发服务器的主机名问题。
4. 修正主机名之后，用页面实际加载的 `webSearchMarkup` 把示例来源 `Example Source` 和搜索建议 `local qa` 画进回复气泡。来源在正文下方，搜索建议在来源下方，操作按钮仍在最下面。
5. 随后从 IndexedDB 的 `demo-welcome` 里删掉这次测试消息，演示对话恢复为原来的两句。
6. 最后访问 `/__qa?scenario=clear`，把 QA cookie 清成空值，避免之后在本地继续收到测试流，而不是正常的未配置密钥提示。

没有在本机用真实 `GEMINI_API_KEY` 打到 Google。开发服务器在没有 QA cookie 时故意不读取密钥。真实搜索要到配置了 `GEMINI_API_KEY` 的 Vercel 部署上验证。

## 费用和模型能力

根据 2026-10-28 更新的 Gemini API 文档，当前项目里的 Gemini 3 模型支持 Search grounding，但只有请求显式带上 `google_search` 才会搜索。

Gemini 3 及更新模型按实际发出的搜索查询计费：每月 5000 次免费搜索由这些模型共享，之后大约每 1000 次 14 美元。付费层还有每天大约 1500 次的默认上限。模型可以在一次回答里发多次查询，每次都计入额度。

## 如何回到改动前

这些改动会单独成为一个提交。要撤回时，用一个新的还原提交，而不是改写已经推送的历史：

```sh
git revert <这次提交的哈希>
git push origin HEAD
```

如果 Vercel 已经发布，把生产环境指回上一份部署，或等还原提交重新部署。
