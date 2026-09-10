import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { loadChats } from '../ui/storage.js';

const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
const waitFor = async (check, timeout = 4000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Timed out waiting for persisted app state');
};

function installDom(indexedDB, fetchMock, storage) {
  const dom = new JSDOM(html, { url: 'https://app.example/' });
  const dialog = dom.window.document.querySelector('#settingsDialog');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new dom.window.Event('close')); };
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    localStorage: storage,
    matchMedia: () => media,
    indexedDB,
    fetch: fetchMock,
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

function createFetchMock() {
  const encoder = new TextEncoder();
  const attempts = new Map();
  const contexts = [];
  const payloads = [];
  const fetchMock = async (_, init) => {
    const payload = JSON.parse(init.body);
    payloads.push(payload);
    contexts.push(payload.messages.map(message => message.content));
    const prompt = payload.messages.at(-1).content;
    const attempt = (attempts.get(prompt) || 0) + 1;
    attempts.set(prompt, attempt);
    const longFirstAttempt = prompt.includes('长回答') && attempt === 1;
    const chunks = longFirstAttempt
      ? Array.from({ length: 40 }, (_, index) => `段落${index + 1} `)
      : prompt.includes('测试代码是什么')
        ? ['测试代码是 ', '7263。']
        : [`可控回复 ${attempt}。`];
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start' })}\n\n`));
        let index = 0;
        const timer = setInterval(() => {
          if (index < chunks.length) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'delta', text: chunks[index++] })}\n\n`));
            return;
          }
          clearInterval(timer);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'done', notice: null })}\n\n`));
          controller.close();
        }, longFirstAttempt ? 25 : 5);
        init.signal.addEventListener('abort', () => {
          clearInterval(timer);
          try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {}
        }, { once: true });
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetchMock, contexts, payloads };
}

function submitMessage(text) {
  const input = document.querySelector('#messageInput');
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#composerForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}

test('new chat lifecycle persists across refresh/reopen without duplicating demos', async () => {
  const indexedDB = new IDBFactory();
  const { fetchMock, contexts, payloads } = createFetchMock();
  const storage = createMemoryStorage();
  let dom = installDom(indexedDB, fetchMock, storage);
  await import('../ui/app.js?phase3a-browser=first');
  assert.equal((await loadChats(indexedDB)).filter(chat => chat.demo).length, 6);

  document.querySelector('#settingsButton').click();
  const defaultModel = document.querySelector('#defaultModelSetting');
  defaultModel.value = 'gemini-3.7-flash';
  defaultModel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(document.querySelector('#currentModel').textContent, 'Gemini 3.1 Pro');
  const systemInstruction = document.querySelector('#systemInstructionSetting');
  systemInstruction.value = '请始终简洁回答。';
  systemInstruction.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#contextLimitSetting').value = '10';
  document.querySelector('#contextLimitSetting').dispatchEvent(new window.Event('change', { bubbles: true }));
  document.querySelector('#maxOutputTokensSetting').value = '2048';
  document.querySelector('#maxOutputTokensSetting').dispatchEvent(new window.Event('change', { bubbles: true }));
  document.querySelector('#thinkingLevelSetting').value = 'high';
  document.querySelector('#thinkingLevelSetting').dispatchEvent(new window.Event('change', { bubbles: true }));
  document.querySelector('#samplingEnabledSetting').checked = true;
  document.querySelector('#samplingEnabledSetting').dispatchEvent(new window.Event('change', { bubbles: true }));
  document.querySelector('#settingsDialog').close();

  document.querySelector('#newChatButton').click();
  assert.equal(document.querySelector('#currentModel').textContent, 'Gemini 3.7 Flash');
  document.querySelector('#modelButton').click();
  document.querySelector('[data-model="gemini-3.1-pro-preview"]').click();
  await waitFor(async () => (await loadChats(indexedDB)).find(chat => !chat.demo)?.model === 'gemini-3.1-pro-preview');

  submitMessage('请记住测试代码 7263。');
  await waitFor(async () => {
    const message = (await loadChats(indexedDB)).find(chat => !chat.demo)?.messages.at(-1);
    return message?.role === 'assistant' && message.status === 'complete';
  });
  assert.equal(payloads[0].settings.systemInstruction, '请始终简洁回答。');
  assert.equal(payloads[0].settings.maxOutputTokens, 2048);
  assert.equal(payloads[0].settings.thinkingLevel, 'high');
  assert.equal(payloads[0].settings.samplingOverrides.enabled, true);
  submitMessage('测试代码是什么？');
  await waitFor(async () => (await loadChats(indexedDB)).find(chat => !chat.demo)?.messages.length === 4);
  assert.ok(contexts.at(-1).includes('请记住测试代码 7263。'));

  const secondUser = [...document.querySelectorAll('.message.user')].at(-1);
  secondUser.querySelector('[data-action="edit"]').click();
  const editor = document.querySelector('.edit-area textarea');
  editor.value = '我刚才让你记住的测试代码是什么？';
  document.querySelector('[data-action="edit-save"]').click();
  await waitFor(async () => {
    const chat = (await loadChats(indexedDB)).find(item => !item.demo);
    return chat?.messages[2]?.content.includes('刚才') && chat.messages.at(-1)?.role === 'assistant'
      && chat.messages.at(-1).status === 'complete';
  });

  submitMessage('请给我一个长回答');
  await waitFor(() => [...document.querySelectorAll('.message.assistant .message-content')].at(-1)?.textContent.includes('段落2'));
  document.querySelector('#sendButton').click();
  const stoppedChat = await waitFor(async () => {
    const chat = (await loadChats(indexedDB)).find(item => !item.demo);
    return chat?.messages.at(-1)?.status === 'stopped' ? chat : null;
  });
  assert.ok(stoppedChat.messages.at(-1).content.length > 0);

  document.querySelector('.message.assistant:last-child [data-action="regenerate"]').click();
  const retriedChat = await waitFor(async () => {
    const chat = (await loadChats(indexedDB)).find(item => !item.demo);
    return chat?.messages.at(-1)?.status === 'complete' ? chat : null;
  });
  const retryId = retriedChat.messages.at(-1).id;
  document.querySelector('.message.assistant:last-child [data-action="regenerate"]').click();
  const regeneratedChat = await waitFor(async () => {
    const chat = (await loadChats(indexedDB)).find(item => !item.demo);
    return chat?.messages.at(-1)?.status === 'complete' && chat.messages.at(-1).id !== retryId ? chat : null;
  });
  assert.equal(regeneratedChat.model, 'gemini-3.1-pro-preview');
  assert.equal(regeneratedChat.messages.at(-1).model, 'gemini-3.1-pro-preview');

  document.querySelector('#newChatButton').click();
  submitMessage('Chat B marker');
  await waitFor(async () => {
    const chat = (await loadChats(indexedDB)).find(item => item.title === 'Chat B marker');
    return chat?.messages.at(-1)?.role === 'assistant' && chat.messages.at(-1).status === 'complete';
  });
  const chatButtons = [...document.querySelectorAll('.chat-item')];
  chatButtons.find(button => button.textContent.includes('请记住测试代码 7263。')).click();
  chatButtons.find(button => button.textContent.includes('Chat B marker')).click();
  const chatB = (await loadChats(indexedDB)).find(item => item.title === 'Chat B marker');
  assert.equal(storage.getItem('my-ai-chat-active-chat-id'), chatB.id);

  dom.window.close();
  dom = installDom(indexedDB, fetchMock, storage);
  await import('../ui/app.js?phase3a-browser=reopen');
  const restored = await loadChats(indexedDB);
  assert.equal(restored.filter(chat => chat.demo).length, 6);
  assert.equal(restored.filter(chat => !chat.demo).length, 2);
  const userChat = restored.find(chat => chat.title === '请记住测试代码 7263。');
  assert.equal(userChat.title, '请记住测试代码 7263。');
  assert.equal(userChat.model, 'gemini-3.1-pro-preview');
  assert.ok(userChat.messages.some(message => message.content.includes('刚才')));
  assert.equal(document.querySelector('.chat-heading h1').textContent, 'Chat B marker');
  assert.equal(document.querySelector('[aria-current="true"]').dataset.chatId, chatB.id);
  document.querySelector('#settingsButton').click();
  assert.equal(document.querySelector('#defaultModelSetting').value, 'gemini-3.7-flash');
  assert.equal(document.querySelector('#systemInstructionSetting').value, '请始终简洁回答。');
  assert.equal(document.querySelector('#contextLimitSetting').value, '10');
  assert.equal(document.querySelector('#maxOutputTokensSetting').value, '2048');
  assert.equal(document.querySelector('#thinkingLevelSetting').value, 'high');
  assert.equal(document.querySelector('#samplingEnabledSetting').checked, true);
  document.querySelector('#settingsDialog').close();
  const historyButton = [...document.querySelectorAll('.chat-item')]
    .find(button => button.textContent.includes('请记住测试代码 7263。'));
  assert.ok(historyButton);
  historyButton.click();
  assert.match(document.querySelector('#conversation').textContent, /刚才让你记住/);
  assert.equal(document.querySelector('#currentModel').textContent, 'Gemini 3.1 Pro');
  dom.window.close();
});
