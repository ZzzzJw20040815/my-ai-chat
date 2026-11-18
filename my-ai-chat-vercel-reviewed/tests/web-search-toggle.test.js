import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { GLOBAL_SETTINGS_STORAGE_KEY } from '../shared/settings.js';
import { closeChatDatabase } from '../ui/storage.js';

const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('../ui/styles.css', import.meta.url), 'utf8');

function installDom(indexedDB, fetchMock, storage) {
  const dom = new JSDOM(html, { url: 'https://app.example/' });
  const dialog = dom.window.document.querySelector('#settingsDialog');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new dom.window.Event('close')); };
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, DOMParser: dom.window.DOMParser,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    localStorage: storage, matchMedia: () => media, indexedDB, fetch: fetchMock,
    ResizeObserver: class { observe() {} disconnect() {} },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  return dom;
}

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    clear: () => values.clear(),
  };
}

const waitFor = async (check, timeout = 4000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for chat request');
};

test('web search switch turns off, stays off, and the next chat request sends off', async () => {
  const indexedDB = new IDBFactory();
  const payloads = [];
  const fetchMock = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"start"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"delta","text":"ok"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"done","notice":null}\n\n'));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const storage = createMemoryStorage();
  const dom = installDom(indexedDB, fetchMock, storage);
  await import('../ui/app.js?web-search-toggle=1');
  document.querySelector('#settingsButton').click();
  const toggle = document.querySelector('#webSearchSetting');
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);
  // iPhone Safari fires two clicks for one tap on a checkbox inside its label.
  toggle.click();
  toggle.click();
  await Promise.resolve();
  assert.equal(toggle.checked, false);
  assert.equal(JSON.parse(storage.getItem(GLOBAL_SETTINGS_STORAGE_KEY)).webSearch, 'off');
  document.querySelector('#settingsDialog').close();
  document.querySelector('#settingsButton').click();
  assert.equal(document.querySelector('#webSearchSetting').checked, false);
  document.querySelector('#webSearchSetting').click();
  await Promise.resolve();
  assert.equal(document.querySelector('#webSearchSetting').checked, true);
  assert.equal(JSON.parse(storage.getItem(GLOBAL_SETTINGS_STORAGE_KEY)).webSearch, 'on');
  document.querySelector('#webSearchSetting').click();
  await Promise.resolve();
  assert.equal(JSON.parse(storage.getItem(GLOBAL_SETTINGS_STORAGE_KEY)).webSearch, 'off');
  document.querySelector('#settingsDialog').close();
  const input = document.querySelector('#messageInput');
  input.value = '关闭搜索后再问';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  document.querySelector('#composerForm').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => payloads.length);
  assert.equal(payloads[0].settings.webSearch, 'off');
  assert.match(css, /\.web-search-toggle input\s*\{[^}]*-webkit-appearance:\s*none/);
  assert.match(css, /\.web-search-toggle input\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/);
  assert.match(css, /\.web-search-toggle input:checked\s*\{/);
  dom.window.close();
  await closeChatDatabase();
});
