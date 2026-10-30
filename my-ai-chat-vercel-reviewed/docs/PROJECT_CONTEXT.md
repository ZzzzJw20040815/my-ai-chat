# My AI Chat 项目地图

本文描述 `fix/web-search-hardening` 上的当前代码。起点是 `main` 的 `23cfe23`（PR #19，Gemini 联网搜索），并包含本分支已提交的加固。路径相对 `my-ai-chat-vercel-reviewed/`。

这是浏览器端聊天应用：Vite 打包静态页，Vercel Node Function 持有 `GEMINI_API_KEY` 并调用 `@google/genai`。聊天、故事记忆、风格参考和壁纸存在本机 IndexedDB；全局设置存在 `localStorage`。没有登录、服务端数据库或云同步。

## 1. 目录树

| 路径 | 职责 |
| --- | --- |
| `.gitignore` | 忽略 `dist/`、`node_modules/`、`.env`、`.env.*`，保留 `!.env.example`。仓库里没有 `.env.example` |
| `README.md` | 部署与架构说明。多处与代码不一致，见第 10 节 |
| `package.json` | 包名、scripts、Node 引擎、依赖版本 |
| `package-lock.json` | npm 锁文件 |
| `vercel.json` | 构建命令、静态目录、三个 Function 的时长与取消开关 |
| `vite.config.js` | Vite 根目录、产物目录、仅开发环境存在的 `/api/chat` 与 `/__qa` 中间件 |
| `api/chat.js` | `POST /api/chat` 入口，只把 `process.env.GEMINI_API_KEY` 交给 `handleChat` |
| `api/models.js` | `GET /api/models` 入口，同样只传递密钥 |
| `api/story-memory.js` | `POST /api/story-memory` 入口，同样只传递密钥 |
| `server/chat.js` | 校验聊天请求、调用 Gemini 流式接口、把块转成 SSE |
| `server/model-catalog.js` | 向 Gemini 列模型、过滤非聊天模型、15 分钟服务端缓存 |
| `server/story-memory.js` | 校验故事记忆请求，最多 3 次模型调用后返回 JSON |
| `shared/models.js` | 8 个内置 Gemini 模型、ID 规则、发现模型的归一化 |
| `shared/settings.js` | 全局设置默认值、枚举和 `normalizeGlobalSettings` |
| `shared/response-quality.js` | 风格参考预算、重新生成原因、对应 system instruction |
| `shared/story-memory.js` | 故事记忆 JSON schema、校验、规范化、注入 system instruction |
| `shared/story-memory-transport.js` | 故事记忆请求的消息数、字符数和分块预算 |
| `shared/story-runtime.js` | 故事模式、稳定度、动作，以及附加到 system instruction 的策略文本 |
| `shared/web-search.js` | Google 搜索工具、来源清洗、搜索建议的 DOMPurify 白名单，以及 Shadow DOM 挂载 |
| `ui/index.html` | 页面骨架：侧栏、对话、输入框、设置对话框 |
| `ui/app.js` | 前端主程序。无 export，由 `index.html` 以 module 加载 |
| `ui/styles.css` | 全部界面样式，含玻璃拟态、移动端密度和字号 |
| `ui/state.js` | 内存中的 chat/message/variant 与可见分支 |
| `ui/storage.js` | IndexedDB 版本 4 及四个 object store |
| `ui/storage-persistence.js` | 查询或请求浏览器持久化存储 |
| `ui/stream.js` | 解析 SSE / NDJSON |
| `ui/markdown.js` | Markdown 渲染并消毒 |
| `ui/settings.js` | 读写 `localStorage` 中的全局设置，并裁成请求字段 |
| `ui/settings-code.js` | 设置码 `MAICFG1.` 的导出与导入 |
| `ui/model-catalog.js` | 浏览器侧模型目录缓存，24 小时后自动刷新 |
| `ui/backup.js` | 备份 V1 的导出、校验与按 `updatedAt` 合并 |
| `ui/demo.js` | 唯一演示对话的两条消息 |
| `ui/icons.js` | 内联 SVG 字符串 |
| `ui/mobile-display.js` | 把密度和字号写到 `<html>` 的 data 属性 |
| `ui/mobile-sheet.js` | 按 visual viewport 定位底部菜单 |
| `ui/scroll-position.js` | 滚到底部按钮与流式跟随的距离阈值 |
| `ui/story-memory.js` | 决定哪段分支需要更新记忆、如何分块请求 |
| `ui/story-panel.js` | 把记忆对象收成面板可显示的字段 |
| `ui/story-runtime.js` | 根据可见分支上最深的 transition 计算当前模式 |
| `ui/wallpaper.js` | 壁纸类型、25 MB 上限、解码与铺到主面板 |
| `tests/web-search.test.js` | 搜索开关、正文模式不搜索、来源清洗、上下文不带回网页 |
| `tests/web-search-backup.test.js` | 备份往返保留来源；恶意 HTML 和 http 链接被丢掉；旧备份仍可导入 |
| `tests/search-suggestion-sample.js` | 接近 Gemini `renderedContent` 的搜索建议样例，不是测试入口 |
| `tests/search-suggestion.test.js` | DOMPurify 白名单和 Shadow DOM 样式隔离 |
| `dev/qa-transport.js` | 只给 Vite 开发服务器用的假 Gemini 流。生产构建不打包它 |
| `tests/phase2.test.js` | 聊天传输、错误消毒、Markdown |
| `tests/persistence.test.js` | IndexedDB 建库、演示数据迁移、部分回复不进上下文 |
| `tests/vercel.test.js` | Vercel Function 与 SDK 请求体、Stop 信号、构建产物不含密钥 |
| `tests/settings.test.js` | 设置归一化与服务器生成参数 |
| `tests/settings-code.test.js` | 设置码往返与拒绝规则 |
| `tests/safety-settings.test.js` | 五档安全阈值与拦截文案 |
| `tests/models-chat-cleanup.test.js` | 8 个模型 ID 与能力 |
| `tests/model-catalog.test.js` | 模型发现、缓存与伪造 ID |
| `tests/app-persistence.test.js` | 用 jsdom 跑真实 `app.js` 的持久化与分支 |
| `tests/data-safety.test.js` | 备份导出、合并与导入 |
| `tests/response-variants.test.js` | 标题、单回复与可见分支 |
| `tests/response-quality.test.js` | 风格参考库与重新生成原因 |
| `tests/user-turn-branching.test.js` | 用户消息分支与选择字段 |
| `tests/story-memory.test.js` | 记忆提取、分块、修复与端点 |
| `tests/story-panel.test.js` | 记忆面板只显示已建立事实 |
| `tests/story-runtime.test.js` | 故事模式状态机与策略文本 |
| `tests/scroll-position.test.js` | 滚动跟随与按钮显隐 |
| `tests/wallpaper.test.js` | 壁纸校验与 assets store |
| `tests/glass-ui.test.js` | 玻璃样式与单滚动容器 |
| `tests/mobile-display-settings.test.js` | 手机密度、字号、触控尺寸 |
| `tests/mobile-story-stability.test.js` | 窄屏故事菜单、编辑框与错误文案 |

## 2. 运行与构建

`package.json` 版本 `2.0.0`，`"type": "module"`，`"engines.node": ">=22"`。

scripts：

| script | 命令 |
| --- | --- |
| `dev` | `vite` |
| `build` | `vite build` |
| `test` | `node --test tests/*.test.js` |

依赖：

| 包 | 版本 | 范围 |
| --- | --- | --- |
| `@google/genai` | 2.21.0 | dependencies |
| `marked` | 18.0.11 | dependencies |
| `dompurify` | 3.4.15 | dependencies |
| `vite` | 8.0.13 | devDependencies |
| `jsdom` | 26.1.0 | devDependencies |
| `fake-indexeddb` | 6.2.4 | devDependencies |

`vite.config.js`：`root` 是 `ui`，`build.outDir` 是 `../dist/client`，`emptyOutDir: true`。开发服务器 `host: '0.0.0.0'`，`allowedHosts: ['terminal.local']`。插件 `no-key-server-preview` 只在 `vite dev` 里挂上：

- `GET /__qa?scenario=` 设置 cookie `phase2_qa`，合法值是 `stream`、`slow`、`429`、`network`、`model`、`server`。
- `POST /api/chat` 被改写成 `Request('http://terminal.local:4173/api/chat')`。有合法 cookie 时用 `qaTransport` 和假密钥；否则 `handleChat(request, {})`，不读本机环境变量。

`vercel.json`：

- `buildCommand`: `npm run build`
- `outputDirectory`: `dist/client`
- `api/chat.js`：`maxDuration` 120，`supportsCancellation: true`
- `api/models.js`：`maxDuration` 30
- `api/story-memory.js`：`maxDuration` 90，`supportsCancellation: true`

环境变量只有 `GEMINI_API_KEY`。读取点是三个 `api/*.js` 的 `process.env.GEMINI_API_KEY`。没有 `VITE_` 变量。`.gitignore` 忽略 `.env` 与 `.env.*`。

浏览器另有这些 `localStorage` 键，不是服务端环境变量：

| 键 | 模块 |
| --- | --- |
| `my-ai-chat-global-settings` | `shared/settings.js` |
| `my-ai-chat-theme` | `ui/app.js`，值为 `dark` 或 `light` |
| `my-ai-chat-active-chat-id` | `ui/app.js` |
| `my-ai-chat-model-catalog` | `ui/model-catalog.js` |
| `my-ai-chat-last-model-catalog-sync` | `ui/model-catalog.js` |

本地：在 `my-ai-chat-vercel-reviewed` 执行 `npm install`、`npm run dev`、`npm run build`、`npm test`。测试拦截 SDK，不访问 Google。

## 3. 模块导出清单

签名按源码默认参数书写。返回值未写类型注解的，下面按函数实际返回的值说明。生产调用方只列源码 import；测试文件也会 import 同一批符号。

### api/

三个文件都是默认导出 `{ fetch(request) }`，由 Vercel 调用。

| 文件 | 行为 |
| --- | --- |
| `api/chat.js` | `fetch` 调用 `handleChat(request, { GEMINI_API_KEY })` |
| `api/models.js` | `fetch` 调用 `handleModels(request, { GEMINI_API_KEY })` |
| `api/story-memory.js` | `fetch` 调用 `handleStoryMemory(request, { GEMINI_API_KEY })` |

### server/chat.js

| 导出 | 签名与返回 | 调用方 |
| --- | --- | --- |
| `MAX_BODY_BYTES` | `256 * 1024` | `readPayload` 默认上限 |
| `MAX_MESSAGES` | `100` | `validatePayload` |
| `ERROR_TEXT` | 冻结的错误码到中文文案 | `handleChat` |
| `classifyError(error)` | 返回 `[code, httpStatus]` | `handleChat`；`server/story-memory.js` 也 import |
| `validatePayload(payload, authorizedModel = modelMetadata(payload?.model))` | 成功返回 `{ model, contents, config }`，失败抛 `INVALID_REQUEST` 或 `CONTEXT_LIMIT` | `handleChat`；测试 |
| `validateGenerationSettings(value, modelOrMetadata)` | 返回 Gemini `config` 的子集 | `validatePayload`；`server/story-memory.js` 只拿它校验 `safetySettings` |
| `readPayload(request, maxBytes = MAX_BODY_BYTES)` | 返回解析后的 JSON | `handleChat`；`handleStoryMemory` |
| `googleStream(apiKey, params, signal)` | 返回 `@google/genai` 的 `generateContentStream` | `handleChat` 的默认 transport |
| `handleChat(request, env, transport = googleStream, timeoutMs = 120000, catalogOptions = {})` | 返回 `Response` | `api/chat.js`；`vite.config.js` 的开发中间件 |

`classifyError` 映射：429 → `RATE_LIMIT`/429；401 或 403 → `KEY_INVALID`/502；404 → `MODEL_UNAVAILABLE`/502；400 → `INVALID_REQUEST`/502；`TimeoutError` → `TIMEOUT`/504；`TypeError` → `NETWORK_ERROR`/502；其余 → `SERVER_ERROR`/502。

### server/model-catalog.js

| 导出 | 签名与返回 | 调用方 |
| --- | --- | --- |
| `SERVER_CATALOG_TTL_MS` | `15 * 60 * 1000` | `getServerCatalog` |
| `modelIdFromResource(name)` | `models/` 前缀去掉后，符合 ID 规则则返回字符串，否则 `null` | `isChatModel`、`sanitizeListedModel` |
| `isChatModel(raw)` | 布尔值。排除图片、TTS、embedding、computer-use、deep-research 等，并要求 `supportedActions` 含 `generateContent` | `sanitizeListedModel` |
| `sanitizeListedModel(raw)` | `null` 或 `normalizeDiscoveredModel` 的结果 | `refreshServerCatalog` |
| `googleListModels(apiKey)` | SDK `models.list` | `refreshServerCatalog` 的默认列举函数 |
| `refreshServerCatalog(apiKey, options = {})` | 刷新进程内缓存 | `getServerCatalog` |
| `getServerCatalog(apiKey, options = {})` | `{ models, syncedAt }`，内置模型在前 | `handleModels`、`trustedModelMetadata` |
| `trustedModelMetadata(modelId, apiKey, options = {})` | 内置或刚发现的模型对象，否则 `null` | `handleChat`、`handleStoryMemory` |
| `curatedCatalog()` | 返回 `CURATED_MODELS` | 测试 |
| `resetServerCatalogForTests()` | 清空进程内缓存，返回 `undefined` | 测试 |
| `handleModels(request, env, options = {})` | 返回 `Response` | `api/models.js` |

### server/story-memory.js

再导出 `STORY_MEMORY_MAX_BODY_BYTES`、`STORY_MEMORY_MAX_MESSAGES`。

| 导出 | 签名与返回 | 调用方 |
| --- | --- | --- |
| `STORY_MEMORY_MAX_PROVIDER_CALLS_PER_CHUNK` | `3` | 本文件提取循环 |
| `validateStoryMemoryRequest(payload, authorizedModel)` | `{ model, chatId, anchorId, conversation, existingMemory, safetySettings }` | `handleStoryMemory` |
| `googleExtractStoryMemory(apiKey, params, signal, attempt = 'structured', repair = null)` | SDK `generateContent` | 默认 transport |
| `classifyStoryMemoryProviderError(error)` | 记忆专用错误码 | `handleStoryMemory` |
| `handleStoryMemory(request, env, transport = googleExtractStoryMemory, timeoutMs = 90000, catalogOptions = {})` | 返回 `Response` | `api/story-memory.js` |

`attempt` 只有 `structured`、`repair`、`content-recovery` 三条指令。成功响应是 `{ memory }`。

### shared/models.js

| 导出 | 说明 | 调用方 |
| --- | --- | --- |
| `CURATED_MODELS` | 下面 8 个模型的冻结数组 | `MODELS`、`mergeModelCatalog`、`server/model-catalog.js` |
| `MODELS` | 等于 `CURATED_MODELS` | 测试与设置 UI |
| `DEFAULT_MODEL` | `CURATED_MODELS[0].id`，即 `gemini-3.1-pro-preview` | `createChat`、`storedChat` |
| `modelName(id)` | 内置显示名，否则 `modelDisplayName(id)` | UI |
| `isAllowedModel(id)` | 是否在内置列表 | 目录与测试 |
| `modelMetadata(id)` | 内置对象或 `null` | `validatePayload`、目录 |
| `isPersistableModelId(id)` | `/^gemini-[a-z0-9][a-z0-9.-]{0,99}$/` | 存储、备份、两个端点 |
| `modelDisplayName(id)` | 把 ID 拆成标题大小写 | `modelName`、发现模型 |
| `normalizeDiscoveredModel(value)` | 合法发现模型或 `null`。`safetySettings` 与 `samplingOverrides` 固定为 false，`thinkingLevels` 固定为 `[]` | `mergeModelCatalog`、`sanitizeListedModel` |
| `mergeModelCatalog(discovered = [])` | 内置模型加去重后的发现模型。stable 排在 preview 前 | `ui/model-catalog.js` |

内置 ID：`gemini-3.1-pro-preview`、`gemini-3.8-flash`、`gemini-3.7-flash`、`gemini-3.6-flash`、`gemini-3.5-flash`、`gemini-3-flash-preview`、`gemini-3.5-flash-lite`、`gemini-3.1-flash-lite`。

`curatedCapabilities` 不导出。3.1 Pro、3.8 Flash、3.7 Flash 的 thinking 是 `low|medium|high`。其余五个还有 `minimal`。全部 `samplingOverrides: false`，`safetySettings: true`，`outputTokenLimit: 65536`，`topK: false`。

### shared/settings.js

| 导出 | 值 |
| --- | --- |
| `GLOBAL_SETTINGS_STORAGE_KEY` | `'my-ai-chat-global-settings'` |
| `CONTEXT_LIMITS` | `'all' \| '50' \| '20' \| '10'` |
| `THINKING_LEVELS` | `'default' \| 'minimal' \| 'low' \| 'medium' \| 'high'` |
| `MAX_SYSTEM_INSTRUCTION_LENGTH` | `20000` |
| `MAX_OUTPUT_TOKENS_LIMIT` | `65536` |
| `SAMPLING_LIMITS` | temperature 0–2，topP 0–1，topK 1–1000 |
| `SAFETY_MODES` | `'default' \| 'custom'` |
| `MOBILE_DENSITIES` | `'compact' \| 'standard' \| 'comfortable'` |
| `CHAT_TEXT_SIZES` | `'small' \| 'standard' \| 'large'` |
| `SAFETY_LEVELS` | Off、Block none、Block few、Block some、Block most，对应阈值见第 4 节 |
| `SAFETY_THRESHOLDS` | 上述 `threshold` 字符串 |
| `SAFETY_CATEGORIES` | harassment、hateSpeech、sexuallyExplicit、dangerousContent |
| `DEFAULT_GLOBAL_SETTINGS` | 第 4 节的对象 |
| `normalizeGlobalSettings(value)` | 缺字段或非法字段回到默认值，不抛错 |

调用方：`ui/settings.js`、`ui/backup.js`、`ui/settings-code.js`、`server/chat.js`。

### shared/response-quality.js

| 导出 | 说明 |
| --- | --- |
| `STYLE_REFERENCE_LIMIT` | `5` |
| `STYLE_REFERENCE_TOTAL_CHARACTERS` | `10000`，一次请求里风格样本的总字符预算 |
| `STYLE_REFERENCE_CONTENT_LIMIT` | `50000`，单条存储上限；请求侧仍受总预算约束 |
| `REGENERATION_REASONS` | 六个英文指导句。`try_again` 是空字符串 |
| `REGENERATION_REASON_OPTIONS` | 同上 ID 加中文标签 |
| `isRegenerationReason(value)` | 布尔值 |
| `styleReferenceRequestItems(references, budget = 10000)` | 裁成 `{ id, content }[]` |
| `responseQualitySystemInstruction(baseInstruction, styleReferences = [], regenerationReason = null)` | 返回拼接后的字符串；没有风格也没有有效原因时只返回 trim 后的 base |

`app.js` 用 `styleReferenceRequestItems` 和原因选项。`server/chat.js` 用校验与 system instruction。

### shared/story-memory-transport.js

| 常量 | 值 |
| --- | --- |
| `STORY_MEMORY_MAX_BODY_BYTES` | 256 KiB |
| `STORY_MEMORY_MAX_MESSAGES` | 100 |
| `STORY_MEMORY_MAX_MESSAGE_CHARACTERS` | 50000 |
| `STORY_MEMORY_MAX_TOTAL_CHARACTERS` | 180000 |
| `STORY_MEMORY_SAFE_BODY_BYTES` | 200 KiB |
| `STORY_MEMORY_SAFE_MESSAGES` | 80 |
| `STORY_MEMORY_SAFE_TOTAL_CHARACTERS` | 150000 |
| `STORY_MEMORY_MAX_CHUNKS` | 12 |

调用方是 `ui/story-memory.js` 的分块器和 `server/story-memory.js`。

### shared/story-memory.js

| 导出 | 说明 |
| --- | --- |
| `STORY_MEMORY_SCHEMA_VERSION` | `1` |
| `STORY_MEMORY_MAX_BYTES` | 32 KiB，序列化后上限 |
| `STORY_MEMORY_MAX_STRING` | 800 |
| `STORY_MEMORY_MAX_SUMMARY` | 1600，只用于 `relationship.summary` |
| `STORY_MEMORY_MAX_ARRAY` | 80 |
| `STORY_MEMORY_MAX_CHARACTERS` | 30，角色个数 |
| `STORY_MEMORY_JSON_SCHEMA` | 本地严格 schema |
| `STORY_MEMORY_PROVIDER_JSON_SCHEMA` | 发给 Gemini 的浅 schema |
| `STORY_MEMORY_VALIDATION_REASONS` | 12 个原因字符串 |
| `StoryMemoryValidationError` | `constructor(reason)`，`this.reason` |
| `STORY_MEMORY_CANONICALIZATION_REASONS` | 9 个原因字符串 |
| `StoryMemoryCanonicalizationError` | `constructor(reason, diagnostics)` |
| `normalizeStringArray(value)` | 字符串数组归一化 |
| `canonicalizeStoryMemoryCandidate(value)` | 能修则返回记忆，不能修则抛错 |
| `canonicalizeStoryMemoryCandidateWithDiagnostics(value)` | 同上并带诊断计数 |
| `validateStoryMemory(value)` | 严格校验后的记忆对象 |
| `meaningfulStoryMemoryFieldCount(value)` | 非空事实个数。`unknownOrUnconfirmed` 不算 |
| `hasMeaningfulStoryMemory(value)` | 上述个数大于 0 |
| `storyMemorySystemInstruction(userInstruction, value)` | 把用户指令和记忆 JSON 拼成一段 |

调用方：`server/chat.js`、`server/story-memory.js`、`ui/story-memory.js`、`ui/story-panel.js`。

### shared/story-runtime.js

| 导出 | 说明 |
| --- | --- |
| `STORY_RUNTIME_VERSION` | `1` |
| `STORY_RUNTIME_MODES` | `'setup' \| 'writing'` |
| `STORY_STABILITY_LEVELS` | `'free' \| 'balanced' \| 'strict'` |
| `DEFAULT_STORY_STABILITY` | `'balanced'` |
| `STORY_RUNTIME_ACTIONS` | `prepare_story`、`start_writing`、`continue_story`、`continue_incomplete` |
| `STORY_RUNTIME_TRANSITION_MODES` | 上面两种模式再加 `'disabled'` |
| `STORY_RUNTIME_TRANSITION_ACTIONS` | `prepare_story`、`start_writing`、`exit_story` |
| `isStoryRuntimeMode(value)` / `isStoryRuntimeAction(value)` / `isStoryStability(value)` | 布尔值 |
| `normalizeStoryStability(value)` | 非法值变成 `balanced` |
| `normalizeStoryRuntime(value)` | `{ version, stability, transitions }`。坏的 transition 被丢掉 |
| `validateStoryRuntimeRequest(value)` | `undefined` 得到 `null`；非法抛 `INVALID_REQUEST` |
| `storyRuntimeActionTurn(action)` | `{ role: 'user', parts: [{ text }] }` 或 `null`。`prepare_story` 没有这句话 |
| `storyRuntimeSystemInstruction(base, runtime)` | 在 base 后附加模式、稳定度和当前动作 |

`prepare_story` 只能配 `mode: 'setup'`。`start_writing`、`continue_story`、`continue_incomplete` 只能配 `mode: 'writing'`。

### ui/state.js

| 导出 | 签名与返回 |
| --- | --- |
| `uniqueId(source = crypto)` | UUID 字符串。没有 `randomUUID` 时用 `getRandomValues` |
| `createMessage(role, content = '', model = null)` | 第 4 节的消息。assistant 才写入 `model` |
| `activeAssistantVariant(message)` | 有 `variants` 时返回选中项，否则返回消息自身 |
| `ensureAssistantVariants(message)` | 把旧的单回复收成 `variants[0]`，返回数组 |
| `addAssistantVariant(message, variantMessage)` | 追加并把 `activeVariantId` 指到新项 |
| `assistantVariantById(message, variantId)` | 找到的 variant 或 `null` |
| `assistantVariants(message)` | 数组；非 assistant 得到 `[]` |
| `userChildrenForParent(chat, parentVariantId)` | 同一父 variant 下的 user 消息 |
| `activeUserChild(chat, parentVariantId)` | 选中的子用户消息；没有选中记录时用第一个 |
| `selectUserChild(chat, userId)` | 成功为 true，并写入 `activeRootUserId` 或 `activeChildUserId` |
| `userSiblingTurns(chat, user)` | 同一父级下、排除 runtime-control 的用户消息 |
| `sanitizeUserChildSelections(chat)` | 删掉指不到子节点的选择 |
| `ensureBranchLineage(chat)` | 给缺少 `parentVariantId` / `parentUserId` 的旧线性对话补字段 |
| `visibleConversationPath(chat)` | 从根上的选中用户走到叶子 |
| `visibleAssistantTurn(chat, messageId)` | 可见路径上的那条 assistant，否则 `null` |
| `removeUserDescendants(chat, userId)` | 删掉该用户消息之下的回复和后代，返回被删 ID 的 Set |
| `formatLocalChatTitle(createdAt)` | 本地时间标题 |
| `createChat(model = DEFAULT_MODEL)` | 第 4 节的 chat |
| `contextFor(chat, userId, contextLimit = 'all')` | `{ id, role, content, status }[]`。只含 complete 的可见轮次 |

几乎全部由 `ui/app.js`、`ui/story-memory.js`、`ui/story-runtime.js`、`ui/storage.js` 调用。

`contextFor` 最后只保留四个字段。`stopped`、`error`、`interrupted`、`sending`、`generating` 的 assistant 不会进入结果。`contextLimit` 为 10、20、50 时从尾部截取，并保证结果不以 assistant 开头。

### ui/storage.js

| 导出 | 说明 |
| --- | --- |
| `CHAT_DB_NAME` | `'my-ai-chat'` |
| `CHAT_DB_VERSION` | `4` |
| `CHAT_STORE_NAME` | `'chats'` |
| `ASSET_STORE_NAME` | `'assets'` |
| `STORY_MEMORY_STORE_NAME` | `'storyMemories'` |
| `STYLE_REFERENCE_STORE_NAME` | `'styleReferences'` |
| `WALLPAPER_ASSET_ID` | `'chat-wallpaper'` |
| `CANONICAL_DEMO_ID` | `'demo-welcome'` |
| `openChatDatabase(indexedDBApi = indexedDB)` | 打开或升级数据库 |
| `storedChat(chat)` | 可写入的 chat。会跑 lineage 和选择清理 |
| `loadChats` / `saveChat` / `saveChats` | 读写 chats |
| `loadOrSeedChats(createSeedChats, indexedDBApi)` | 空库写入一条 canonical demo；多条 demo 时收成一条 |
| `deleteChat(chatId)` | 删除聊天及其故事记忆 |
| `loadStoryMemories(chatId = null)` | `chatId` 为空时读全部 |
| `replaceStoryMemorySnapshot(snapshot)` | 同一 chat+anchor 先删后写 |
| `deleteStoryMemoriesByAnchors(chatId, anchorIds)` | 按锚点删除 |
| `deleteStoryMemoriesForChat(chatId)` | 删除该聊天全部记忆 |
| `loadStyleReferences` / `saveStyleReference` / `deleteStyleReference` | 风格参考。保存返回 `{ status: 'saved' \| 'duplicate' \| 'limit', reference }` |
| `loadWallpaperAsset` / `saveWallpaperAsset(file)` / `deleteWallpaperAsset` | 壁纸 Blob |
| `closeChatDatabase()` | 关闭共享连接 |

`loadChats` 给每条记录补上不入库的 `draft: ''` 和 `scrollTop: 0`。

### ui/stream.js

`consumeStream(response, onEvent, signal)`：要求 `text/event-stream` 或 `application/x-ndjson`。事件 `type` 只能是 `start`、`delta`、`done`、`error`。没有终态事件时抛「连接意外中断」。缓冲区超过 300000 字符抛「数据流过大」。调用方是 `app.js` 的 `generate`。

### ui/markdown.js

`renderMarkdown(text, win = window)` 返回 HTML 字符串。`marked` 的原始 HTML 当文本，图片只留 alt。DOMPurify 允许的标签是 `p br h1–h6 strong em del blockquote ul ol li hr pre code table thead tbody tr th td a`。链接只留 `http(s)` 和 `mailto`。调用方是 `messageHtml`。

### ui/settings.js

| 导出 | 行为 |
| --- | --- |
| `loadGlobalSettings(storage = localStorage)` | 解析失败也返回默认设置 |
| `saveGlobalSettings(settings, storage)` | 先归一化再写入，返回归一化结果 |
| `resetGlobalSettings(storage)` | 写回 `DEFAULT_GLOBAL_SETTINGS` |
| `requestSettings(settings, model = null)` | 按模型能力删掉不支持的 thinking、采样、输出上限和自定义安全项 |

`requestSettings` 不包含 `contextLimit`、`mobileDisplay`、`defaultModel`。

### ui/settings-code.js

| 导出 | 说明 |
| --- | --- |
| `SETTINGS_CODE_FORMAT` | `'my-ai-chat-settings'` |
| `SETTINGS_CODE_VERSION` | `1` |
| `SETTINGS_CODE_PREFIX` | `'MAICFG1.'` |
| `MAX_SETTINGS_CODE_LENGTH` | 128 KiB |
| `THEMES` | `'dark' \| 'light'` |
| `SettingsCodeError` | `code` 为 `INVALID` 或 `UNSUPPORTED_VERSION` |
| `createSettingsCode({ settings, theme, now = new Date() })` | 前缀加 Base64URL |
| `parseSettingsCode(input)` | `{ settings, theme }` |

信封字段是 `format`、`version`、`exportedAt`、`globalSettings`、`theme`。`globalSettings` 经过白名单，不含聊天、故事、壁纸和密钥。

### ui/model-catalog.js

| 导出 | 说明 |
| --- | --- |
| `MODEL_CATALOG_STORAGE_KEY` / `MODEL_CATALOG_SYNC_STORAGE_KEY` | 见第 2 节 |
| `MODEL_CATALOG_MAX_AGE_MS` | 24 小时 |
| `availableDefaultModel(modelId, catalog)` | ID 仍在目录中则保留，否则用第一个内置模型 |
| `createModelCatalog({ storage, fetcher, now })` | 返回 `{ models, metadata, syncedAt, load, save, autoRefresh, refresh }` 这一类方法的对象 |

`autoRefresh` 在未过期时不请求。`refresh` 请求 `GET /api/models?refresh=1`。

### ui/backup.js

| 导出 | 说明 |
| --- | --- |
| `BACKUP_FORMAT` | `'my-ai-chat-backup'` |
| `BACKUP_VERSION` | `1` |
| `MAX_BACKUP_BYTES` | 100 MiB |
| `BackupValidationError` | 无额外字段 |
| `createBackup({ chats, settings, activeChatId = null, theme = 'dark', now = new Date() })` | 备份对象。进行中的回复改成 `interrupted` |
| `validateBackup(value)` | 规范化后的备份，版本不是 1 就抛错 |
| `parseBackupText(text)` | `JSON.parse` 后校验 |
| `backupJson(backup)` | 两个空格缩进，末尾换行 |
| `backupFilename(date = new Date())` | `my-ai-chat-backup-YYYY-MM-DD-HHmm.json`，用本地时间 |
| `downloadBackup(backup, dependencies = {})` | 触发 `<a download>`，1 秒后释放 Blob URL |
| `planBackupMerge(localChats, incomingChats)` | `{ writes, chats, added, updated, kept }` |
| `importBackup(backup, dependencies = {})` | 写入较新的聊天和设置，不碰壁纸 |

### ui/story-memory.js

| 导出 | 作用 |
| --- | --- |
| `visibleStoryAnchors(chat)` | 可见路径上可做锚点的 ID |
| `STORY_MEMORY_UPDATE_ERROR_CODES` | 客户端错误码列表 |
| `STORY_MEMORY_ERROR_MESSAGES` | 码到中文 |
| `StoryMemoryUpdateError` | `constructor(code, stage, details)` |
| `classifyStoryMemoryUpdateError(error, stage = 'extraction')` | 稳定错误码 |
| `storyMemoryErrorMessage(code)` | 中文 |
| `currentStoryAnchor(chat)` | 可见路径最后一个可锚点 |
| `allStoryAnchors(chat)` | 全部分支上的锚点 |
| `applicableStoryMemory(chat, snapshots = [])` | 可见路径上最深的一份快照 |
| `storyMemoryConversation(chat)` | 发给提取器的可见消息，去掉 runtime-control |
| `storyMemoryMessagesAfterAnchor(path, anchorId)` | 锚点之后的增量 |
| `storyMemoryUpdatePlan(chat, snapshots = [])` | 要不要请求、从哪段消息提取 |
| `storyMemoryRequestByteLength(payload)` | UTF-8 字节长度 |
| `chunkStoryMemoryMessages({ model, chatId, messages, existingMemory = null, safetySettings })` | 按安全预算切块 |
| `runStoryMemoryUpdate({...})` | 顺序请求全部分块，全部成功才保存 |
| `storySubtreeAnchorIds(chat, userId)` | 某用户子树的锚点 |
| `createStoryMemorySnapshot({ chatId, anchorId, memory, now, id })` | 快照对象 |
| `commitStoryMemoryUpdate(snapshots, snapshot, save)` | 先保存，再替换内存中的同锚点 |
| `memoryStatusText(snapshot, now = Date.now())` | 面板上的更新时间文字 |

`app.js` 的 `updateStoryMemory` 调用 `runStoryMemoryUpdate`。

### ui/story-panel.js

`storyPanelView(snapshot)` 只抽出面板用的地点、时间、角色、衣着、关系、当前状态、重要记忆和未解线索。隐藏 `unknownOrUnconfirmed` 以及角色上的偏好、边界、说话指纹等推断字段。调用方是 `storyPanelHtml` 和故事菜单。

### ui/story-runtime.js

| 导出 | 说明 |
| --- | --- |
| `isRuntimeControlMessage(message)` | user 且 `kind === 'runtime-control'` |
| `RUNTIME_CONTROL_LABELS` | `start_writing`、`continue_story`、`continue_incomplete` 的中文。没有 `prepare_story` 和 `exit_story` |
| `STORY_STABILITY_OPTIONS` | 自由发挥、平衡、严格连续 |
| `runtimeControlLabel(message)` | 有标签才返回字符串，否则 `null` |
| `isVisibleRuntimeControlMessage(message)` | 标签非空 |
| `regenerationRuntimeAction(message)` | 可见控制消息的 `runtimeAction`，否则 `null` |
| `continuationAvailability(chat, generationActive = false)` | `{ action, variant, reason }` |
| `storyRuntimeState(chat)` | `{ enabled, mode, transition }` |
| `storyRuntimeStability(chat)` | 聊天级稳定度 |
| `setStoryRuntimeStability(chat, stability)` | 改稳定度，没变化返回 false |
| `currentRuntimeAnchor(chat)` | 可见叶子的 user id 或当前 assistant variant id |
| `setStoryRuntimeMode(chat, mode, action, anchorId, now)` | 追加一条 transition |
| `createRuntimeControl(action, parentVariantId)` | 空内容的 user 控制消息 |
| `pruneStoryRuntimeTransitions(chat, anchorIds)` | 删掉锚点已不存在的 transition |

`prepare_story` 不产生可见气泡。`exit_story` 也不在 `RUNTIME_CONTROL_LABELS` 里。

### 其余 ui 导出

| 模块 | 导出 |
| --- | --- |
| `ui/demo.js` | `demoData`。只有 `welcome`：标题、副标题、一问一答 |
| `ui/icons.js` | `icons`，值为 SVG 字符串 |
| `ui/mobile-display.js` | `applyMobileDisplayPreferences(settings, root = documentElement)`，设置 `data-density` 与 `data-chat-text` |
| `ui/mobile-sheet.js` | `visualViewportBounds`、`positionMobileSheet(sheet, scrim, window, margin = 10)`、`clearMobileSheetPosition` |
| `ui/scroll-position.js` | 显示阈值 320、隐藏阈值 96、跟随阈值 100；`distanceFromBottom`、`scrollToBottomVisible`、`shouldFollowStreaming`、`scrollConversationToBottom` |
| `ui/storage-persistence.js` | `storagePersistenceStatus(storageManager)` 返回 `{ state: 'unsupported', supported: false }`，或 `{ state: 'persistent' \| 'best-effort', supported: true }`。`requestStoragePersistence` 在可请求时调用 `persist()`，成功为 `persistent`，拒绝或抛错为 `{ state: 'denied', supported: true }` |
| `ui/wallpaper.js` | `WALLPAPER_TYPES` 为 jpeg/png/webp；`MAX_WALLPAPER_BYTES` 为 25 MiB；`validateWallpaperFile`、`decodeWallpaperImage`、`createWallpaperPresenter` |
| `ui/app.js` | 无 export |

`ui/app.js` 约 75 KB，`ui/styles.css` 约 49 KB。二者没有按功能再拆文件。

## 4. 核心数据结构

### chat

`createChat` 的内存对象：

```json
{
  "id": "uuid",
  "title": "New conversation",
  "model": "gemini-3.1-pro-preview",
  "folderId": null,
  "createdAt": "2026-10-29T00:00:00.000Z",
  "updatedAt": "2026-10-29T00:00:00.000Z",
  "group": "Today",
  "messages": [],
  "draft": "",
  "scrollTop": 0,
  "demo": false,
  "titleInitialized": false,
  "storyRuntime": { "version": 1, "stability": "balanced", "transitions": [] }
}
```

入库时 `storedChat` 不写 `draft` 和 `scrollTop`。`group` 只保留 `Yesterday`，其他值写成 `Today`。`titleInitialized === false` 才保持 false，缺省当成 true。`activeRootUserId` 只有合法字符串才写入。

第一条用户消息发送后，`title` 变成 `formatLocalChatTitle(user.createdAt)`，并把 `titleInitialized` 设为 true。已有标题且该标志不是 false 的旧聊天不会被改名。

### message 与 variant

`createMessage('user', 'hello')`：

```json
{
  "id": "uuid",
  "role": "user",
  "content": "hello",
  "createdAt": "2026-10-29T00:00:00.000Z",
  "status": "complete",
  "model": null,
  "feedback": null
}
```

assistant 的 `model` 是模型 ID，`feedback` 后来可以是 `like`、`dislike` 或 `null`。`status` 在界面和备份里使用 `complete`、`sending`、`generating`、`stopped`、`interrupted`、`error`。聊天 API 只接受 `complete`。

可选字段：

| 字段 | 出现位置 |
| --- | --- |
| `updatedAt` | 编辑或状态变化后 |
| `error` | 失败文案 |
| `notice` | 例如输出被截断 |
| `completionReason` | 只持久化 `complete` 或 `max_tokens` |
| `parentUserId` | assistant 指向它回答的 user id |
| `parentVariantId` | user 指向父 assistant variant id；根用户是 `null` |
| `variants` | assistant 的多次回复 |
| `activeVariantId` | 当前显示的 variant id |
| `activeChildUserId` | 这条回复下面选中的下一个 user。有 `variants` 时写在 variant 上，不写在消息上 |
| `kind` | 仅 `'runtime-control'` |
| `runtimeAction` | `prepare_story`、`start_writing`、`continue_story`、`continue_incomplete`。入库时 `content` 被清空 |

variant 与单条 assistant 使用同一套内容字段。`ensureAssistantVariants` 把没有 `variants` 的旧回复收成一项，该项 `id` 等于消息 `id`。

可见路径：根上若有 `activeRootUserId` 就用它，否则用 `parentVariantId === null` 的第一条 user。然后找 `parentUserId` 等于该 user 的 assistant，再按当前 variant 的 `activeChildUserId` 找下一条 user。`ensureBranchLineage` 只给缺少字段的线性旧数据补父子关系，不覆盖已经写明的字段。

### storyMemory

快照：

```json
{
  "id": "uuid",
  "chatId": "chat-uuid",
  "anchorId": "message-or-variant-uuid",
  "schemaVersion": 1,
  "createdAt": "2026-10-29T00:00:00.000Z",
  "updatedAt": "2026-10-29T00:00:00.000Z",
  "memory": {
    "version": 1,
    "scene": {
      "location": null,
      "time": null,
      "presentCharacters": [],
      "relativePositions": [],
      "environmentState": [],
      "importantObjects": []
    },
    "characters": [],
    "relationship": {
      "summary": "",
      "establishedChanges": [],
      "sharedHistory": [],
      "unresolvedTension": []
    },
    "importantEvents": [],
    "knownFacts": [],
    "unknownOrUnconfirmed": [],
    "unresolvedThreads": []
  }
}
```

角色对象的键：`idOrName`、`name`，以及 `identity`、`visualAnchors`、`publicPersona`、`observedDisposition`、`speechFingerprint`、`behavioralTells`、`knownPreferences`、`knownBoundaries`、`currentState`、`currentClothing`、`relationshipToProtagonist`。前两个是字符串，其余是字符串数组。

适用规则：在可见路径上找锚点最深的快照。切换 variant 或用户分支后，兄弟分支的快照还在库里，但不再适用。

### styleReference

```json
{
  "id": "uuid",
  "content": "被保存的回复正文",
  "createdAt": "2026-10-29T00:00:00.000Z",
  "sourceModel": "gemini-3.1-pro-preview",
  "sourceChatId": "chat-uuid",
  "sourceAssistantTurnId": "assistant-message-uuid",
  "sourceVariantId": "variant-uuid"
}
```

`sourceVariantId` 唯一。同一 variant 再保存得到 `duplicate`。已有 5 条时得到 `limit`。备份不包含这些记录。

### settings

`DEFAULT_GLOBAL_SETTINGS`：

```json
{
  "defaultModel": "gemini-3.1-pro-preview",
  "systemInstruction": "",
  "contextLimit": "all",
  "maxOutputTokens": null,
  "thinkingLevel": "default",
  "samplingOverrides": { "enabled": false, "temperature": 1, "topP": 0.95, "topK": 40 },
  "safetySettings": {
    "mode": "default",
    "harassment": "BLOCK_MEDIUM_AND_ABOVE",
    "hateSpeech": "BLOCK_MEDIUM_AND_ABOVE",
    "sexuallyExplicit": "BLOCK_MEDIUM_AND_ABOVE",
    "dangerousContent": "BLOCK_MEDIUM_AND_ABOVE"
  },
  "mobileDisplay": { "density": "standard", "chatTextSize": "standard" },
  "webSearch": "on"
}
```

安全阈值还有 `OFF`、`BLOCK_NONE`、`BLOCK_ONLY_HIGH`、`BLOCK_LOW_AND_ABOVE`。`requestSettings` 发给服务器的对象没有 `defaultModel`、`contextLimit`、`mobileDisplay`，但包含 `webSearch`（`on` 或 `off`）。内置模型的 `samplingOverrides.enabled` 会被收成 false，因为能力标志是 false。采样数值仍保存在设置和设置码里，只是当前不会发给这 8 个内置模型。

### storyRuntime

```json
{
  "version": 1,
  "stability": "balanced",
  "transitions": [
    {
      "id": "uuid",
      "anchorId": "variant-or-user-uuid",
      "mode": "setup",
      "action": "prepare_story",
      "createdAt": "2026-10-29T00:00:00.000Z"
    }
  ]
}
```

`mode` 为 `setup`、`writing` 或 `disabled`。`action` 为 `prepare_story`、`start_writing` 或 `exit_story`。稳定度在整份 `storyRuntime` 上，不在单条 transition 上。

## 5. API 契约

三个端点都要求同源：`Origin` 若存在必须等于请求 URL 的 origin，且 `sec-fetch-site` 不能是 `cross-site`，否则 403。错误 JSON 都是 `{ "error": { "code", "message" } }`，并带 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`。

### POST /api/chat

请求白名单：`model`、`messages`、`settings`、`storyMemory`、`styleReferences`、`regenerationReason`、`storyRuntime`。多一个键即 `INVALID_REQUEST`。

`messages` 必须 user/assistant 交替，最后一条的角色在映射前是 user。每条只认可 `id`、`role`、`content`、`status`。`status` 必须是 `complete`。`id` 最长 100。单条内容最长 50000，合计最长 150000，条数最多 100。请求体超过 `MAX_BODY_BYTES`（256 KiB）为 `CONTEXT_LIMIT`。

`settings` 白名单：`systemInstruction`、`maxOutputTokens`、`thinkingLevel`、`samplingOverrides`、`safetySettings`。`samplingOverrides` 只在模型 `samplingOverrides === true` 时可以 `enabled: true`；当前 8 个内置模型都不是。`safetySettings.mode === 'custom'` 时四个类别都必须是合法阈值。

`styleReferences` 最多 5 条，每条只能有 `id` 和 `content`，合计最长 10000。`regenerationReason` 只能是第 3 节的六个 ID。`storyRuntime` 只能有 `mode`、`stability`、`action`。

成功时 HTTP 200，`Content-Type: text/event-stream`。每行 `data: {json}\n\n`：

```json
{ "type": "start" }
{ "type": "delta", "text": "增量文本" }
{ "type": "done", "notice": null, "completionReason": "complete", "webSources": [{ "title": "UEFA", "url": "https://www.uefa.com/euro2024/" }], "searchSuggestionHtml": "<div>...</div>" }
{ "type": "error", "code": "RATE_LIMIT", "message": "中文说明" }
```

`webSources` 和 `searchSuggestionHtml` 只在清理后仍有内容时出现。来源最多 8 条，只要 `https`，标题最长 180 字符。搜索建议先按 DOMPurify 白名单清理（`style`、`div`、`span`、`a`、`svg` 及相关子元素和 `class`），链接只留 `https`，并写成 `target="_blank"` 与 `rel="noopener noreferrer"`。浏览器保存时清一次，挂到 Shadow DOM 显示前再清一次。

`config.tools` 为 `[{ googleSearch: {} }]` 的条件是：`settings.webSearch !== 'off'`（缺省视为开启），并且没有 `storyRuntime` 或 `storyRuntime.mode !== 'writing'`。构思 `setup` 可以搜索。`start_writing`、`continue_story`、`continue_incomplete` 都不附工具。请求体里的 `tools` 仍然非法。

`completionReason` 为 `complete` 或 `max_tokens`。截断时 `notice` 是 `ERROR_TEXT.TRUNCATED`。流开始后的失败也走 `type: error`，不再改 HTTP 状态。文本超过 100000 字符会中止并报 `CONTEXT_LIMIT`。`finishReason` 不是 `STOP` 或 `MAX_TOKENS`，或完全没有文本，报 `BLOCKED`。

未开流时的 HTTP：405 非 POST，403 跨源，415 非 JSON，400 非法，413 过长，503 无密钥，502 模型不可用或发现模型时的目录失败。超时默认 120000 ms，SSE 码为 `TIMEOUT`。

聊天错误码：`KEY_MISSING`、`KEY_INVALID`、`RATE_LIMIT`、`MODEL_UNAVAILABLE`、`NETWORK_ERROR`、`SERVER_ERROR`、`INVALID_REQUEST`、`CONTEXT_LIMIT`、`TIMEOUT`、`BLOCKED`、`SAFETY_BLOCKED`。`TRUNCATED` 只出现在 `done.notice`，不是 `error.code`。

### POST /api/story-memory

白名单：`model`、`chatId`、`anchorId`、`messages`、`existingMemory`、`safetySettings`。

消息允许 `complete`、`stopped`、`interrupted`、`error`，必须有可解析的 `createdAt`。`id`、`chatId`、`anchorId` 最长 256，且 `anchorId` 必须出现在 `messages` 里。条数最多 100，单条 50000，合计 180000，体 256 KiB。

成功：`{ "memory": { ...schema version 1... } }`。空记忆或无法修复时不返回 200。每块最多 3 次模型调用。超时默认 90000 ms。

| 码 | 常见 HTTP |
| --- | --- |
| `INVALID_REQUEST` | 405、403、415、400 |
| `CONTEXT_LIMIT` | 413 |
| `KEY_MISSING` | 503 |
| `MODEL_UNAVAILABLE` | 502 |
| `MEMORY_REQUEST_REJECTED` | 502 |
| `MEMORY_INVALID` | 502 |
| `MEMORY_EMPTY` | 502 |
| `MEMORY_SAFETY_BLOCKED` | 502 |
| `MEMORY_OUTPUT_TRUNCATED` | 502 |
| `MEMORY_PROVIDER_STOPPED` | 502 |
| `RATE_LIMIT` | 429 |
| `NETWORK_ERROR` | 502 |
| `TIMEOUT` | 504 |
| `SERVER_ERROR` | 502 |

文案是英文，写明保留上一份记忆。浏览器再映射成 `ui/story-memory.js` 的中文。

### GET /api/models

只允许没有查询，或恰好 `?refresh=1`。其他查询 400。非 GET 为 405。

成功：`{ "models": [ ...内置模型, ...发现模型 ], "syncedAt": "<ISO 时间>" }`，`Cache-Control: private, no-store`。无密钥 503 `KEY_MISSING`。列举失败 502 `CATALOG_UNAVAILABLE`。发现模型不会打开自定义安全设置或采样覆盖。

## 6. 持久化

数据库 `my-ai-chat`，版本 4。`openChatDatabase` 在一次 `upgradeneeded` 里按 `event.oldVersion` 逐级补齐：v0→v1 创建 `chats`，v1→v2 创建 `assets`，v2→v3 创建 `storyMemories`，v3→v4 创建 `styleReferences`。最终存储区和索引与下表一致，已有记录不重建。

| store | keyPath | 索引 |
| --- | --- | --- |
| `chats` | `id` | `updatedAt`，`demo` |
| `assets` | `id` | 无 |
| `storyMemories` | `id` | `chatId`，`anchorId`，`updatedAt` |
| `styleReferences` | `id` | `createdAt`；`sourceVariantId` 唯一 |

测试说明的历史是：v2 增加 `assets` 且不重建 chats；v3 在 v2 上增加 `storyMemories`；v4 在保留 chats、assets、storyMemories 的同时增加 `styleReferences`。当前实现没有 `switch (oldVersion)`，所以上述历史靠测试和“不存在才创建”共同成立。版本 4 的选择字段、`completionReason`、`storyRuntime` 都写在 chat 记录里，不再升版本。

`assets` 里壁纸记录的 id 固定为 `chat-wallpaper`，字段是 `blob`、`name`、`type`、`size`、`updatedAt`。

备份 V1：

```json
{
  "format": "my-ai-chat-backup",
  "version": 1,
  "exportedAt": "2026-10-29T00:00:00.000Z",
  "app": { "name": "My AI Chat", "theme": "dark" },
  "chats": [],
  "settings": {},
  "activeChatId": null
}
```

`version !== 1` 直接拒绝。导出前把 `sending` 和 `generating` 改成 `interrupted`，并补一句 notice。不含密钥、壁纸 Blob、风格参考和模型目录缓存。

`planBackupMerge`：本地没有该 id 则新增；双方 `updatedAt` 都能解析且导入方更新，则替换；否则保留本地。相等或时间不可比较都保留本地。导入后写全局设置，不调用壁纸 API。`activeChatId` 必须指向备份里的聊天，否则变 `null`。

设置码是另一条通道，只搬设置和主题，不合并聊天。

## 7. System Instruction 与故事模式

`validatePayload` 的拼接顺序是固定的：

1. `validateGenerationSettings` 放入用户的 `systemInstruction`。空字符串不放入。
2. `storyMemory` 非空且有意义时，`storyMemorySystemInstruction` 把它包成「用户指令 + STORY MEMORY POLICY + STORY MEMORY DATA」。无意义记忆则保持上一步。
3. `responseQualitySystemInstruction` 再包一层。有风格参考或非空重新生成原因时，加上 STYLE REFERENCE POLICY 和可选的 ONE-TIME REGENERATION GUIDANCE。`try_again` 的指导句是空的，所以单独这个原因不会触发包装。
4. 请求带了合法 `storyRuntime` 时，`storyRuntimeSystemInstruction` 把第 3 步的结果放在最前，再追加 SETUP 或 WRITING 策略、稳定度策略，以及可选的 `CURRENT RUNTIME ACTION`。

因此后写的故事模式文本在最终字符串的尾部。各段内部却把自己标成最高或最低优先级，这是提示词约定，不是程序再排序。

故事模式的计算在 `storyRuntimeState`：只看可见路径上能找到 `anchorId` 的 transition，锚点越深越优先，同深度时 `createdAt` 较新的优先。没有这样的 transition，或选中的 `mode` 是 `disabled`，则 `enabled: false`。

| 用户动作 | 持久 transition | 这一次请求的 `action` |
| --- | --- | --- |
| 开始构思 | `mode: setup`，`action: prepare_story` | `prepare_story`。不往 Gemini contents 追加操作句 |
| 开始正文 | `mode: writing`，`action: start_writing` | `start_writing`。上下文用 `all`，并把操作句并进最后一条 user |
| 继续故事 | 不新增 transition | `continue_story`。若上一条已是 model，再追加一条 user 操作句 |
| 继续未完成 | 不新增 transition | `continue_incomplete`。同样追加操作句。`contextFor` 可以把紧邻的未完成回复放进这一次上下文 |
| 退出故事模式 | `mode: disabled`，`action: exit_story` | 之后 `enabled` 为 false，普通发送不再带 `storyRuntime` |

`continuationAvailability`：生成中不可继续；没有可见正文不可继续；`max_tokens`、固定截断 notice，或状态为 `stopped`、`interrupted`、`error`，得到 `continue_incomplete`；`complete` 得到 `continue_story`。

稳定度 `free`、`balanced`、`strict` 只改变发明幅度和节拍长短。知识边界、不能替用户做决定、不能违反已建立事实，在三段策略里都保留。稳定度是整次聊天一份，退出故事不会把它改回默认值。

`start_writing` 的策略要求只把用户说过的事实，以及用户明确接受的助手提议，当作正文事实。未接受的构思仍是候选。

## 8. app.js 主流程

文件没有 export。底部 `await initializeApp()`。

### 初始化

`initializeApp`：

1. `loadOrSeedChats(createDemoChats)`。失败则只用内存中的 demo，并 toast。
2. 每条聊天 `ensureBranchLineage` 后放入 `chats` Map。
3. `loadStoryMemories`、`loadStyleReferences`。失败分别清空，风格失败会 toast。
4. 用 `my-ai-chat-active-chat-id` 恢复当前聊天，否则用 Map 的第一条。
5. 恢复主题、`loadWallpaperAsset`、`setTheme`、`renderHistory`、`renderConversation`、`syncComposer`、`syncSettingsUi`。
6. `refreshStoragePersistence`。
7. `modelCatalog.autoRefresh()`。成功则 `ensureAvailableDefaultModel(true)`，再同步模型和设置界面。

### 发送

`#composerForm` 的 submit：

1. 正在生成、正在编辑或输入为空则返回。
2. `createMessage('user', input.trim())`。
3. `parentVariantId` 设为可见叶子 assistant 的当前 variant id；没有叶子则为 `null`。
4. `chat.messages.push`，`selectUserChild`。
5. 清空输入，`renderConversation(true)`，`persistChat`。
6. `generate(chat, user)`。

`generate`：

1. 已有 `generation` 则返回。
2. 新建 assistant，或复用重新生成时传入的 turn/variant。状态先写 `sending`。
3. `parentUserId = user.id`，`AbortController` 放进 `generation`。
4. `POST /api/chat`。`messages` 来自 `contextFor`。`start_writing` 用 `'all'`，否则用 `globalSettings.contextLimit`。
5. 附上有意义的 `storyMemory`、`styleReferenceRequestItems`、可选 `regenerationReason`、已启用时的 `storyRuntime`，以及 `requestSettings`。
6. `consumeStream`：`start` → `generating`；`delta` 追加 `content` 并 `updateMessage`；`error` 写 `variant.error`；`done` 写 `complete`、`notice`、`completionReason`。
7. `finally` 清空 `generation`，再 `renderConversation` 和 `persistChat`。

`updateMessage` 只替换当前聊天里对应 DOM。`shouldFollowStreaming` 为真时把滚动条拉到底。

### 停止

发送按钮在生成中变成停止。`stopGeneration` 调用 `generation.abort.abort()`，把 variant 标为 `stopped`，`updateMessage` 并 `persistChat`。该回复以后不进 `contextFor`。

### 重新生成

可见 assistant 上的按钮：状态已是 `error` 或 `stopped` 时直接 `retry(message.id)`。否则 `openRegenerateMenu`。菜单选择后 `retry(messageId, reasonId)`。

`retry` 用 `addAssistantVariant` 增加一条空回复，持久化后调用 `generate(..., regenerationReason, regenerationRuntimeAction(user))`。新 variant 成为 `activeVariantId`。旧 variant 上的子用户分支仍挂在旧 id 上。

### 分支切换

assistant 的 `variant-prev` / `variant-next` 只改 `activeVariantId`，然后 `renderConversation` 和 `persistChat`。

user 的 `user-variant-prev` / `user-variant-next` 调用 `selectUserChild`。根用户写入 `activeRootUserId`，其余写入父 variant 的 `activeChildUserId`。

历史编辑：`beginHistoricalEdit` 打开 textarea。保存时新建一条 user，`parentVariantId` 与被编辑消息相同，`selectUserChild` 后 `generate`。`removeUserDescendants` 用于删掉被替换路径的后代；兄弟分支保留。

### 设置弹窗

`#settingsButton` 关闭侧栏和各菜单，`syncSettingsUi()`，然后 `#settingsDialog.showModal()`。字段变化走 `updateGlobalSettings`，立即 `saveGlobalSettings`。重置走 `resetGlobalSettings`。模型目录按钮走 `modelCatalog.refresh()`。设置码、备份、壁纸和风格参考各自的按钮也在这个对话框里。

故事操作不走设置弹窗：`runStoryRuntimeAction` 调用 `setStoryRuntimeMode` 或 `createRuntimeControl`，需要生成时再进入 `generate`。

## 9. 测试清单

`npm test` 只运行 `tests/*.test.js`。`dev/qa-transport.js` 只被 `vite.config.js` 的开发中间件 import，不进入 `vite build` 的客户端产物。

| 文件 | 覆盖 |
| --- | --- |
| `phase2.test.js` | UUID 后备、缺密钥、模型白名单、同源与体长、多轮映射、SSE 顺序、完成原因、429/400/404/403/网络/服务器错误消毒、取消、超时、中文分片、Markdown 消毒 |
| `persistence.test.js` | 建库只播种一次、旧 demo 收成 `demo-welcome`、重开后字段还在、stopped/error 不进后续上下文 |
| `vercel.test.js` | SDK 流式 URL 与上下文、默认设置不写 temperature/topP/topK、Stop 传到上游 AbortSignal、构建产物不含密钥且未配置时 503 |
| `settings.test.js` | 设置持久化、手机显示、上下文截断、服务器生成配置、能力不匹配时收成默认、设置对话框只有一个滚动容器 |
| `settings-code.test.js` | V1 往返、中文系统指令长度、白名单、未知字段、坏码、超长、界面 |
| `safety-settings.test.js` | 旧设置升级、五档阈值、自定义四类、非法值、安全拦截文案、界面 |
| `models-chat-cleanup.test.js` | 8 个模型的阶段和 thinking、不发出不支持的 Top K、每个 ID 原样到达 transport、模型菜单高度 |
| `model-catalog.test.js` | 内置模型保留、非聊天模型过滤、`/api/models` 不漏密钥、伪造 ID、24 小时缓存、发现模型不带自定义安全 |
| `app-persistence.test.js` | jsdom 中的真实界面：记忆、新聊天、故事模式、历史编辑、模型切换、设置码、variant、壁纸、风格与重新生成 |
| `data-safety.test.js` | 备份 V1、排除密钥和壁纸、合并只替换更新的聊天、坏文件不写、导入不改壁纸、进行中的回复变 interrupted |
| `response-variants.test.js` | 本地时间标题、旧 assistant 仍是单回复、可见路径才进上下文、历史编辑只删后代 |
| `response-quality.test.js` | v4 增加 styleReferences、五条上限与去重、请求预算、原因 ID、重新生成不搬走子分支 |
| `user-turn-branching.test.js` | 旧线性聊天、`activeRootUserId`、variant 上的 `activeChildUserId`、runtime-control 不进普通用户切换、备份拒绝跨分支引用 |
| `story-memory.test.js` | 首次提取、增量、分块预算、失败不写中间快照、v3 迁移、schema、规范化、每块最多三次调用、安全设置、记忆位于用户指令之后 |
| `story-panel.test.js` | 面板字段、只沿当前分支继承、历史编辑后的兄弟记忆仍在库中 |
| `story-runtime.test.js` | 默认关闭、最深 transition 生效、`exit_story`、控制消息不进记忆、动作白名单、截断后续写、三种稳定度文本都保留硬规则 |
| `scroll-position.test.js` | 320/96 滞后、流式跟随、减少动效、按钮触控尺寸 |
| `wallpaper.test.js` | jpeg/png/webp、v2 assets、Blob 替换和删除、铺到主面板而不是 body |
| `glass-ui.test.js` | 深浅色 token、消息不单独 backdrop-filter、设置单滚动 |
| `mobile-display-settings.test.js` | `data-mobile-density`、`data-chat-text-size`、中文三档、819px 断点、16px 表单字 |
| `mobile-story-stability.test.js` | 390×844 重新生成菜单、故事空状态、长文编辑、键盘高度、记忆错误码 |

## 10. 已知不一致或技术债

这些是当前代码里能直接核对的差异。

1. 采样值仍保存在设置和设置码里，但 8 个内置模型的 `samplingOverrides` 都是 false，`requestSettings` 不会把 temperature 发给服务器。这一项先保持不动。
2. system instruction 被连续包了三次。故事记忆和风格参考都写着用户指令优先级最高，故事模式又把更长的策略接在最后。程序不做二次排序。见 `docs/system-instruction-samples.md`。
3. 聊天 API 的消息 `id` 上限是 100，故事记忆和备份的 ID 上限是 256。`uniqueId` 生成的 UUID 两边都放得下。
4. `contextFor` 要求 assistant `status === 'complete'`。`continue_incomplete` 在 `ui/state.js` 里有单独分支，可以把紧邻的未完成文本放进这一次请求；普通下一问不会带上它。
5. `ui/app.js` 仍把渲染、生成、设置、备份、壁纸和故事放在一个文件里。拆分计划见 `docs/app-split-plan.md`。
6. 开发服务器把 `/api/chat` 固定写成 `http://terminal.local:4173`。浏览器从 `localhost` 打开时，`Origin` 和这个 URL 不一致，`handleChat` 返回 403。

## 11. ui/index.html 的 id

静态 HTML 里的占位聊天按钮（`data-chat-id`）会在 `renderHistory` 时被换成 IndexedDB 里的记录。

| id | 用途 |
| --- | --- |
| `mobileScrim` | 窄屏侧栏遮罩 |
| `sidebar` | 聊天历史侧栏 |
| `closeSidebar` / `openSidebar` | 关、开侧栏 |
| `newChatButton` | 新建聊天 |
| `chatSearch` | 按标题过滤聊天 |
| `foldersToggle` / `folderList` | 文件夹区。文件夹按钮仍是演示，不连数据 |
| `todayChats` | 聊天列表容器 |
| `settingsButton` / `themeHint` | 打开设置，并显示当前主题名 |
| `modelButton` / `currentModel` / `modelMenu` | 当前聊天模型和模型菜单 |
| `quickTheme` | 顶栏切换深浅色 |
| `conversation` | 消息滚动区 |
| `scrollToBottom` | 滚到最新消息 |
| `attachmentChip` / `removeAttachment` / `attachButton` | 附件占位，按钮禁用 |
| `messageInput` / `composerForm` / `sendButton` | 输入、提交、生成中变为停止 |
| `mobileStoryButton` / `mobileStoryLabel` | 窄屏故事入口 |
| `thinkingMode` | 思考模式占位，禁用 |
| `settingsDialog` | 设置对话框 |
| `modelSettingsTitle` | 模型设置标题 |
| `resetGlobalSettings` | 恢复默认设置 |
| `modelCatalogSynced` / `refreshModels` | 模型目录同步时间和刷新 |
| `defaultModelSetting` | 新聊天的默认模型 |
| `currentChatModelSetting` | 当前聊天模型名 |
| `webSearchSetting` / `webSearchSupport` | 联网搜索开关和费用说明 |
| `systemInstructionSetting` / `systemInstructionCount` / `clearSystemInstruction` | 系统指令 |
| `contextLimitSetting` | 发给模型的历史长度 |
| `maxOutputTokensSetting` / `maxOutputTokensSupport` | 输出上限 |
| `thinkingLevelSetting` / `thinkingSupport` | 思考等级 |
| `samplingEnabledSetting` / `samplingSupport` | 采样开关。内置模型上不可用 |
| `advancedFields` / `temperatureSetting` / `topPSetting` / `topKField` / `topKSetting` / `topKSupport` | 采样数值 |
| `safetyModeSetting` / `safetyCustomFields` | 安全设置 |
| `styleReferenceSettingsTitle` / `styleReferenceCount` / `styleReferenceList` | 风格参考 |
| `mobileDisplaySettingsTitle` | 手机显示 |
| `settingsCodeTitle` / `generateSettingsCode` / `settingsCodeOutputWrap` / `settingsCodeOutput` / `copySettingsCode` / `settingsCodeInput` / `importSettingsCode` | 设置码 |
| `appearanceSettingsTitle` | 外观 |
| `wallpaperInput` / `wallpaperCurrent` / `wallpaperPreview` / `wallpaperName` / `chooseWallpaper` / `removeWallpaper` | 壁纸 |
| `localDataSettingsTitle` / `exportBackup` / `importBackup` / `backupInput` | 备份 |
| `storageProtectionStatus` / `requestStoragePersistence` | 浏览器持久化存储 |
| `sheetScrim` | 窄屏底部菜单遮罩 |
| `regenerateMenu` / `runtimeMenu` / `storyMenu` | 重新生成、故事续写、故事菜单 |
| `toast` | 短提示 |

## 12. ui/app.js 内部函数

无 export。`index.html` 加载后执行 `initializeApp`。

| 函数 | 职责 | 主要调用方 |
| --- | --- | --- |
| `createDemoChats` | 做唯一演示对话 | `initializeApp` |
| `ensureAvailableDefaultModel` | 默认模型不在目录里时换回内置模型 | 初始化和模型刷新 |
| `toast` | 显示短提示 | 各失败和保存路径 |
| `rememberActiveChat` | 写入当前聊天 id | `selectChat`、初始化 |
| `persistChat` | `saveChat` | 发送、停止、分支 |
| `renderHistory` | 重画侧栏聊天列表 | `selectChat`、初始化 |
| `action` | 消息操作按钮 HTML | `messageHtml` |
| `messageHtml` | 一条消息的 HTML，含来源和搜索建议宿主 | `renderConversation`、`updateMessage` |
| `mountSearchSuggestions` | 把搜索建议挂进 Shadow DOM | 渲染和流式更新之后 |
| `panelList` / `mobilePanelList` | 故事面板的一节列表 | `storyPanelHtml`、故事菜单 |
| `storyPanelHtml` | 对话上方的记忆面板 | `renderConversation` |
| `storyRuntimeHtml` | 构思、开始正文、故事操作 | `renderConversation` |
| `renderConversation` | 重画可见分支 | 几乎所有状态变化 |
| `syncScrollToBottomButton` | 按距离显示滚到底部 | 滚动和更新消息 |
| `syncMobileStoryButton` | 窄屏故事按钮文案 | `renderConversation` |
| `resizeEditTextarea` / `keepEditControlsVisible` | 历史编辑框高度和位置 | 编辑 |
| `beginHistoricalEdit` / `clearHistoricalEdit` | 进入或取消历史编辑 | 消息操作 |
| `updateStoryMemory` | 调用 `runStoryMemoryUpdate` | 记忆按钮 |
| `updateMessage` | 替换一条消息的 DOM | `generate` 的流式回调 |
| `syncComposer` | 发送按钮在生成中变成停止 | 生成开始和结束 |
| `syncModel` | 顶栏模型名和输入占位 | 换模型、换聊天 |
| `setModelMenu` | 打开或关闭模型菜单 | 模型按钮 |
| `closeSidebar` / `openSidebar` | 侧栏 | 窄屏按钮 |
| `selectChat` | 切换当前聊天并恢复草稿和滚动 | 列表点击、`newChat` |
| `newChat` | 用默认模型建聊天 | 新建按钮 |
| `syncSettingsUi` | 把 `globalSettings` 填进设置控件 | 打开设置、改设置 |
| `updateGlobalSettings` | 保存设置并刷新界面 | 各设置控件 |
| `setTheme` | 切换 `data-theme` | 主题按钮 |
| `refreshStoragePersistence` | 查询持久化存储状态 | 初始化 |
| `generate` | `POST /api/chat` 并消费 SSE | 发送、重新生成、故事动作 |
| `stopGeneration` | 中止并把回复标为 stopped | 停止按钮 |
| `retry` | 增加一条 variant 再生成 | 重新生成菜单 |
| `hideSurfaceMenu` / `showSurfaceMenu` / `repositionActiveSurfaceMenu` | 底部菜单显隐 | 各菜单 |
| `closeRegenerateMenu` / `openRegenerateMenu` | 重新生成原因菜单 | 消息按钮 |
| `closeRuntimeMenu` / `openRuntimeMenu` | 继续故事菜单 | 故事操作按钮 |
| `closeStoryMenu` / `openStoryMenu` / `renderStoryMenu` | 故事对话框 | 窄屏故事按钮 |
| `storyAction` / `startWritingAvailability` / `startWritingAction` / `storyMemoryAction` / `storyMemoryFailureHtml` / `storyStabilityControl` / `storyStateContent` | 故事菜单里的按钮和状态 | `renderStoryMenu` |
| `changeStoryStability` | 改整次聊天的稳定度 | 稳定度控件 |
| `runStoryRuntimeAction` | 写 transition 或控制消息，需要时调用 `generate` | 故事按钮 |
| `saveActiveStyleReference` | 保存当前 variant 为风格参考 | 保存风格 |
| `copy` | 复制正文，不含来源 HTML | 复制按钮 |

## 13. ui/styles.css

`:root` 是深色。`html[data-theme="light"]` 覆盖同一批变量。主要变量：`--bg`、`--sidebar`、`--surface`、`--surface-2`、`--surface-3`、`--text`、`--muted`、`--muted-2`、`--border`、`--border-strong`、`--accent`、`--accent-strong`、`--accent-soft`、`--user-bubble`、`--code-bg`、`--shadow`、`--sidebar-width`、`--wallpaper-tint`、`--glass-bg`、`--glass-bg-strong`、`--glass-bg-soft`、`--glass-border`、`--glass-border-strong`、`--glass-shadow`、`--glass-shadow-soft`、`--glass-blur`、`--glass-blur-light`、`--message-user-bg`、`--message-assistant-bg`、`--message-actions-bg`、`--control-glass-bg`、`--dock-fade`。

断点：

- `max-width: 819px`：侧栏改为抽屉，顶栏变矮，表单字号 16px。
- 该断点内再按密度覆盖间距变量：`html[data-mobile-density="standard"]`（以及 `:root` 默认）、`compact`、`comfortable`。属性来自 `applyMobileDisplayPreferences`，是 `data-mobile-density` 和 `data-chat-text-size`，不是 `data-density` / `data-chat-text`。
- `max-width: 520px`：进一步收紧部分间距。
- `html[data-chat-text-size="small|standard|large"]` 只在 819px 以内设置 `--mobile-chat-font-size` 为 15、16、17px。

联网搜索开关 `.web-search-toggle input` 是 44×44。设置卡片 `.settings-card` 仍是唯一的 `overflow-y: auto`。

## 14. createModelCatalog 的返回对象

`createModelCatalog({ storage, fetcher, now })` 返回：

| 成员 | 行为 |
| --- | --- |
| `models` | getter，`mergeModelCatalog(discovered)` |
| `syncedAt` | getter，ISO 字符串或 `null` |
| `has(id)` | 布尔值 |
| `metadata(id)` | 模型对象或 `null` |
| `name(id)` | 显示名，找不到就返回 id |
| `refresh({ force = false })` | `GET /api/models` 或 `?refresh=1`。成功返回模型数组，并写入 localStorage `{ version: 1, models }` 和同步时间 |
| `autoRefresh()` | 本会话已试过则 `{ attempted: false, reason: 'session' }`；未过期则 `{ attempted: false, reason: 'fresh' }`；成功 `{ attempted: true, ok: true }`；失败 `{ attempted: true, ok: false, error }` |

`availableDefaultModel(modelId, catalog)` 在 `catalog.has(modelId)` 时返回该 id，否则返回 `DEFAULT_MODEL`。

