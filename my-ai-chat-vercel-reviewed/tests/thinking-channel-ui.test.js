import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { GLOBAL_SETTINGS_STORAGE_KEY, LOCAL_GEMINI_KEY_STORAGE_KEY } from '../shared/settings.js';
import { MODEL_CATALOG_STORAGE_KEY, MODEL_CATALOG_SYNC_STORAGE_KEY } from '../ui/model-catalog.js';
import { createSettingsCode } from '../ui/settings-code.js';
import { closeChatDatabase } from '../ui/storage.js';

const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../ui/styles.css', import.meta.url), 'utf8');
const waitFor = async (check, timeout = 4000) => {
  const started = Date.now();
  await new Promise(resolve => setTimeout(resolve, 30));
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for UI state');
};
function installDom(storage) {
  const dom = new JSDOM(html, { url: 'https://app.example/' });
  const dialog = dom.window.document.querySelector('#settingsDialog');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => dialog.removeAttribute('open');
  const storageApi = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  const payloads = [];
  const fetchMock = async (_url, init) => {
    if (!init?.body) return Response.json({ models: [], syncedAt: new Date().toISOString() });
    payloads.push(JSON.parse(init.body));
    return new Response(new ReadableStream({ start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start' })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: 'ok' })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', notice: null })}\n\n`));
      controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, DOMParser: dom.window.DOMParser,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    localStorage: storageApi, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    indexedDB: new IDBFactory(), fetch: fetchMock, ResizeObserver: class { observe() {} disconnect() {} },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  return { dom, payloads, storage };
}
function submitMessage(text) {
  const input = document.querySelector('#messageInput');
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#composerForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test('thinking control and API channel share saved preferences without rewriting them', async () => {
  const storage = new Map();
  storage.set(GLOBAL_SETTINGS_STORAGE_KEY, JSON.stringify({ thinkingLevel: 'high' }));
  storage.set(LOCAL_GEMINI_KEY_STORAGE_KEY, 'local-gemini-key-sentinel');
  storage.set(MODEL_CATALOG_SYNC_STORAGE_KEY, new Date().toISOString());
  const discovered = {
    id: 'gemini-auto-fixed', name: 'Gemini Auto Fixed', description: 'No levels', stage: 'stable', source: 'discovered',
    capabilities: {
      thinking: false, thinkingLevels: [], topK: false, safetySettings: false, samplingOverrides: false,
      outputTokenLimit: 1024, maxTemperature: null, topP: null,
    },
  };
  storage.set(MODEL_CATALOG_STORAGE_KEY, JSON.stringify({ version: 1, models: [discovered] }));
  const { dom, payloads } = installDom(storage);
  dom.window.confirm = () => true;
  await import('../ui/app.js?vertex-thinking=ui');
  assert.equal(document.querySelector('#apiChannelToolbar').value, 'ai-studio');
  assert.equal(document.querySelector('#thinkingModeLabel').textContent, 'High');
  document.querySelector('#settingsButton').click();
  assert.equal(document.querySelector('#thinkingLevelSetting').value, 'high');
  assert.equal(document.querySelector('[name="apiChannelSetting"][value="ai-studio"]').checked, true);

  document.querySelector('#apiChannelToolbar').value = 'vertex';
  document.querySelector('#apiChannelToolbar').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(storage.get(LOCAL_GEMINI_KEY_STORAGE_KEY), 'local-gemini-key-sentinel');
  assert.equal(JSON.parse(storage.get(GLOBAL_SETTINGS_STORAGE_KEY)).apiChannel, 'vertex');
  assert.equal(JSON.parse(storage.get(GLOBAL_SETTINGS_STORAGE_KEY)).thinkingLevel, 'high');
  assert.equal(document.querySelector('[name="apiChannelSetting"][value="vertex"]').checked, true);
  assert.match(document.querySelector('#apiChannelNote').textContent, /不会携带 Gemini API key/);
  assert.match(document.querySelector('#apiChannelNote').textContent, /不代表/);

  document.querySelector('#settingsDialog').close();
  document.querySelector('#modelButton').click();
  document.querySelector('[data-model="gemini-4-hydrogen"]').click();
  document.querySelector('#thinkingMode').click();
  const levels = [...document.querySelectorAll('#thinkingMenu [data-thinking-level]')].map(button => button.dataset.thinkingLevel);
  assert.deepEqual(levels, ['default', 'low', 'medium', 'high', 'xhigh']);
  document.querySelector('#thinkingMenu [data-thinking-level="xhigh"]').click();
  assert.equal(JSON.parse(storage.get(GLOBAL_SETTINGS_STORAGE_KEY)).thinkingLevel, 'xhigh');
  assert.equal(document.querySelector('#thinkingModeLabel').textContent, 'Extra High');

  document.querySelector('#modelButton').click();
  document.querySelector('[data-model="gemini-4-carbon"]').click();
  assert.equal(JSON.parse(storage.get(GLOBAL_SETTINGS_STORAGE_KEY)).thinkingLevel, 'xhigh');
  assert.equal(document.querySelector('#thinkingModeLabel').textContent, '默认');
  assert.match(document.querySelector('#thinkingMode').getAttribute('aria-label'), /不适用于当前模型/);
  submitMessage('use carbon');
  await waitFor(() => payloads.length === 1);
  assert.equal(payloads[0].apiChannel, 'vertex');
  assert.equal(payloads[0].model, 'gemini-4-carbon');
  assert.equal(payloads[0].settings.thinkingLevel, 'default');
  assert.equal(JSON.stringify(payloads[0]).includes('local-gemini-key-sentinel'), false);
  assert.equal(JSON.stringify(payloads[0]).includes('apiKey'), false);
  assert.equal(JSON.parse(storage.get(GLOBAL_SETTINGS_STORAGE_KEY)).thinkingLevel, 'xhigh');
  await waitFor(() => document.querySelector('#modelButton').disabled === false);

  document.querySelector('#modelButton').click();
  document.querySelector('[data-model="gemini-4-hydrogen"]').click();
  assert.equal(document.querySelector('#thinkingModeLabel').textContent, 'Extra High');
  assert.equal(document.querySelector('#thinkingMode').disabled, false);
  document.querySelector('#thinkingMode').click();
  assert.equal(document.querySelector('#thinkingMenu [data-thinking-level="xhigh"]').disabled, false);

  document.querySelector('#settingsButton').click();
  document.querySelector('#thinkingLevelSetting').value = 'low';
  document.querySelector('#thinkingLevelSetting').dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(document.querySelector('#thinkingModeLabel').textContent, 'Low');
  assert.equal(JSON.parse(storage.get(GLOBAL_SETTINGS_STORAGE_KEY)).thinkingLevel, 'low');
  document.querySelector('#thinkingMode').click();
  document.querySelector('#thinkingMenu [data-thinking-level="high"]').click();
  assert.equal(document.querySelector('#thinkingLevelSetting').value, 'high');

  document.querySelector('#settingsCodeInput').value = createSettingsCode({
    settings: { thinkingLevel: 'xhigh', apiChannel: 'ai-studio' }, theme: 'dark',
  });
  document.querySelector('#importSettingsCode').click();
  assert.equal(JSON.parse(storage.get(GLOBAL_SETTINGS_STORAGE_KEY)).thinkingLevel, 'xhigh');
  assert.equal(JSON.parse(storage.get(GLOBAL_SETTINGS_STORAGE_KEY)).apiChannel, 'ai-studio');
  assert.equal(document.querySelector('#thinkingLevelSetting').value, 'xhigh');
  document.querySelector('#settingsDialog').close();
  document.querySelector('#modelButton').click();
  document.querySelector('[data-model="gemini-4-carbon"]').click();
  assert.equal(document.querySelector('#thinkingModeLabel').textContent, '默认');
  assert.equal(JSON.parse(storage.get(GLOBAL_SETTINGS_STORAGE_KEY)).thinkingLevel, 'xhigh');

  document.querySelector('#modelButton').click();
  document.querySelector('[data-model="gemini-auto-fixed"]').click();
  assert.equal(document.querySelector('#thinkingMode').disabled, true);
  assert.match(document.querySelector('#thinkingMode').getAttribute('aria-label'), /不能调节思考档位/);
  assert.equal(JSON.parse(storage.get(GLOBAL_SETTINGS_STORAGE_KEY)).thinkingLevel, 'xhigh');
  dom.window.close();
  await closeChatDatabase();
});

test('mobile thinking control keeps a readable label and does not overflow the composer', () => {
  const mobile = css.slice(css.indexOf('@media (max-width: 520px)'));
  assert.match(mobile, /\.thinking-depth \{[^}]*min-height:\s*44px/);
  assert.match(mobile, /\.channel-switch select \{[^}]*min-height:\s*44px/);
  assert.doesNotMatch(mobile, /\.thinking-depth span \{[^}]*display:\s*none/);
  assert.match(css, /\.thinking-depth span \{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.thinking-menu \{[^}]*backdrop-filter:\s*blur/);
});
