import test from 'node:test';
import assert from 'node:assert/strict';
import api from '../api/chat.js';
import {
  ERROR_TEXT, MAX_VISIBLE_OUTPUT_CHARS, clipVisibleText, handleChat, validatePayload,
} from '../server/chat.js';
import { createChat, createMessage, contextFor } from '../ui/state.js';
import { continuationAvailability, createRuntimeControl, setStoryRuntimeMode } from '../ui/story-runtime.js';

const MODEL = 'gemini-3.1-pro-preview';
const env = { GEMINI_API_KEY: 'unit-test-sentinel-not-a-key' };
const userMessage = (content = '请继续写') => ({ id: 'u1', role: 'user', content, status: 'complete' });
const request = (data = { model: MODEL, messages: [userMessage()] }, options = {}) => new Request('https://app.example/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://app.example' },
  body: JSON.stringify(data),
  ...options,
});
async function events(response) {
  const text = await response.text();
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line.startsWith('data:') ? line.slice(5).trimStart() : line));
}
const visible = output => output.filter(event => event.type === 'delta').map(event => event.text).join('');

test('visible text is clipped at the output cap without calling the limit a conversation error', async () => {
  const split = await events(await handleChat(request(), env, async function* () {
    yield { text: 'A'.repeat(60000) };
    yield { text: 'B'.repeat(60000), candidates: [{ finishReason: 'STOP' }] };
  }));
  const splitText = visible(split);
  assert.equal(splitText.length, MAX_VISIBLE_OUTPUT_CHARS);
  assert.equal(splitText, 'A'.repeat(60000) + 'B'.repeat(40000));
  assert.equal(split.at(-1).type, 'done');
  assert.equal(split.at(-1).completionReason, 'max_tokens');
  assert.equal(split.at(-1).notice, ERROR_TEXT.TRUNCATED);
  assert.equal(JSON.stringify(split).includes('新建聊天'), false);
  assert.equal(JSON.stringify(split).includes(ERROR_TEXT.CONTEXT_LIMIT), false);

  const first = await events(await handleChat(request(), env, async function* () {
    yield { text: 'C'.repeat(MAX_VISIBLE_OUTPUT_CHARS + 1), candidates: [{ finishReason: 'STOP' }] };
  }));
  assert.equal(visible(first), 'C'.repeat(MAX_VISIBLE_OUTPUT_CHARS));
  assert.equal(first.at(-1).completionReason, 'max_tokens');

  const exact = await events(await handleChat(request(), env, async function* () {
    yield { text: 'D'.repeat(MAX_VISIBLE_OUTPUT_CHARS), candidates: [{ finishReason: 'STOP' }] };
  }));
  assert.equal(visible(exact), 'D'.repeat(MAX_VISIBLE_OUTPUT_CHARS));
  assert.equal(exact.at(-1).completionReason, 'complete');
  assert.equal(exact.at(-1).notice, null);

  const repeated = await events(await handleChat(request(), env, async function* () {
    yield { text: '哈'.repeat(3) };
    yield { text: '哈'.repeat(3), candidates: [{ finishReason: 'STOP' }] };
  }));
  assert.equal(visible(repeated), '哈'.repeat(6));
  assert.equal(repeated.at(-1).completionReason, 'complete');
});

test('the output cap keeps whole Unicode characters and still rejects oversized inputs', async () => {
  const emoji = '😀';
  assert.equal(emoji.length, 2);
  assert.equal(clipVisibleText('A'.repeat(99999) + emoji, MAX_VISIBLE_OUTPUT_CHARS), 'A'.repeat(99999));
  assert.equal(clipVisibleText(emoji, 1), '');
  const output = await events(await handleChat(request(), env, async function* () {
    yield { text: 'A'.repeat(99999) + emoji, candidates: [{ finishReason: 'STOP' }] };
  }));
  const text = visible(output);
  assert.equal(text, 'A'.repeat(99999));
  assert.equal([...text].length, 99999);
  assert.equal(output.at(-1).completionReason, 'max_tokens');

  const kept = await handleChat(request({
    model: MODEL,
    messages: [
      { id: 'u', role: 'user', content: '问', status: 'complete' },
      { id: 'a', role: 'assistant', content: 'A'.repeat(MAX_VISIBLE_OUTPUT_CHARS), status: 'complete' },
      { id: 'u2', role: 'user', content: '继续', status: 'complete' },
    ],
  }), env, async function* () { yield { text: 'ok', candidates: [{ finishReason: 'STOP' }] }; });
  assert.equal(kept.status, 200);
  const tooLongOutput = await handleChat(request({
    model: MODEL,
    messages: [userMessage('问'), { id: 'a', role: 'assistant', content: 'A'.repeat(MAX_VISIBLE_OUTPUT_CHARS + 1), status: 'complete' }],
  }), env, async () => assert.fail('assistant text above the cap must not call the model'));
  assert.equal(tooLongOutput.status, 413);
  const oversized = await handleChat(request({
    model: MODEL, messages: [userMessage('x'.repeat(50001))],
  }), env, async () => assert.fail('input validation must not call the model'));
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, 'CONTEXT_LIMIT');
  const hugeBody = await handleChat(request(undefined, { body: 'x'.repeat(262145) }), env, async () => assert.fail('body limit must not call the model'));
  assert.equal(hugeBody.status, 413);
});

test('a capped partial remains in the next normal, setup, and writing request', () => {
  const chat = createChat(MODEL);
  const user = createMessage('user', '请写很长');
  const assistant = createMessage('assistant', 'A'.repeat(1000) + 'B'.repeat(1000), MODEL);
  assistant.parentUserId = user.id;
  assistant.status = 'complete';
  assistant.completionReason = 'max_tokens';
  assistant.notice = ERROR_TEXT.TRUNCATED;
  chat.messages.push(user, assistant);
  const follow = createMessage('user', '你的输出未完整 请继续输出');
  follow.parentVariantId = assistant.id;
  chat.messages.push(follow);
  const normal = contextFor(chat, follow.id);
  assert.deepEqual(normal.map(message => message.content), [user.content, assistant.content, follow.content]);
  assert.equal(JSON.stringify(normal).includes(ERROR_TEXT.TRUNCATED), false);
  assert.equal(continuationAvailability(chat).action, 'continue_incomplete');
  const validated = validatePayload({ model: MODEL, messages: normal });
  assert.equal(validated.contents[1].parts[0].text, assistant.content);

  for (const mode of ['setup', 'writing']) {
    const story = createChat(MODEL);
    const premise = createMessage('user', '前提');
    const partial = createMessage('assistant', assistant.content, MODEL);
    partial.parentUserId = premise.id;
    partial.status = 'complete';
    partial.completionReason = 'max_tokens';
    partial.notice = ERROR_TEXT.TRUNCATED;
    story.messages.push(premise, partial);
    setStoryRuntimeMode(story, mode, mode === 'setup' ? 'prepare_story' : 'start_writing');
    assert.equal(continuationAvailability(story).action, 'continue_incomplete');
    const control = createRuntimeControl('continue_incomplete', partial.id);
    story.messages.push(control);
    const messages = contextFor(story, control.id);
    assert.equal(messages.some(message => message.content === partial.content), true);
    const result = validatePayload({ model: MODEL, messages, storyRuntime: { mode, action: 'continue_incomplete' } });
    assert.equal(result.contents.at(-2).parts[0].text, partial.content);
    assert.match(result.contents.at(-1).parts[0].text, /exact ending/);
  }
});

const encoder = new TextEncoder();
const sdkSse = payload => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
function sdkResponse(payload) {
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(sdkSse(payload));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
async function sdkChat(payload) {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'unit-test-sentinel-not-a-key';
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input);
    assert.equal(url.includes('unit-test-sentinel'), false);
    assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\//);
    return sdkResponse(payload);
  };
  try {
    return await events(await api.fetch(request()));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
}

test('the installed SDK distinguishes thought-only output exhaustion from safety and empty stops', async () => {
  const thought = '只存在于思考';
  const exhausted = await sdkChat({
    candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [{ text: thought, thought: true }] } }],
  });
  assert.equal(exhausted.at(-1).type, 'error');
  assert.equal(exhausted.at(-1).code, 'OUTPUT_LIMIT');
  assert.equal(exhausted.at(-1).message, ERROR_TEXT.OUTPUT_LIMIT);
  assert.equal(JSON.stringify(exhausted).includes(thought), false);
  assert.equal(JSON.stringify(exhausted).includes('安全'), false);
  assert.equal(exhausted.some(event => event.type === 'delta'), false);

  const visibleTokens = await sdkChat({
    candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [{ text: '可见正文', thought: false }, { text: thought, thought: true }] } }],
  });
  assert.equal(visible(visibleTokens), '可见正文');
  assert.equal(visibleTokens.at(-1).type, 'done');
  assert.equal(visibleTokens.at(-1).completionReason, 'max_tokens');
  assert.equal(visibleTokens.at(-1).notice, ERROR_TEXT.TRUNCATED);
  assert.equal(JSON.stringify(visibleTokens).includes(thought), false);

  const emptyStop = await sdkChat({
    candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: thought, thought: true }] } }],
  });
  assert.equal(emptyStop.at(-1).code, 'BLOCKED');
  assert.equal(JSON.stringify(emptyStop).includes(thought), false);

  const emptySafety = await sdkChat({
    candidates: [{ finishReason: 'SAFETY', content: { role: 'model', parts: [{ text: thought, thought: true }] }, safetyRatings: [{ category: 'HARM_CATEGORY_HARASSMENT', probability: 'LOW', blocked: true }] }],
  });
  assert.equal(emptySafety.at(-1).code, 'SAFETY_BLOCKED');
  assert.match(emptySafety.at(-1).message, /安全/);
  assert.equal(JSON.stringify(emptySafety).includes(thought), false);

  const chat = createChat(MODEL);
  const failedUser = createMessage('user', '只要思考');
  const failed = createMessage('assistant', '', MODEL);
  failed.parentUserId = failedUser.id;
  failed.status = 'error';
  failed.error = ERROR_TEXT.OUTPUT_LIMIT;
  const next = createMessage('user', '下一问');
  chat.messages.push(failedUser, failed, next);
  const messages = contextFor(chat, next.id);
  assert.deepEqual(messages.map(message => message.content), ['下一问']);
  assert.equal(messages.some(message => message.role === 'assistant'), false);
});
