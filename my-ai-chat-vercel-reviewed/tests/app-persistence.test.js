import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { MODELS } from '../shared/models.js';
import { activeAssistantVariant } from '../ui/state.js';
import { closeChatDatabase, loadChats, loadStoryMemories, loadWallpaperAsset } from '../ui/storage.js';

const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
const waitFor = async (check, timeout = 4000) => {
  const started = Date.now();
  await new Promise(resolve => setTimeout(resolve, 100));
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 30));
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

const storyMemoryFixture = () => ({
  version: 1,
  scene: { location: null, time: null, presentCharacters: [], relativePositions: [], environmentState: [], importantObjects: [] },
  characters: [], relationship: { summary: '', establishedChanges: [], sharedHistory: [], unresolvedTension: [] },
  importantEvents: [], knownFacts: ['The code is 7263.'], unknownOrUnconfirmed: [], unresolvedThreads: [],
});

test('manual Story Memory update persists and becomes supplemental context after reload', async () => {
  const indexedDB = new IDBFactory(); const storage = createMemoryStorage();
  const chatFetch = createFetchMock(); let extractionPayload;
  const fetchMock = async (url, init) => {
    if (String(url).includes('/api/story-memory')) {
      extractionPayload = JSON.parse(init.body);
      return Response.json({ memory: storyMemoryFixture() });
    }
    return chatFetch.fetchMock(url, init);
  };
  let dom = installDom(indexedDB, fetchMock, storage);
  await import('../ui/app.js?story-memory=first');
  document.querySelector('#newChatButton').click(); submitMessage('Remember code 7263.');
  await waitFor(async () => (await loadChats(indexedDB)).find(item => !item.demo)?.messages.at(-1)?.status === 'complete');
  document.querySelector('[data-update-story-memory]').click();
  const snapshot = await waitFor(async () => (await loadStoryMemories(null, indexedDB))[0]);
  assert.equal(snapshot.anchorId, extractionPayload.messages.at(-1).id);
  assert.deepEqual(extractionPayload.messages.map(item => item.content), ['Remember code 7263.', '可控回复 1。']);
  assert.match(document.querySelector('.story-memory-control').textContent, /updated/i);
  submitMessage('What is the code?');
  await waitFor(async () => (await loadChats(indexedDB)).find(item => !item.demo)?.messages.length === 4);
  assert.deepEqual(chatFetch.payloads.at(-1).storyMemory.knownFacts, ['The code is 7263.']);

  dom.window.close(); dom = installDom(indexedDB, fetchMock, storage);
  await import('../ui/app.js?story-memory=reopen');
  assert.match(document.querySelector('.story-memory-control').textContent, /updated/i);
  assert.equal((await loadStoryMemories(null, indexedDB)).length, 1);
  dom.window.close(); await closeChatDatabase();
});

test('new chat lifecycle persists across refresh/reopen without duplicating demos', async () => {
  const indexedDB = new IDBFactory();
  const { fetchMock, contexts, payloads } = createFetchMock();
  const storage = createMemoryStorage();
  let dom = installDom(indexedDB, fetchMock, storage);
  await import('../ui/app.js?phase3a-browser=first');
  assert.equal((await loadChats(indexedDB)).filter(chat => chat.demo).length, 1);
  document.querySelector('#modelButton').click();
  assert.deepEqual([...document.querySelectorAll('#modelMenu [data-model]')].map(option => option.dataset.model), MODELS.map(model => model.id));
  document.querySelector('#modelButton').click();
  document.querySelector('#settingsButton').click();
  assert.deepEqual([...document.querySelectorAll('#defaultModelSetting option')].map(option => option.value), MODELS.map(model => model.id));
  document.querySelector('#settingsDialog').close();

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
    const turn = chat?.messages.at(-1), active = activeAssistantVariant(turn);
    return turn?.variants?.length === 2 && active?.status === 'complete' ? chat : null;
  });
  const retryId = retriedChat.messages.at(-1).activeVariantId;
  document.querySelector('.message.assistant:last-child [data-action="regenerate"]').click();
  const regeneratedChat = await waitFor(async () => {
    const chat = (await loadChats(indexedDB)).find(item => !item.demo);
    const turn = chat?.messages.at(-1), active = activeAssistantVariant(turn);
    return turn?.variants?.length === 3 && active?.status === 'complete' && turn.activeVariantId !== retryId ? chat : null;
  });
  assert.equal(regeneratedChat.model, 'gemini-3.1-pro-preview');
  assert.equal(activeAssistantVariant(regeneratedChat.messages.at(-1)).model, 'gemini-3.1-pro-preview');
  assert.match(document.querySelector('.variant-nav').textContent, /3\s*\/\s*3/);
  document.querySelector('[data-action="variant-prev"]').click();
  const selectedOlder = await waitFor(async () => {
    const turn = (await loadChats(indexedDB)).find(item => !item.demo)?.messages.at(-1);
    return turn?.activeVariantId === retryId ? turn : null;
  });
  assert.equal(activeAssistantVariant(selectedOlder).content, '可控回复 2。');
  document.querySelector('[data-action="variant-next"]').click();
  await waitFor(async () => {
    const turn = (await loadChats(indexedDB)).find(item => !item.demo)?.messages.at(-1);
    return activeAssistantVariant(turn)?.content === '可控回复 3。';
  });
  document.querySelector('[data-action="variant-prev"]').click();
  await waitFor(async () => {
    const turn = (await loadChats(indexedDB)).find(item => !item.demo)?.messages.at(-1);
    return turn?.activeVariantId === retryId;
  });
  submitMessage('只使用当前回复版本');
  await waitFor(async () => (await loadChats(indexedDB)).find(item => !item.demo)?.messages.length === 8);
  assert.ok(contexts.at(-1).includes('可控回复 2。'));
  assert.ok(!contexts.at(-1).includes('可控回复 3。'));
  assert.ok(!contexts.at(-1).some(content => content.includes('段落')));

  const firstChat = (await loadChats(indexedDB)).find(item => !item.demo);
  document.querySelector('#newChatButton').click();
  submitMessage('Chat B marker');
  const chatB = await waitFor(async () => {
    const chat = (await loadChats(indexedDB)).find(item => !item.demo && item.messages[0]?.content === 'Chat B marker');
    return chat?.messages.at(-1)?.role === 'assistant' && chat.messages.at(-1).status === 'complete' ? chat : null;
  });
  assert.match(chatB.title, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  const chatButtons = [...document.querySelectorAll('.chat-item')];
  chatButtons.find(button => button.dataset.chatId === firstChat.id).click();
  chatButtons.find(button => button.dataset.chatId === chatB.id).click();
  assert.equal(storage.getItem('my-ai-chat-active-chat-id'), chatB.id);

  dom.window.close();
  dom = installDom(indexedDB, fetchMock, storage);
  await import('../ui/app.js?phase3a-browser=reopen');
  const restored = await loadChats(indexedDB);
  assert.equal(restored.filter(chat => chat.demo).length, 1);
  assert.equal(restored.filter(chat => !chat.demo).length, 2);
  const userChat = restored.find(chat => chat.messages.some(message => message.content === '请记住测试代码 7263。'));
  assert.match(userChat.title, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(userChat.model, 'gemini-3.1-pro-preview');
  assert.ok(userChat.messages.some(message => message.content.includes('刚才')));
  assert.equal(document.querySelector('.chat-heading h1').textContent, chatB.title);
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
    .find(button => button.dataset.chatId === userChat.id);
  assert.ok(historyButton);
  historyButton.click();
  assert.match(document.querySelector('#conversation').textContent, /刚才让你记住/);
  assert.equal(document.querySelector('#currentModel').textContent, 'Gemini 3.1 Pro');
  dom.window.close();
  await closeChatDatabase();
});

test('Edit and resend works for first, middle and last historical user messages', async () => {
  const indexedDB = new IDBFactory();
  const { fetchMock, contexts } = createFetchMock();
  const storage = createMemoryStorage();
  const dom = installDom(indexedDB, fetchMock, storage);
  await import('../ui/app.js?history-edit=all-positions');
  document.querySelector('#newChatButton').click();
  let stableTitle;

  for (const prompt of ['A1', 'A2', 'A3']) {
    submitMessage(prompt);
    await waitFor(async () => {
      const chat = (await loadChats(indexedDB)).find(item => !item.demo);
      return chat?.messages.at(-1)?.role === 'assistant' && chat.messages.at(-1).status === 'complete'
        && chat.messages.at(-2)?.content === prompt;
    });
    stableTitle ||= (await loadChats(indexedDB)).find(item => !item.demo).title;
  }

  let users = [...document.querySelectorAll('.message.user')];
  users[1].querySelector('[data-action="edit"]').click();
  document.querySelector('.edit-area textarea').value = 'cancelled edit';
  document.querySelector('[data-action="edit-cancel"]').click();
  assert.deepEqual((await loadChats(indexedDB)).find(item => !item.demo).messages.filter(message => message.role === 'user').map(message => message.content), ['A1', 'A2', 'A3']);

  users = [...document.querySelectorAll('.message.user')];
  users[1].querySelector('[data-action="edit"]').click();
  document.querySelector('.edit-area textarea').value = 'A2 revised';
  document.querySelector('[data-action="edit-save"]').click();
  let edited = await waitFor(async () => {
    const chat = (await loadChats(indexedDB)).find(item => !item.demo);
    return chat?.messages.length === 4 && chat.messages.at(-1).status === 'complete' ? chat : null;
  });
  assert.deepEqual(edited.messages.filter(message => message.role === 'user').map(message => message.content), ['A1', 'A2 revised']);
  assert.deepEqual(contexts.at(-1), ['A1', '可控回复 1。', 'A2 revised']);
  assert.ok(!contexts.at(-1).includes('A2'));
  assert.ok(!contexts.at(-1).includes('A3'));

  users = [...document.querySelectorAll('.message.user')];
  users[0].querySelector('[data-action="edit"]').click();
  document.querySelector('.edit-area textarea').value = 'A1 revised';
  document.querySelector('[data-action="edit-save"]').click();
  edited = await waitFor(async () => {
    const chat = (await loadChats(indexedDB)).find(item => !item.demo);
    return chat?.messages.length === 2 && chat.messages[0].content === 'A1 revised' && chat.messages.at(-1).status === 'complete' ? chat : null;
  });
  assert.deepEqual(contexts.at(-1), ['A1 revised']);
  assert.equal(edited.title, stableTitle);

  submitMessage('last user');
  await waitFor(async () => (await loadChats(indexedDB)).find(item => !item.demo)?.messages.length === 4);
  users = [...document.querySelectorAll('.message.user')];
  users.at(-1).querySelector('[data-action="edit"]').click();
  document.querySelector('.edit-area textarea').value = 'last user revised';
  document.querySelector('[data-action="edit-save"]').click();
  edited = await waitFor(async () => {
    const chat = (await loadChats(indexedDB)).find(item => !item.demo);
    return chat?.messages.length === 4 && chat.messages[2].content === 'last user revised'
      && chat.messages.at(-1).status === 'complete' ? chat : null;
  });
  assert.deepEqual(contexts.at(-1), ['A1 revised', '可控回复 1。', 'last user revised']);
  assert.ok(!contexts.at(-1).includes('last user'));
  assert.equal(edited.messages.at(-1).model, edited.model);
  assert.ok(edited.messages[2].updatedAt);
  dom.window.close();
  await closeChatDatabase();
});

test('variant switching restores independent descendant branches and persists the visible path', async () => {
  const indexedDB = new IDBFactory();
  const { fetchMock, contexts } = createFetchMock();
  const storage = createMemoryStorage();
  let dom = installDom(indexedDB, fetchMock, storage);
  await import('../ui/app.js?branch-aware-variants=first');
  document.querySelector('#newChatButton').click();

  submitMessage('branch A');
  await waitFor(async () => {
    const last = (await loadChats(indexedDB)).find(item => !item.demo)?.messages.at(-1);
    return last?.role === 'assistant' && last.status === 'complete';
  });
  document.querySelector('.message.assistant [data-action="regenerate"]').click();
  await waitFor(async () => {
    const turn = (await loadChats(indexedDB)).find(item => !item.demo)?.messages[1];
    return turn?.variants?.length === 2 && activeAssistantVariant(turn).status === 'complete';
  });

  document.querySelector('.message.assistant [data-action="variant-prev"]').click();
  submitMessage('branch C');
  await waitFor(async () => (await loadChats(indexedDB)).find(item => !item.demo)?.messages.length === 4);
  assert.deepEqual(contexts.at(-1), ['branch A', '可控回复 1。', 'branch C']);

  document.querySelector('.message.assistant [data-action="variant-next"]').click();
  assert.deepEqual([...document.querySelectorAll('.message.user .message-bubble p')].map(item => item.textContent), ['branch A']);
  assert.equal((await loadChats(indexedDB)).find(item => !item.demo).messages.length, 4);

  submitMessage('branch C2');
  await waitFor(async () => (await loadChats(indexedDB)).find(item => !item.demo)?.messages.length === 6);
  assert.deepEqual(contexts.at(-1), ['branch A', '可控回复 2。', 'branch C2']);

  document.querySelector('.message.assistant [data-action="variant-prev"]').click();
  assert.deepEqual([...document.querySelectorAll('.message.user .message-bubble p')].map(item => item.textContent), ['branch A', 'branch C']);
  document.querySelector('.message.assistant [data-action="variant-next"]').click();
  assert.deepEqual([...document.querySelectorAll('.message.user .message-bubble p')].map(item => item.textContent), ['branch A', 'branch C2']);

  const beforeReload = (await loadChats(indexedDB)).find(item => !item.demo);
  assert.equal(beforeReload.messages.length, 6);
  const originalC = beforeReload.messages.find(message => message.content === 'branch C');
  const originalD = beforeReload.messages.find(message => message.parentUserId === originalC.id);
  const originalC2 = beforeReload.messages.find(message => message.content === 'branch C2');
  const originalD2 = beforeReload.messages.find(message => message.parentUserId === originalC2.id);
  dom.window.close();
  dom = installDom(indexedDB, fetchMock, storage);
  await import('../ui/app.js?branch-aware-variants=reopen');
  assert.deepEqual([...document.querySelectorAll('.message.user .message-bubble p')].map(item => item.textContent), ['branch A', 'branch C2']);
  assert.equal((await loadChats(indexedDB)).find(item => !item.demo).messages.length, 6);

  document.querySelector('.message.assistant [data-action="variant-prev"]').click();
  const branchC = [...document.querySelectorAll('.message.user')].at(-1);
  branchC.querySelector('[data-action="edit"]').click();
  document.querySelector('.edit-area textarea').value = 'branch C edited';
  document.querySelector('[data-action="edit-save"]').click();
  const afterEdit = await waitFor(async () => {
    const chat = (await loadChats(indexedDB)).find(item => !item.demo);
    const editedUser = chat?.messages.find(message => message.content === 'branch C edited');
    const editedReply = chat?.messages.find(message => message.parentUserId === editedUser?.id);
    return editedReply?.status === 'complete'
      && chat.messages.some(message => message.id === originalC2.id)
      && chat.messages.some(message => message.id === originalD2.id) ? chat : null;
  });
  assert.ok(!afterEdit.messages.some(message => message.id === originalD.id));
  document.querySelector('.message.assistant [data-action="variant-next"]').click();
  assert.deepEqual([...document.querySelectorAll('.message.user .message-bubble p')].map(item => item.textContent), ['branch A', 'branch C2']);
  dom.window.close();
  await closeChatDatabase();
});

test('Wallpaper Settings persists, restores, replaces and removes a local Blob', async () => {
  const indexedDB = new IDBFactory();
  const { fetchMock } = createFetchMock();
  const storage = createMemoryStorage();
  const revoked = [];
  let urlSequence = 0;
  globalThis.URL = {
    createObjectURL: () => `blob:app-wallpaper-${++urlSequence}`,
    revokeObjectURL: url => revoked.push(url),
  };
  globalThis.Image = class {
    naturalWidth = 2400;
    naturalHeight = 1600;
    set src(_) { queueMicrotask(() => this.onload?.()); }
  };
  const image = (name, type) => {
    const blob = new Blob(['valid image bytes'], { type });
    Object.defineProperty(blob, 'name', { value: name });
    return blob;
  };
  const selectWallpaper = file => {
    const input = document.querySelector('#wallpaperInput');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  let dom = installDom(indexedDB, fetchMock, storage);
  await import('../ui/app.js?wallpaper=first');
  document.querySelector('#settingsButton').click();
  selectWallpaper(image('desktop.jpg', 'image/jpeg'));
  await waitFor(async () => (await loadWallpaperAsset(indexedDB))?.name === 'desktop.jpg');
  await waitFor(() => document.querySelector('#chooseWallpaper').textContent === 'Change Image');
  assert.equal(document.querySelector('#conversation').classList.contains('has-wallpaper'), true);
  assert.equal(document.querySelector('#chooseWallpaper').textContent, 'Change Image');

  dom.window.dispatchEvent(new dom.window.Event('pagehide'));
  dom.window.close();
  dom = installDom(indexedDB, fetchMock, storage);
  await import('../ui/app.js?wallpaper=reopen');
  assert.equal(document.querySelector('#conversation').classList.contains('has-wallpaper'), true);
  document.querySelector('#settingsButton').click();
  assert.equal(document.querySelector('#wallpaperName').textContent, 'desktop.jpg');

  selectWallpaper({ name: 'notes.txt', type: 'text/plain', size: 20 });
  await waitFor(() => document.querySelector('#toast').textContent.includes('JPEG, PNG, or WebP'));
  assert.equal((await loadWallpaperAsset(indexedDB)).name, 'desktop.jpg');
  await waitFor(() => !document.querySelector('#chooseWallpaper').disabled);
  selectWallpaper({ name: 'huge.jpg', type: 'image/jpeg', size: 26 * 1024 * 1024 });
  await waitFor(() => document.querySelector('#toast').textContent.includes('25 MB'));
  assert.equal((await loadWallpaperAsset(indexedDB)).name, 'desktop.jpg');
  await waitFor(() => !document.querySelector('#chooseWallpaper').disabled);

  selectWallpaper(image('mobile.webp', 'image/webp'));
  await waitFor(async () => (await loadWallpaperAsset(indexedDB))?.name === 'mobile.webp');
  await waitFor(() => document.querySelector('#wallpaperName').textContent === 'mobile.webp');
  assert.equal(document.querySelector('#wallpaperName').textContent, 'mobile.webp');
  document.querySelector('#removeWallpaper').click();
  await waitFor(async () => (await loadWallpaperAsset(indexedDB)) === null);
  await waitFor(() => !document.querySelector('#conversation').classList.contains('has-wallpaper'));
  assert.equal(document.querySelector('#conversation').classList.contains('has-wallpaper'), false);

  dom.window.close();
  dom = installDom(indexedDB, fetchMock, storage);
  await import('../ui/app.js?wallpaper=removed-reopen');
  assert.equal(document.querySelector('#conversation').classList.contains('has-wallpaper'), false);
  assert.ok(revoked.length >= 2);
  dom.window.close();
  await closeChatDatabase();
});
