import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import api from '../api/chat.js';
import { ERROR_TEXT, validatePayload } from '../server/chat.js';
import {
  isManualContinuationPrompt, manualContinuationAnchor, systemInstructionWithContinuationAnchor,
} from '../shared/story-runtime.js';
import { createChat, createMessage, contextFor } from '../ui/state.js';
import { createRuntimeControl } from '../ui/story-runtime.js';
import { closeChatDatabase, loadChats } from '../ui/storage.js';

const MODEL = 'gemini-3.1-pro-preview';
const WARNING = '回复被安全机制拦住了，请不要把这句话写进正文。';

function pair(userText, assistantText, status = 'complete', error = null) {
  const user = createMessage('user', userText);
  const assistant = createMessage('assistant', assistantText, MODEL);
  assistant.parentUserId = user.id;
  assistant.status = status;
  if (error) assistant.error = error;
  return { user, assistant };
}

test('manual continue keeps the partial body and drops the warning from model content', () => {
  const chat = createChat(MODEL);
  const first = pair('a', '完整回答甲。');
  const second = pair('b', '半截正文乙。', 'error', WARNING);
  const follow = createMessage('user', '你的输出未完整 请继续输出');
  follow.parentVariantId = second.assistant.id;
  chat.messages.push(first.user, first.assistant, second.user, second.assistant, follow);
  const messages = contextFor(chat, follow.id);
  assert.deepEqual(messages.map(message => message.content), ['a', '完整回答甲。', 'b', '半截正文乙。', '你的输出未完整 请继续输出']);
  assert.equal(messages[3].status, 'error');
  assert.equal(JSON.stringify(messages).includes(WARNING), false);
  const validated = validatePayload({ model: MODEL, messages });
  assert.deepEqual(validated.contents.map(item => item.parts[0].text), messages.map(message => message.content));
  assert.equal(systemInstructionWithContinuationAnchor('', follow.content, second.assistant).includes(manualContinuationAnchor()), true);
  assert.equal(second.assistant.content, '半截正文乙。');
  assert.equal(second.assistant.error, WARNING);
});

test('a zero-length block does not create an empty model turn', () => {
  const chat = createChat(MODEL);
  const first = pair('a', '完整回答甲。');
  const blockedUser = createMessage('user', 'b');
  const blocked = createMessage('assistant', '   ', MODEL);
  blocked.parentUserId = blockedUser.id;
  blocked.status = 'error';
  blocked.error = ERROR_TEXT.SAFETY_BLOCKED;
  const follow = createMessage('user', 'c');
  chat.messages.push(first.user, first.assistant, blockedUser, blocked, follow);
  const messages = contextFor(chat, follow.id);
  assert.deepEqual(messages.map(message => message.content), ['a', '完整回答甲。', 'c']);
  assert.equal(messages.some(message => message.role === 'assistant' && !message.content.trim()), false);
  assert.throws(() => validatePayload({
    model: MODEL,
    messages: [{ id: 'u', role: 'user', content: 'b', status: 'complete' }, { id: 'a', role: 'assistant', content: ' ', status: 'error' }],
  }), /INVALID_REQUEST/);
});

test('stopped replies stay out of ordinary follow-ups and explicit continue phrases can bring back only that partial', () => {
  const chat = createChat(MODEL);
  const stopped = pair('停下的问题', '用户停住的半句', 'stopped');
  const ordinary = createMessage('user', '普通追问');
  chat.messages.push(stopped.user, stopped.assistant, ordinary);
  assert.deepEqual(contextFor(chat, ordinary.id).map(message => message.content), ['普通追问']);
  chat.messages.pop();
  const manual = createMessage('user', '继续');
  chat.messages.push(manual);
  const continued = contextFor(chat, manual.id);
  assert.deepEqual(continued.map(message => message.content), ['停下的问题', '用户停住的半句', '继续']);
  assert.equal(continued[1].status, 'interrupted');
  assert.throws(() => validatePayload({
    model: MODEL,
    messages: [{ id: 'u', role: 'user', content: '问', status: 'complete' }, { id: 'a', role: 'assistant', content: '半句', status: 'stopped' }],
  }), /INVALID_REQUEST/);
  assert.equal(isManualContinuationPrompt('请继续聊聊别的'), false);
  assert.equal(systemInstructionWithContinuationAnchor('保持简洁', '今天天气怎么样', stopped.assistant), '保持简洁');
});

test('normal-mode continue button adds the existing anchor without a story runtime policy', () => {
  const chat = createChat(MODEL);
  const partial = pair('b', '半截正文乙。', 'blocked', WARNING);
  const control = createRuntimeControl('continue_incomplete', partial.assistant.id);
  chat.messages.push(partial.user, partial.assistant, control);
  const messages = contextFor(chat, control.id, 'all', { clientContinuationAnchor: true });
  assert.deepEqual(messages.map(message => message.content), ['b', '半截正文乙。', manualContinuationAnchor()]);
  assert.equal(JSON.stringify(messages).includes(WARNING), false);
  const validated = validatePayload({ model: MODEL, messages });
  assert.equal(validated.contents.at(-1).parts[0].text, manualContinuationAnchor());
  assert.equal(validated.config.systemInstruction, undefined);
});

test('setup and writing clicks keep the partial and anchor the server continuation', () => {
  const partial = { id: 'b2', role: 'assistant', content: '靠窗的座位是空的。', status: 'error', error: WARNING };
  const messages = [
    { id: 'b', role: 'user', content: '构思一个中性场景', status: 'complete' },
    partial,
  ];
  for (const mode of ['setup', 'writing']) {
    const result = validatePayload({ model: MODEL, messages, storyRuntime: { mode, action: 'continue_incomplete' } });
    assert.deepEqual(result.contents.map(item => item.role), ['user', 'model', 'user']);
    assert.equal(result.contents[1].parts[0].text, '靠窗的座位是空的。');
    assert.equal(result.contents.at(-1).parts[0].text, manualContinuationAnchor());
    assert.match(result.config.systemInstruction, /Continue directly from the end/);
    assert.equal(JSON.stringify(result.contents).includes(WARNING), false);
  }
  assert.match(validatePayload({
    model: MODEL, messages, storyRuntime: { mode: 'setup', action: 'continue_incomplete' },
  }).config.systemInstruction, /SETUP MODE/);
  assert.match(validatePayload({
    model: MODEL, messages, storyRuntime: { mode: 'writing', action: 'continue_incomplete' },
  }).config.systemInstruction, /WRITING MODE/);
});

const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
const waitFor = async (check, timeout = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the chat flow');
};
function installDom(indexedDB) {
  const dom = new JSDOM(html, { url: 'https://app.example/' });
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, DOMParser: dom.window.DOMParser,
    Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {}, clear() {} },
    matchMedia: () => media, indexedDB, ResizeObserver: class { observe() {} disconnect() {} },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  return dom;
}
function submitMessage(text) {
  const input = document.querySelector('#messageInput');
  input.value = text;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#composerForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
}
const encoder = new TextEncoder();
const sse = payload => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
const textEvent = (text, finishReason, safetyRatings) => sse({
  candidates: [{
    content: { role: 'model', parts: text ? [{ text }] : [] },
    ...(finishReason ? { finishReason } : {}),
    ...(safetyRatings ? { safetyRatings } : {}),
  }],
});
const SAFETY_RATINGS = [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'LOW', blocked: true }];

function upstreamResponse(body, signal) {
  const last = [...(body.contents || [])].reverse().find(item => item.role === 'user');
  const text = (last?.parts || []).map(part => part.text || '').join('\n');
  const models = (body.contents || []).filter(item => item.role === 'model')
    .map(item => (item.parts || []).map(part => part.text || '').join('')).join('\n');
  const response = (start) => new Response(new ReadableStream({ start }), { headers: { 'Content-Type': 'text/event-stream' } });
  const finish = value => response(controller => { controller.enqueue(textEvent(value, 'STOP')); controller.close(); });
  if (text.includes('Begin the formal story')) return finish('正式开场只有一句。');
  if (text.includes('exact ending') || text.includes('Continue directly')) {
    if (models.includes('巷口')) return finish('随后灯灭了。');
    if (models.includes('靠窗')) return finish('灯光很稳。');
    return finish('后续丙。');
  }
  if (text.includes('第一句')) return finish('完整回答甲。');
  if (text.includes('第二句')) return response(controller => {
    controller.enqueue(textEvent('半截正文乙。'));
    controller.enqueue(textEvent('', 'SAFETY', SAFETY_RATINGS));
    controller.close();
  });
  if (text.includes('你的输出未完整')) return finish('后续丙。');
  if (text.includes('天气半截')) return response(controller => {
    controller.enqueue(textEvent('半截天气。'));
    controller.enqueue(textEvent('', 'SAFETY', SAFETY_RATINGS));
    controller.close();
  });
  if (text.includes('今天天气怎么样')) return finish('天气很好。');
  if (text.includes('零字提问')) return response(controller => { controller.enqueue(textEvent('', 'SAFETY', SAFETY_RATINGS)); controller.close(); });
  if (text.includes('零字之后')) return finish('零字后的回答。');
  if (text.includes('异常流')) {
    const count = upstreamResponse.eofCount = (upstreamResponse.eofCount || 0) + 1;
    if (count === 1) return response(controller => {
      controller.enqueue(textEvent('流中断前的句子。'));
      setTimeout(() => { try { controller.error(new Error('upstream reset')); } catch { /* already closed */ } }, 30);
    });
    return finish('重试后的完整句子。');
  }
  if (text.includes('请慢慢写')) return response(controller => {
    controller.enqueue(textEvent('已经写出的半句'));
    const fail = reason => { try { controller.error(reason); } catch { /* already closed */ } };
    const timer = setTimeout(() => fail(new Error('stop was not observed')), 8000);
    const abort = () => { clearTimeout(timer); fail(new DOMException('Aborted', 'AbortError')); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  if (text.includes('普通追问')) return finish('普通回答。');
  if (text.includes('构思一个')) return response(controller => {
    controller.enqueue(textEvent('靠窗的座位是空的。'));
    controller.enqueue(textEvent('', 'SAFETY', SAFETY_RATINGS));
    controller.close();
  });
  if (text.includes('请写下一小段')) return response(controller => {
    controller.enqueue(textEvent('巷口的灯还亮着。'));
    setTimeout(() => { try { controller.error(new Error('upstream reset')); } catch { /* already closed */ } }, 30);
  });
  throw new Error(`Unexpected upstream prompt: ${text.slice(0, 120)}`);
}

test('browser flows keep partial text through the real chat API for safety, EOF, stop, and story continuation', { timeout: 30000 }, async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = 'unit-test-sentinel-not-a-key';
  const indexedDB = new IDBFactory();
  const dom = installDom(indexedDB);
  const appPayloads = [];
  const geminiBodies = [];
  let upstreamSignal = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/models')) return Response.json({ error: { message: 'unavailable' } }, { status: 503 });
    if (url.includes('/api/chat')) {
      appPayloads.push(JSON.parse(init.body));
      return api.fetch(new Request('https://app.example/api/chat', {
        method: 'POST', headers: init.headers, body: init.body, signal: init.signal,
      }));
    }
    if (String(url).includes('generativelanguage.googleapis.com')) {
      assert.equal(String(url).includes('unit-test-sentinel'), false);
      const body = JSON.parse(init.body);
      geminiBodies.push(body);
      upstreamSignal = init.signal;
      return upstreamResponse(body, init.signal);
    }
    throw new Error(`Blocked unexpected network request to ${url}`);
  };
  try {
    await import('../ui/app.js?partial-continuation=browser');
    const contents = payload => payload.messages.map(message => message.content);
    const clickNew = async () => {
      document.querySelector('#newChatButton').click();
      await waitFor(() => document.querySelector('#conversation h1')?.textContent === 'What would you like to explore?');
    };
    const articles = () => [...document.querySelectorAll('.message.assistant .message-content')].map(node => node.textContent);
    const hasArticle = text => articles().some(value => value.includes(text));
    await clickNew();

    submitMessage('第一句');
    await waitFor(() => hasArticle('完整回答甲。'));
    submitMessage('第二句');
    await waitFor(() => hasArticle('半截正文乙。') && document.querySelector('.error-note')?.textContent.includes('Harassment'));
    assert.ok(document.querySelector('[data-action="continue-incomplete"]'));
    assert.ok(document.querySelector('[data-story-runtime-action="continue_incomplete"]'));
    const safetyCount = appPayloads.length;
    submitMessage('你的输出未完整 请继续输出');
    const caseOne = await waitFor(() => appPayloads.length > safetyCount && contents(appPayloads.at(-1)).at(-1) === '你的输出未完整 请继续输出' ? appPayloads.at(-1) : null);
    assert.deepEqual(contents(caseOne), ['第一句', '完整回答甲。', '第二句', '半截正文乙。', '你的输出未完整 请继续输出']);
    assert.equal(JSON.stringify(caseOne.messages).includes('Harassment'), false);
    assert.equal(JSON.stringify(caseOne.messages).includes('安全设置'), false);
    assert.match(caseOne.settings.systemInstruction, /exact ending/);
    await waitFor(() => hasArticle('后续丙。'));
    const forwarded = geminiBodies.find(body => (body.contents || []).some(item => (item.parts || []).some(part => part.text === '你的输出未完整 请继续输出')));
    assert.deepEqual(forwarded.contents.map(item => item.parts.map(part => part.text).join('')), contents(caseOne));
    assert.ok(hasArticle('半截正文乙。'));
    const saved = (await loadChats()).find(chat => chat.messages.some(message => message.content === '半截正文乙。'
      || message.variants?.some(variant => variant.content === '半截正文乙。')));
    const partial = saved.messages.find(message => message.content === '半截正文乙。' || message.variants?.some(variant => variant.content === '半截正文乙。'));
    const partialVariant = partial.variants?.find(variant => variant.content === '半截正文乙。') || partial;
    assert.equal(partialVariant.status, 'error');
    assert.match(partialVariant.error, /Harassment/);
    assert.equal(partialVariant.content, '半截正文乙。');

    await clickNew();
    submitMessage('天气半截');
    await waitFor(() => hasArticle('半截天气。'));
    const weatherCount = appPayloads.length;
    submitMessage('今天天气怎么样');
    const weather = await waitFor(() => appPayloads.length > weatherCount && contents(appPayloads.at(-1)).at(-1) === '今天天气怎么样' ? appPayloads.at(-1) : null);
    assert.deepEqual(contents(weather), ['天气半截', '半截天气。', '今天天气怎么样']);
    assert.equal(weather.settings.systemInstruction.includes('exact ending'), false);
    await waitFor(() => hasArticle('天气很好。'));

    await clickNew();
    submitMessage('零字提问');
    await waitFor(() => document.querySelector('.error-note')?.textContent.includes('安全设置'));
    assert.equal(articles().some(text => text.trim()), false);
    const zeroCount = appPayloads.length;
    submitMessage('零字之后');
    const zero = await waitFor(() => appPayloads.length > zeroCount && contents(appPayloads.at(-1)).at(-1) === '零字之后' ? appPayloads.at(-1) : null);
    assert.deepEqual(contents(zero), ['零字之后']);
    assert.equal(zero.messages.some(message => message.role === 'assistant'), false);
    await waitFor(() => hasArticle('零字后的回答。'));

    await clickNew();
    submitMessage('异常流');
    await waitFor(() => hasArticle('流中断前的句子。') && document.querySelector('.error-note'));
    const eofCount = appPayloads.length;
    document.querySelector('[data-action="regenerate"]').click();
    const retry = await waitFor(() => appPayloads.length > eofCount ? appPayloads.at(-1) : null);
    assert.equal(contents(retry).includes('流中断前的句子。'), false);
    assert.equal(contents(retry).at(-1), '异常流');
    await waitFor(() => hasArticle('重试后的完整句子。'));
    const eofChat = (await loadChats()).find(chat => chat.messages.some(message => message.content === '异常流'));
    const eofTurn = eofChat.messages.find(message => message.role === 'assistant');
    assert.ok(eofTurn.variants.some(variant => variant.content === '流中断前的句子。' && variant.status === 'error'));
    assert.equal(eofTurn.variants.find(variant => variant.id === eofTurn.activeVariantId).content, '重试后的完整句子。');

    await clickNew();
    submitMessage('请慢慢写');
    await waitFor(() => hasArticle('已经写出的半句'));
    document.querySelector('#sendButton').click();
    await waitFor(() => document.body.textContent.includes('Stopped · partial response excluded from context')
      && document.querySelector('#sendButton').getAttribute('aria-label') === 'Send message');
    assert.equal(upstreamSignal.aborted, true);
    const stopCount = appPayloads.length;
    submitMessage('普通追问');
    const stoppedFollow = await waitFor(() => appPayloads.length > stopCount && contents(appPayloads.at(-1)).at(-1) === '普通追问' ? appPayloads.at(-1) : null);
    assert.deepEqual(contents(stoppedFollow), ['普通追问']);
    await waitFor(() => hasArticle('普通回答。'));

    await clickNew();
    document.querySelector('[data-story-runtime-action="prepare_story"]').click();
    await waitFor(() => document.body.textContent.includes('构思中'));
    submitMessage('构思一个中性场景');
    await waitFor(() => hasArticle('靠窗的座位是空的。'));
    const setupCount = appPayloads.length;
    document.querySelector('[data-action="continue-incomplete"]').click();
    const setupClick = await waitFor(() => appPayloads.length > setupCount && appPayloads.at(-1).storyRuntime?.action === 'continue_incomplete' ? appPayloads.at(-1) : null);
    assert.equal(setupClick.storyRuntime.mode, 'setup');
    assert.equal(contents(setupClick).includes('靠窗的座位是空的。'), true);
    assert.equal(JSON.stringify(setupClick.messages).includes('Harassment'), false);
    await waitFor(() => hasArticle('灯光很稳。'));
    const setupGemini = geminiBodies.find(body => (body.contents || []).at(-1)?.parts?.[0]?.text === manualContinuationAnchor()
      && (body.contents || []).some(item => (item.parts || []).some(part => part.text === '靠窗的座位是空的。')));
    assert.ok(setupGemini);
    assert.match(setupGemini.systemInstruction.parts[0].text, /SETUP MODE/);
    assert.ok(hasArticle('靠窗的座位是空的。'));

    document.querySelector('[data-story-runtime-action="start_writing"]').click();
    await waitFor(() => hasArticle('正式开场只有一句。') && document.body.textContent.includes('正文中'));
    submitMessage('请写下一小段');
    await waitFor(() => hasArticle('巷口的灯还亮着。') && document.querySelector('[data-action="continue-incomplete"]'));
    const writingCount = appPayloads.length;
    document.querySelector('[data-action="continue-incomplete"]').click();
    const writingClick = await waitFor(() => appPayloads.length > writingCount && appPayloads.at(-1).storyRuntime?.mode === 'writing' && appPayloads.at(-1).storyRuntime?.action === 'continue_incomplete' ? appPayloads.at(-1) : null);
    assert.equal(contents(writingClick).includes('巷口的灯还亮着。'), true);
    await waitFor(() => hasArticle('随后灯灭了。'));
    const writingGemini = geminiBodies.find(body => (body.contents || []).at(-1)?.parts?.[0]?.text === manualContinuationAnchor()
      && (body.contents || []).some(item => (item.parts || []).some(part => (part.text || '').includes('巷口的灯还亮着。'))));
    assert.ok(writingGemini);
    assert.match(writingGemini.systemInstruction.parts[0].text, /WRITING MODE/);
    assert.ok(articles().some(text => text.includes('巷口的灯还亮着。') && !text.includes('随后灯灭了。')));
    dom.window.close();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    await closeChatDatabase();
  }
});
