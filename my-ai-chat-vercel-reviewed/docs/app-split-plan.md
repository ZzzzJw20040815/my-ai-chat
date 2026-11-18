# 拆分 ui/app.js 的计划

只写计划，本文件不改 `ui/app.js`。每一步单独提交，提交后都要 `npm test` 全部通过，再进入下一步。不要在同一步里既搬家又改行为。

当前 `ui/app.js` 没有 export，由 `ui/index.html` 加载。测试里真正执行它的是 `tests/app-persistence.test.js` 和若干读取 HTML/CSS 的界面测试。搬家时保持函数名，先把函数原样搬到新模块再从 `app.js` re-export 或在 `app.js` 里 import，避免测试按 DOM id 找不到控件。

## 第 1 步：渲染

新建 `ui/render-conversation.js`，搬入 `messageHtml`、`action`、`mountSearchSuggestions`、`panelList`、`mobilePanelList`、`storyPanelHtml`、`storyRuntimeHtml`、`renderConversation`、`renderHistory`。

`app.js` 仍负责持有 `chats`、`generation` 和 DOM 查询，通过参数传给这些函数。

先跑：

- `tests/app-persistence.test.js`
- `tests/glass-ui.test.js`
- `tests/mobile-display-settings.test.js`
- `tests/mobile-story-stability.test.js`
- `tests/story-panel.test.js`
- `tests/response-quality.test.js` 里的界面项
- `tests/search-suggestion.test.js`

## 第 2 步：生成和流式

新建 `ui/generate.js`，搬入 `generate`、`stopGeneration`、`retry`、`syncComposer`。请求体组装保持现在的字段白名单，不要在这里决定 `tools`。

先跑：

- `tests/app-persistence.test.js`
- `tests/phase2.test.js`
- `tests/web-search.test.js`
- `tests/story-runtime.test.js`
- `tests/response-quality.test.js`
- `tests/user-turn-branching.test.js`

## 第 3 步：设置

新建 `ui/settings-dialog.js`，搬入 `syncSettingsUi`、`updateGlobalSettings`、`setTheme`、设置控件的事件绑定。`shared/settings.js` 和 `ui/settings.js` 不动。

先跑：

- `tests/settings.test.js`
- `tests/settings-code.test.js`
- `tests/safety-settings.test.js`
- `tests/mobile-display-settings.test.js`
- `tests/app-persistence.test.js`

## 第 4 步：备份

新建 `ui/backup-dialog.js`，只搬设置对话框里导出、导入和存储保护按钮的绑定。`ui/backup.js` 的 V1 格式不动。

先跑：

- `tests/data-safety.test.js`
- `tests/web-search-backup.test.js`
- `tests/app-persistence.test.js`

## 第 5 步：壁纸

新建 `ui/wallpaper-dialog.js`，搬入壁纸选择、预览和删除的事件绑定。`ui/wallpaper.js` 不动。

先跑：

- `tests/wallpaper.test.js`
- `tests/app-persistence.test.js`

## 第 6 步：故事

新建 `ui/story-dialog.js`，搬入 `renderStoryMenu`、`runStoryRuntimeAction`、`changeStoryStability`、`updateStoryMemory` 以及故事菜单的开关。`ui/story-runtime.js`、`ui/story-memory.js`、`ui/story-panel.js` 保持为纯逻辑。

先跑：

- `tests/story-runtime.test.js`
- `tests/story-memory.test.js`
- `tests/story-panel.test.js`
- `tests/mobile-story-stability.test.js`
- `tests/app-persistence.test.js`

## 第 7 步：模型目录

新建 `ui/model-menu.js`，搬入 `syncModel`、`setModelMenu`、`ensureAvailableDefaultModel` 和模型按钮事件。`ui/model-catalog.js` 不动。

先跑：

- `tests/model-catalog.test.js`
- `tests/models-chat-cleanup.test.js`
- `tests/app-persistence.test.js`

## 完成标准

`app.js` 只保留状态、初始化 `initializeApp`，以及把上面模块接上 DOM。最后再跑一次完整的 `npm test`。在此之前不要改 IndexedDB 版本、备份版本或设置码版本。
