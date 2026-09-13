import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { activeAssistantVariant } from '../ui/state.js';
import { closeChatDatabase, loadChats, loadStoryMemories } from '../ui/storage.js';
import { classifyStoryMemoryUpdateError, StoryMemoryUpdateError } from '../ui/story-memory.js';
import { positionMobileSheet, visualViewportBounds } from '../ui/mobile-sheet.js';
import { storyRuntimeState } from '../ui/story-runtime.js';

const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
const waitFor = async (check, timeout = 4000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for mobile app state');
};

function memoryFixture() {
  return {
    version: 1,
    scene: { location: '雨夜图书馆', time: '深夜', presentCharacters: ['米拉'], relativePositions: [], environmentState: ['窗外下雨'], importantObjects: [] },
    characters: [{
      idOrName: '米拉', name: '米拉', identity: [], visualAnchors: ['银色发夹'], publicPersona: [],
      observedDisposition: ['看起来疲惫'], speechFingerprint: [], behavioralTells: [], knownPreferences: [],
      knownBoundaries: [], currentState: ['等待'], currentClothing: ['深色外套'], relationshipToProtagonist: [],
    }],
    relationship: { summary: '双方正在建立信任。', establishedChanges: [], sharedHistory: [], unresolvedTension: [] },
    importantEvents: [], knownFacts: ['钟停在九点。'], unknownOrUnconfirmed: [], unresolvedThreads: ['信是谁留下的？'],
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key), clear: () => values.clear(),
  };
}

function createTransport() {
  const payloads = [];
  const encoder = new TextEncoder();
  const fetchMock = async (url, init = {}) => {
    if (String(url).includes('/api/models')) return Response.json({ error: { code: 'TEST' } }, { status: 503 });
    const payload = JSON.parse(init.body);
    payloads.push(payload);
    if (String(url).includes('/api/story-memory')) return Response.json({ memory: memoryFixture() });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start' })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: '移动端回复。' })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', notice: null })}\n\n`));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetchMock, payloads };
}

function createPausedChatTransport() {
  const transport = createTransport();
  let releaseChat;
  const gate = new Promise(resolve => { releaseChat = resolve; });
  const fetchMock = async (url, init = {}) => {
    if (String(url).includes('/api/chat')) await gate;
    return transport.fetchMock(url, init);
  };
  return { ...transport, fetchMock, releaseChat };
}

function installMobileDom(indexedDB, fetchMock, storage = memoryStorage()) {
  const dom = new JSDOM(html, { url: 'https://app.example/' });
  const dialog = dom.window.document.querySelector('#settingsDialog');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new dom.window.Event('close')); };
  const media = { matches: true, addEventListener() {}, removeEventListener() {} };
  const viewport = { offsetTop: 0, height: 844, addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(dom.window, 'visualViewport', { configurable: true, value: viewport });
  Object.defineProperty(dom.window, 'innerWidth', { configurable: true, value: 390 });
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 844 });
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, DOMParser: dom.window.DOMParser,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    localStorage: storage, matchMedia: () => media, indexedDB, fetch: fetchMock,
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  return { dom, storage };
}

test('390x844 regenerate sheet opens above composer, closes cleanly, and sends stable reason ID', async () => {
  const indexedDB = new IDBFactory(), transport = createTransport();
  const { dom } = installMobileDom(indexedDB, transport.fetchMock);
  await import('../ui/app.js?mobile-regenerate-stability');
  const trigger = [...document.querySelectorAll('[data-action="regenerate"]')].at(-1);
  trigger.click();
  const menu = document.querySelector('#regenerateMenu'), scrim = document.querySelector('#sheetScrim');
  assert.equal(menu.hidden, false); assert.equal(scrim.hidden, false);
  assert.equal(menu.style.left, '10px'); assert.equal(menu.style.right, '10px');
  assert.ok(Number.parseFloat(menu.style.top) >= 0);
  assert.equal(document.activeElement === menu.querySelector('button'), false);
  scrim.click();
  assert.equal(menu.hidden, true); assert.equal(scrim.hidden, true);
  assert.equal(scrim.style.height, '');

  trigger.click();
  menu.querySelector('[data-regeneration-reason="continuity_issue"]').click();
  await waitFor(() => transport.payloads.some(payload => payload.regenerationReason === 'continuity_issue'));
  const chat = (await loadChats(indexedDB)).find(item => item.demo);
  assert.equal(activeAssistantVariant(chat.messages.at(-1)).status, 'complete');
  assert.equal(chat.messages.at(-1).variants.length, 2);
  assert.equal(menu.hidden, true); assert.equal(scrim.hidden, true);
  dom.window.close(); await closeChatDatabase();
});

test('mobile Story entry is contextual, shows explicit empty state, refreshes memory, and exit persists', async () => {
  const indexedDB = new IDBFactory(), transport = createPausedChatTransport(), storage = memoryStorage();
  let { dom } = installMobileDom(indexedDB, transport.fetchMock, storage);
  await import('../ui/app.js?mobile-story-stability');
  assert.equal(document.querySelector('#mobileStoryLabel').textContent, '故事');
  assert.ok(document.querySelector('#mobileStoryButton').closest('.composer'));
  document.querySelector('#mobileStoryButton').click();
  let menu = document.querySelector('#storyMenu');
  assert.match(menu.textContent, /状态：未启用/);
  assert.deepEqual([...menu.querySelectorAll('[data-story-runtime-action]')].map(button => button.dataset.storyRuntimeAction), ['prepare_story']);
  assert.match(menu.textContent, /开始构思/);
  menu.querySelector('[data-story-runtime-action="prepare_story"]').click();
  await waitFor(() => menu.textContent.includes('状态：构思中'));
  assert.equal(document.querySelector('#mobileStoryLabel').textContent, '故事 · 构思中');
  assert.deepEqual([...menu.querySelectorAll('[data-story-runtime-action]')].map(button => button.dataset.storyRuntimeAction), ['start_writing', 'exit_story']);
  assert.equal(menu.querySelector('[data-story-runtime-action="continue_story"]'), null);
  assert.ok(menu.querySelector('[data-update-story-memory]'));
  assert.equal(menu.querySelector('[data-story-runtime-action="start_writing"]').disabled, false);
  assert.equal((await loadStoryMemories((await loadChats(indexedDB)).find(item => item.demo).id, indexedDB)).length, 0);

  const input = document.querySelector('#messageInput');
  input.value = '补充设定：我希望开头是家庭晚餐。';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#composerForm').requestSubmit();
  await waitFor(() => menu.querySelector('[data-story-runtime-action="start_writing"]')?.disabled);
  assert.match(menu.textContent, /等待当前回复完成/);
  transport.releaseChat();
  await waitFor(() => menu.querySelector('[data-story-runtime-action="start_writing"]')?.disabled === false);
  assert.ok(transport.payloads.some(payload => payload.storyRuntime?.mode === 'setup' && !payload.storyRuntime.action));

  menu.querySelector('[data-open-story-state]').click();
  assert.match(menu.textContent, /尚未生成故事记忆/);
  menu.querySelector('[data-story-menu-back]').click();
  menu.querySelector('[data-story-runtime-action="start_writing"]').click();
  await waitFor(async () => {
    const chat = (await loadChats(indexedDB)).find(item => item.demo);
    return storyRuntimeState(chat).mode === 'writing' && activeAssistantVariant(chat.messages.at(-1))?.status === 'complete';
  });
  document.querySelector('#mobileStoryButton').click();
  menu = document.querySelector('#storyMenu');
  assert.match(menu.textContent, /状态：正文中/);
  assert.equal(document.querySelector('#mobileStoryLabel').textContent, '故事 · 正文中');
  assert.deepEqual([...menu.querySelectorAll('[data-story-runtime-action]')].map(button => button.dataset.storyRuntimeAction), ['continue_story', 'continue_incomplete', 'exit_story']);
  assert.equal(menu.querySelector('[data-story-runtime-action="start_writing"]'), null);
  assert.ok(menu.querySelector('[data-open-story-state]'));
  assert.ok(menu.querySelector('[data-update-story-memory]'));
  menu.querySelector('[data-update-story-memory]').click();
  await waitFor(() => !document.querySelector('#storyMenu').textContent.includes('正在更新'));
  menu = document.querySelector('#storyMenu');
  menu.querySelector('[data-open-story-state]').click();
  await waitFor(() => menu.textContent.includes('雨夜图书馆'));
  assert.match(menu.textContent, /米拉/);
  menu.querySelector('[data-story-menu-back]').click();
  menu.querySelector('[data-story-runtime-action="exit_story"]').click();
  const exited = await waitFor(async () => {
    const chat = (await loadChats(indexedDB)).find(item => item.demo);
    return storyRuntimeState(chat).transition?.action === 'exit_story' ? chat : null;
  });
  assert.equal(storyRuntimeState(exited).enabled, false);
  assert.equal(document.querySelector('#mobileStoryLabel').textContent, '故事');
  assert.equal((await loadStoryMemories(exited.id, indexedDB)).length, 1);

  dom.window.close(); await closeChatDatabase();
  ({ dom } = installMobileDom(indexedDB, transport.fetchMock, storage));
  await import('../ui/app.js?mobile-story-stability-reopen');
  document.querySelector('#mobileStoryButton').click();
  menu = document.querySelector('#storyMenu');
  assert.match(menu.textContent, /状态：未启用/);
  assert.deepEqual([...menu.querySelectorAll('[data-story-runtime-action]')].map(button => button.dataset.storyRuntimeAction), ['prepare_story']);

  document.querySelector('#newChatButton').click();
  await waitFor(() => document.querySelector('#mobileStoryLabel').textContent === '故事');
  document.querySelector('#mobileStoryButton').click();
  menu = document.querySelector('#storyMenu');
  menu.querySelector('[data-story-runtime-action="prepare_story"]').click();
  await waitFor(() => menu.textContent.includes('状态：构思中'));
  assert.equal(menu.querySelector('[data-story-runtime-action="start_writing"]').disabled, true);
  assert.match(menu.textContent, /请先提供一些故事想法/);
  dom.window.close(); await closeChatDatabase();
});

test('mobile long-message editor grows to a visual-viewport cap and keeps actions touchable', async () => {
  const indexedDB = new IDBFactory(), transport = createTransport();
  const { dom } = installMobileDom(indexedDB, transport.fetchMock);
  await import('../ui/app.js?mobile-long-edit-polish');
  document.querySelector('.message.user [data-action="edit"]').click();
  const editor = document.querySelector('.edit-area textarea');
  assert.equal(editor.style.height, '176px');
  Object.defineProperty(editor, 'scrollHeight', { configurable: true, value: 900 });
  editor.value = '很长的角色设定。'.repeat(300);
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(editor.style.height, '380px');
  assert.equal(editor.style.overflowY, 'auto');
  assert.deepEqual([...document.querySelectorAll('.edit-controls button')].map(button => button.textContent), ['Cancel', 'Save & resend']);
  document.querySelector('[data-action="edit-cancel"]').click();
  assert.equal(document.querySelector('.edit-area'), null);

  const css = await readFile(new URL('../ui/styles.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.edit-area\s*\{[^}]*width:\s*100%/);
  assert.match(css, /\.edit-area textarea\s*\{[^}]*min-height:\s*176px;[^}]*max-height:\s*min\(46dvh, 380px\);[^}]*font-size:\s*16px/s);
  assert.match(css, /\.edit-controls\s*\{[^}]*position:\s*sticky;[^}]*env\(safe-area-inset-bottom\)[^}]*grid-template-columns:/s);
  assert.match(css, /\.edit-controls \.small-button\s*\{[^}]*min-height:\s*44px/s);
  dom.window.close(); await closeChatDatabase();
});

test('visual viewport positioning follows keyboard-sized Safari viewport', () => {
  const targetWindow = { innerHeight: 844, visualViewport: { offsetTop: 24, height: 420 } };
  const sheet = {
    style: {}, scrollHeight: 260,
    getBoundingClientRect: () => ({ height: 260 }),
  };
  const scrim = { style: {} };
  assert.deepEqual(visualViewportBounds(targetWindow), { top: 24, height: 420 });
  const result = positionMobileSheet(sheet, scrim, targetWindow);
  assert.equal(result.sheetTop, 174);
  assert.equal(sheet.style.maxHeight, '400px');
  assert.equal(scrim.style.top, '24px'); assert.equal(scrim.style.height, '420px');
});

test('memory failures have stable non-sensitive classifications and Safari write queues synchronously', async () => {
  for (const [stage, expected] of [['anchor', 'MEMORY_INVALID_ANCHOR'], ['extraction', 'MEMORY_EXTRACTION_FAILED'], ['validation', 'MEMORY_INVALID_JSON'], ['storage', 'MEMORY_STORAGE_FAILED']]) {
    assert.equal(classifyStoryMemoryUpdateError(new Error('private detail'), stage), expected);
  }
  assert.equal(classifyStoryMemoryUpdateError(new StoryMemoryUpdateError('MEMORY_INVALID_JSON'), 'storage'), 'MEMORY_INVALID_JSON');
  const storageSource = await readFile(new URL('../ui/storage.js', import.meta.url), 'utf8');
  const replacement = storageSource.match(/export async function replaceStoryMemorySnapshot[\s\S]*?\n}/)?.[0] || '';
  assert.match(replacement, /lookup\.addEventListener\('success'/);
  assert.doesNotMatch(replacement, /await requestResult\(store\.index\('anchorId'\)/);
});

test('shared mobile sheet CSS stays above composer, uses safe area, and avoids horizontal overflow', async () => {
  const css = await readFile(new URL('../ui/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.composer-dock\s*\{[^}]*z-index:\s*15/s);
  assert.match(css, /\.surface-menu\s*\{[^}]*z-index:\s*90/s);
  assert.match(css, /\.sheet-scrim\s*\{[^}]*z-index:\s*85/s);
  assert.match(css, /\.surface-menu\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.surface-menu\s*\{[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.mobile-story-button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.mobile-story-button\s*\{[^}]*display:\s*inline-flex/);
  assert.match(css, /\.chat-heading > \.story-runtime-control, \.chat-heading > \.story-panel\s*\{\s*display:\s*none/);
  assert.match(css, /\.mobile-story-button\s*\{[^}]*border-radius:\s*999px/);
  assert.match(css, /\.mobile-story-button\s*\{[^}]*max-width:\s*150px/);
});
