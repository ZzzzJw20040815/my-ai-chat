# 2026-10-30 联网搜索加固总结

这份文档给不能直接翻完仓库的审查者使用。它描述分支 `fix/web-search-hardening` 相对 `main` 提交 `23cfe23`（PR #19，第一次加入 Gemini 联网搜索）的改动。运行代码停在 `39fcefc`。

工作目录是 `my-ai-chat-vercel-reviewed/`。下面的路径都相对这个目录。

## 发布状态

- 分支：`fix/web-search-hardening`
- Pull Request：https://github.com/ZzzzJw20040815/my-ai-chat/pull/20
- 没有合并到 `main`。
- 没有部署 Vercel 生产环境。生产站点仍是 `23cfe23`：https://my-ai-chat-wkq90nzki-indercrichton-5491.vercel.app
- 生产别名：https://my-ai-chat-phi-taupe.vercel.app 、https://my-ai-chat-indercrichton-5491.vercel.app
- 生产站没有「联网搜索」开关。开关只在本分支的设置对话框里，文案是「联网搜索（可能产生 Google 搜索费用）」。

## 结论

在 PR #19 的搜索能力上，当前代码的行为是：

1. 设置 `webSearch` 为 `'on' | 'off'`，默认 `'on'`。写正文（`storyRuntime.mode === 'writing'`）时不附 `googleSearch`。构思（`setup`）和普通聊天在开关开启时附上。客户端仍不能传 `tools`。
2. 服务端只检查搜索建议是字符串且不超过 20000 字符，通过后原样放进 `done.searchSuggestionHtml`。不是字符串、空字符串或超长就丢掉。服务端不做 HTML 清理，`jsdom` 在 `devDependencies`。
3. 浏览器在 `storedWebSearchFields`（保存或备份规范化）和 `mountSearchSuggestion`（显示前）各做一次 DOMPurify 白名单清理。清理之后去掉 `@import` 和非 https 的 `url(...)`。宿主 `.search-suggestion-host` 带 `contain: paint` 和 `overflow: hidden`。
4. 备份 V1 经 `storedChat` 共用 `shared/web-search.js`。旧备份缺搜索字段仍可导入。设置码仍是 `MAICFG1.`。非法的 `webSearch` 会让整份设置码被拒绝；缺失或本地旧设置里的非法值回到 `'on'`。
5. IndexedDB 仍是版本 4。`upgradeneeded` 按 `oldVersion` 从 v0 逐级建 `chats`、`assets`、`storyMemories`、`styleReferences`。`chats` 的 `updatedAt` 和 `demo` 都是 v1（`45411d2`）一起加入的。任务 C 核对历史后没有改升级逻辑。
6. `npm run verify` 是 `npm run build && npm test`。`dev/qa-transport.js` 只给 Vite 开发服务器用。
7. System Instruction 的优先级问题和 `app.js` 拆分只写了方案，没有改运行代码。
8. 用 `http://localhost:5173` 打开开发服务器时，`/api/chat` 用 `req.headers.host` 构造请求 URL，同源请求不会因为主机名返回 403。没有密钥时返回 503 `KEY_MISSING`。`terminal.local` 只出现在 `/__qa` 的查询解析和 `allowedHosts` 里。

## 没有放松的约束

- `GEMINI_API_KEY` 只在 `api/chat.js`、`api/models.js`、`api/story-memory.js` 读取 `process.env`。前端构建产物里不能出现这个名字，也不能出现 `jsdom`。
- `/api/chat` 和 `/api/story-memory` 的请求字段白名单没有加 `tools`。客户端自己传 `tools` 会得到 `INVALID_REQUEST`。
- `contextFor` 仍只把当前可见分支上 `status === 'complete'` 的回复送进后续上下文。`continue_incomplete` 那一次请求的例外还在 `ui/state.js`。
- IndexedDB 的 `CHAT_DB_VERSION` 仍是 4。备份格式仍是 V1。设置码仍是 `MAICFG1.` / version 1。
- 新增的设置控件文案是简体中文。联网搜索开关的点击区域是 44×44。设置对话框仍然只有 `.settings-card` 一个纵向滚动区。
- 8 个内置模型仍不把 temperature 等采样参数发给服务器。

## 提交

分支从 `23cfe23` 拉出。按时间从早到晚：

| 提交 | 说明 |
| --- | --- |
| `569c5f3` | 任务 1：搜索开关，写正文时不搜索 |
| `3da0020` | 任务 2：DOMPurify 白名单和 Shadow DOM |
| `e7677e3` | 任务 3：备份导入导出清理搜索字段 |
| `0218c37` | 任务 4：缺少构建产物时明确失败，并增加 `verify` |
| `cb710ea` | 任务 5：重写 README，改正 Vite 注释 |
| `c265ac8` | 任务 6：更新 `docs/PROJECT_CONTEXT.md` |
| `5a7be32` | 任务 7：IndexedDB 按版本号逐级升级 |
| `3202c32` | 任务 8：把 `qa-transport.js` 移到 `dev/` |
| `a09052d` | 任务 8：改 Vite 导入路径，并让生产包测试拒绝 QA 样例句子 |
| `859c020` | 任务 9：只新增 system instruction 样例文档 |
| `0bb83a0` | 任务 10：只新增 `app.js` 拆分计划 |
| `9b18ca2` | 任务 2 的修复：补回 `updateMessage`。它的时间是 04:19:20，在任务 10 之后，没有改写已有提交 |
| `95e2abe` | 任务 A：服务端原样转发搜索建议，`jsdom` 回到 devDependencies |
| `c94f86a` | 任务 B：宿主 `contain: paint`，并去掉 `@import` 与非 https 的 `url()` |
| `a6c2c8f` | 任务 D：改正项目地图里关于本地 `/api/chat` 返回 403 的说法 |
| `4cb9df9` | 任务 E：按 `a6c2c8f` 改正项目地图，并提交本审查总结 |
| `b608f82` | 任务 F：v2、v3 升级测试按历史带上 `chats` 的 `updatedAt` 和 `demo` |
| `39fcefc` | 修复联网搜索开关：iPhone 一次点击里的第二次 click 被丢掉，开关有分开的开/关外观 |

任务 C 没有提交。`git log -p -- ui/storage.js` 显示 v1 到 v3 的存储区与当前逐级升级一致，不需要给已有存储区补索引。

任务 8 被拆成两次提交。看 diff 时以整段分支相对 `23cfe23` 为准。

## 任务 A

`server/chat.js` 不再导入 `jsdom`。`publicGrounding` 调用 `passThroughSearchSuggestionHtml`：不是字符串或长度大于 20000 就返回 `null`，否则返回原字符串。空字符串是假值，不会写进 `done`。

`package.json` 把 `jsdom@26.1.0` 放回 `devDependencies`。`package-lock.json` 把 `jsdom` 及其只被它使用的依赖标成 `dev: true`。`server/` 和 `api/` 的运行代码不再出现 `jsdom`。`dist/client/assets` 下的 js 也不含 `jsdom`。

浏览器保存和显示前的清理保持不变。

## 任务 B

`mountSearchSuggestion` 在 `attachShadow` 之前对宿主设置 `contain: paint` 和 `overflow: hidden`。`ui/styles.css` 的 `.search-suggestion-host` 写了同样的两条声明。

`sanitizeSearchSuggestionHtml` 在 DOMPurify 和链接处理之后，去掉 `<style>` 文本和 `style` 属性中的 `@import`，以及不是 https、或带用户名或密码的 `url(...)`。Google 正常样例没有这些写法，可见文字、颜色、链接和 SVG 不变。

## 任务 C

各版本的真实定义：

| 版本 | 提交 | 定义 |
| --- | --- | --- |
| v1 | `45411d2258f36cd1e7aa7b8b151a59146231886f` | `chats`，`keyPath: id`。索引 `updatedAt` 和 `demo` 都在这一版加入 |
| v2 | `46882287ee261462f7615698e20fab90c136ed8f` | 同上的 `chats`。新增 `assets`，`keyPath: id`，没有索引 |
| v3 | `4eed4010651472baa3cc0f001fe5ec316bf1733d` | 再加 `storyMemories`，索引 `chatId`、`anchorId`、`updatedAt` |
| v4 | `762c6e569de9ac8b4ecc6402fd8c40ebb9559902` | 再加 `styleReferences`，索引 `createdAt`，以及唯一的 `sourceVariantId` |

真实旧库从 v1 起就有 `chats` 的两个索引。当前 `oldVersion < 1` 时才创建它们，从 v1、v2、v3 升级时不会删掉已有索引。

## 任务 D

`vite.config.js` 第 27–30 行：

```js
const request = new Request(new URL('/api/chat', `http://${req.headers.host || 'localhost'}`), {
  method: req.method, headers: req.headers, signal: abort.signal,
  ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
});
```

已有的 `npm run dev` 在 `http://localhost:5173` 上验证：打开页面返回 200。带 `Origin: http://localhost:5173` 和 `Sec-Fetch-Site: same-origin` 的合法 `POST /api/chat` 返回 503 `KEY_MISSING`。改成跨源 `Origin` 且 `Sec-Fetch-Site: cross-site` 仍返回 403。这次没有改运行代码，只改正了 `docs/PROJECT_CONTEXT.md`。`README.md` 里没有那条过时说法。

## 联网搜索开关

`39fcefc`：开关包在 `<label>` 里。iPhone Safari 对这种复选框一次点击会送出两次 `click`，第二次把刚关掉的状态又打开，所以界面看起来没变，`localStorage` 里的 `webSearch` 也会留在 `'on'`。第二次 `click` 现在会被取消，并把勾选状态拨回已保存的值。开关改成 `appearance: none`，未选中时圆点在左、选中时圆点在右且边框用强调色，点击区域是 44×44。采样开关是同一结构，内置模型上它是禁用的；启用时也丢掉同一次点击里的第二次 `click`。

## 测试

在 `b608f82` 上执行 `npm run verify`：构建成功，随后 `npm test` 为 228 项通过、0 项失败。`39fcefc` 新增 `tests/web-search-toggle.test.js` 一项，完整验证应为 229 项通过、0 项失败。产物文件名会随前端源码变化。这些文件被 gitignore。

任务 A 起新增或扩充的断言在：

- `tests/web-search.test.js`：服务端原样传出建议；20000 字符保留；超长、数字和对象丢掉。
- `tests/vercel.test.js`：构建出的 js 不含 `jsdom`。
- `tests/search-suggestion.test.js`：`@import` 和 `http` 的 `url()` 被去掉；`position: fixed` 的样例留在带 `contain: paint` 的宿主里。

更早的测试文件仍在：`tests/web-search.test.js`、`tests/search-suggestion-sample.js`、`tests/search-suggestion.test.js`、`tests/web-search-backup.test.js`、`tests/indexeddb-upgrade.test.js`。

## 审查时不要误判的点

- 设置码遇到非法 `webSearch` 会拒绝整份码。缺失字段和本地旧设置里的非法值才会回到 `'on'`。
- 服务端不再清理搜索建议 HTML，也不再依赖 `jsdom`。白名单、链接属性和 CSS `url()` 过滤都在浏览器。
- 搜索建议链接在浏览器清理后会变成 `target="_blank"`。这是清理规则，不是服务端改写。
- `9b18ca2` 在时间上晚于 `0bb83a0`。不要把它插到任务 2 和任务 3 之间理解。
- 本地 `/api/chat` 不再固定写成 `http://terminal.local:4173`。
