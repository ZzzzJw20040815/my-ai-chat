// Cross-PR interactions: provider x search x story stage, thinking, partial context, and the 200000 cap.
// Fetch is mocked. Sentinels are not credentials and no request leaves this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import api from '../api/chat.js';
import storyApi from '../api/story-memory.js';
import {
  ERROR_TEXT, MAX_BODY_BYTES, MAX_HISTORY_CHARS, MAX_VISIBLE_OUTPUT_CHARS, clipVisibleText,
} from '../server/chat.js';
import { resetVertexAuthForTests } from '../server/vertex-auth.js';
import { STORY_MEMORY_MAX_BODY_BYTES } from '../shared/story-memory-transport.js';
import { modelMetadata } from '../shared/models.js';
import { DEFAULT_GLOBAL_SETTINGS } from '../shared/settings.js';
import { mountSearchSuggestion, publicGrounding, sanitizeSearchSuggestionHtml } from '../shared/web-search.js';
import { requestSettings } from '../ui/settings.js';
import { contextFor, createChat, createMessage } from '../ui/state.js';

const GEMINI_KEY = 'gemini-key-sentinel';
const ACCESS = 'access-token-sentinel';
const SECRET = 'refresh-token-sentinel';
const CREDENTIALS = {
  type: 'authorized_user', client_id: 'client-id-sentinel', client_secret: 'client-secret-sentinel', refresh_token: SECRET,
};
const MEMORY = {
  version: 1,
  scene: { location: 'Library', time: null, presentCharacters: ['A', 'B'], relativePositions: [], environmentState: [], importantObjects: [] },
  characters: [],
  relationship: { summary: '', establishedChanges: [], sharedHistory: [], unresolvedTension: [] },
  importantEvents: [], knownFacts: ['A met B.'], unknownOrUnconfirmed: [], unresolvedThreads: [],
};
const encoder = new TextEncoder();

function withSentinels(t) {
  const previous = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    VERTEX_PROJECT_ID: process.env.VERTEX_PROJECT_ID,
    VERTEX_LOCATION: process.env.VERTEX_LOCATION,
    GOOGLE_CREDENTIALS_JSON: process.env.GOOGLE_CREDENTIALS_JSON,
  };
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  process.env.VERTEX_PROJECT_ID = 'vertex-proj';
  process.env.VERTEX_LOCATION = 'us-central1';
  process.env.GOOGLE_CREDENTIALS_JSON = JSON.stringify(CREDENTIALS);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function sse(payload) {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function installFetch(t, chunks) {
  resetVertexAuthForTests();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const request = new Request(input, init);
    const url = request.url;
    const allowed = url.startsWith('https://generativelanguage.googleapis.com/')
      || url.startsWith('https://oauth2.googleapis.com/token')
      || url.includes('-aiplatform.googleapis.com/')
      || url.startsWith('https://aiplatform.googleapis.com/');
    if (!allowed) throw new Error(`blocked egress ${url}`);
    const record = {
      url,
      authorization: request.headers.get('authorization'),
      apiKey: request.headers.get('x-goog-api-key'),
      project: request.headers.get('x-goog-user-project'),
      body: null,
    };
    if (request.headers.get('content-type')?.includes('json')) record.body = await request.json();
    calls.push(record);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      assert.equal(url.includes(SECRET), false);
      return Response.json({ access_token: ACCESS, expires_in: 3600 });
    }
    if (url.includes(':generateContent') && !url.includes('streamGenerateContent')) {
      return Response.json({
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify(MEMORY) }] } }],
      });
    }
    const events = typeof chunks === 'function' ? chunks(record.body) : chunks;
    return new Response(new ReadableStream({
      start(controller) {
        for (const event of events || [{ text: 'ok', finishReason: 'STOP' }]) controller.enqueue(sse(eventChunk(event)));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return calls;
}

function eventChunk(event) {
  if (event.candidates) return event;
  return {
    candidates: [{
      ...(event.finishReason ? { finishReason: event.finishReason } : {}),
      ...(event.groundingMetadata ? { groundingMetadata: event.groundingMetadata } : {}),
      content: { role: 'model', parts: [{ text: event.text || '', ...(event.thought ? { thought: true } : {}) }] },
    }],
  };
}

function post(pathname, body, bytes) {
  return new Request(`https://site.example${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://site.example' },
    body: bytes || JSON.stringify(body),
  });
}

async function read(response) {
  const text = await response.text();
  const events = text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    try { return JSON.parse(line.startsWith('data:') ? line.slice(5).trimStart() : line); }
    catch { return null; }
  }).filter(Boolean);
  return { status: response.status, text, events };
}

function modelCalls(calls) {
  return calls.filter(call => !call.url.includes('oauth2.googleapis.com'));
}

function assertChannel(call, channel) {
  const serialized = JSON.stringify(call.body) + call.url;
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes('client-secret-sentinel'), false);
  if (channel === 'vertex') {
    assert.match(call.url, /aiplatform\.googleapis\.com/);
    assert.equal(call.url.includes('generativelanguage.googleapis.com'), false);
    assert.equal(call.authorization, `Bearer ${ACCESS}`);
    assert.equal(call.project, 'vertex-proj');
    assert.equal(call.apiKey, null);
    assert.equal(new URL(call.url).searchParams.has('key'), false);
    assert.equal(call.url.includes(GEMINI_KEY), false);
  } else {
    assert.match(call.url, /^https:\/\/generativelanguage\.googleapis\.com\//);
    assert.equal(call.url.includes('aiplatform.googleapis.com'), false);
    assert.equal(call.apiKey, GEMINI_KEY);
    assert.equal(call.url.includes(GEMINI_KEY), false);
    assert.equal(call.authorization, null);
  }
}

test('search attachment follows the switch and story stage on both providers', async t => {
  withSentinels(t);
  const calls = installFetch(t);
  const stages = [
    ['chat', undefined],
    ['setup', { mode: 'setup', stability: 'balanced' }],
    ['writing', { mode: 'writing', stability: 'balanced' }],
  ];
  const searches = [
    ['default', undefined],
    ['on', 'on'],
    ['off', 'off'],
  ];
  for (const channel of ['ai-studio', 'vertex']) {
    for (const [searchName, webSearch] of searches) {
      for (const [stageName, storyRuntime] of stages) {
        const before = calls.length;
        const settings = webSearch ? { webSearch } : undefined;
        const result = await read(await api.fetch(post('/api/chat', {
          apiChannel: channel,
          model: 'gemini-3.1-pro-preview',
          messages: [{ id: 'u1', role: 'user', content: `${channel} ${searchName} ${stageName}`, status: 'complete' }],
          ...(settings ? { settings } : {}),
          ...(storyRuntime ? { storyRuntime } : {}),
        })));
        assert.equal(result.status, 200, `${channel} ${searchName} ${stageName}`);
        const call = modelCalls(calls.slice(before)).at(-1);
        assert.ok(call, `${channel} ${searchName} ${stageName} made no upstream call`);
        assertChannel(call, channel);
        const allow = webSearch !== 'off' && stageName !== 'writing';
        if (allow) assert.deepEqual(call.body.tools, [{ googleSearch: {} }]);
        else assert.equal(call.body.tools, undefined);
        assert.equal(JSON.stringify(call.body).includes('thinkingBudget'), false);
      }
    }
  }
});

test('unsupported channel, search, and thinking combinations fail before any upstream call', async t => {
  withSentinels(t);
  const calls = installFetch(t);
  const cases = [
    { apiChannel: 'billing-proxy', model: 'gemini-3.1-pro-preview', settings: { webSearch: 'on' } },
    { apiChannel: 'ai-studio', model: 'gemini-3.1-pro-preview', settings: { webSearch: 'sometimes' } },
    { apiChannel: 'vertex', model: 'gemini-4-hydrogen', settings: { webSearch: 'sometimes' } },
    { apiChannel: 'ai-studio', model: 'gemini-4-carbon', settings: { thinkingLevel: 'xhigh', webSearch: 'on' } },
    { apiChannel: 'vertex', model: 'gemini-4-argon', settings: { thinkingLevel: 'minimal', webSearch: 'off' } },
    { apiChannel: 'vertex', model: 'gemini-4-hydrogen', settings: { thinkingLevel: 'minimal' } },
  ];
  for (const item of cases) {
    const before = calls.length;
    const result = await read(await api.fetch(post('/api/chat', {
      ...item,
      messages: [{ id: 'u1', role: 'user', content: 'illegal combo', status: 'complete' }],
    })));
    assert.equal(result.status, 400);
    assert.equal(result.events[0]?.error?.code || JSON.parse(result.text).error.code, 'INVALID_REQUEST');
    assert.equal(calls.length, before);
  }
});

test('Hydrogen xhigh and default thinking stay isolated from search tools on both providers', async t => {
  withSentinels(t);
  const calls = installFetch(t);
  for (const channel of ['ai-studio', 'vertex']) {
    for (const [level, expected] of [['xhigh', 'XHIGH'], ['default', null]]) {
      for (const webSearch of ['on', 'off']) {
        const before = calls.length;
        const result = await read(await api.fetch(post('/api/chat', {
          apiChannel: channel,
          model: 'gemini-4-hydrogen',
          settings: { thinkingLevel: level, webSearch },
          messages: [{ id: 'u1', role: 'user', content: 'think', status: 'complete' }],
        })));
        assert.equal(result.status, 200);
        const call = modelCalls(calls.slice(before)).at(-1);
        assertChannel(call, channel);
        assert.equal(call.body.generationConfig?.thinkingConfig?.thinkingLevel, expected || undefined);
        assert.equal(JSON.stringify(call.body).includes('thinkingBudget'), false);
        assert.equal(JSON.stringify(call.body).includes('thinking_budget'), false);
        if (webSearch === 'on') assert.deepEqual(call.body.tools, [{ googleSearch: {} }]);
        else assert.equal(call.body.tools, undefined);
      }
    }
  }
});

test('partial text survives into the next provider payload and empty or stopped turns do not', async t => {
  withSentinels(t);
  const calls = installFetch(t);
  const warning = '这是警告，不要进入正文。';
  for (const channel of ['ai-studio', 'vertex']) {
    for (const status of ['error', 'interrupted', 'incomplete', 'blocked']) {
      const chat = createChat('gemini-4-hydrogen');
      const firstUser = createMessage('user', 'a');
      const firstAssistant = createMessage('assistant', '完整回答', 'gemini-4-hydrogen');
      firstAssistant.parentUserId = firstUser.id;
      const partialUser = createMessage('user', 'b');
      const partial = createMessage('assistant', '半截正文乙。', 'gemini-4-hydrogen');
      partial.parentUserId = partialUser.id;
      partial.status = status;
      partial.error = warning;
      const follow = createMessage('user', '你的输出未完整 请继续输出');
      chat.messages.push(firstUser, firstAssistant, partialUser, partial, follow);
      const messages = contextFor(chat, follow.id);
      assert.equal(messages.some(message => message.content === '半截正文乙。'), true);
      assert.equal(JSON.stringify(messages).includes(warning), false);
      const settings = requestSettings({
        ...DEFAULT_GLOBAL_SETTINGS, webSearch: 'off', thinkingLevel: 'xhigh',
      }, modelMetadata('gemini-4-hydrogen'));
      const before = calls.length;
      const result = await read(await api.fetch(post('/api/chat', {
        apiChannel: channel, model: 'gemini-4-hydrogen', messages, settings,
        storyRuntime: { mode: 'writing', stability: 'balanced' },
      })));
      assert.equal(result.status, 200, `${channel} ${status}`);
      const call = modelCalls(calls.slice(before)).at(-1);
      assertChannel(call, channel);
      assert.equal(call.body.tools, undefined);
      assert.equal(call.body.generationConfig.thinkingConfig.thinkingLevel, 'XHIGH');
      assert.deepEqual(call.body.contents.map(item => item.parts.map(part => part.text).join('')).filter(text => text.includes('半截')), ['半截正文乙。']);
      assert.equal(JSON.stringify(call.body).includes(warning), false);
    }
    const beforeEmpty = calls.length;
    const empty = await read(await api.fetch(post('/api/chat', {
      apiChannel: channel, model: 'gemini-3.1-pro-preview',
      messages: [
        { id: 'u', role: 'user', content: 'b', status: 'complete' },
        { id: 'a', role: 'assistant', content: '   ', status: 'error' },
        { id: 'u2', role: 'user', content: '下一问', status: 'complete' },
      ],
    })));
    assert.equal(empty.status, 400);
    assert.equal(calls.length, beforeEmpty);
    const stopped = await read(await api.fetch(post('/api/chat', {
      apiChannel: channel, model: 'gemini-3.1-pro-preview',
      messages: [
        { id: 'u', role: 'user', content: '问', status: 'complete' },
        { id: 'a', role: 'assistant', content: '用户停住的半句', status: 'stopped' },
        { id: 'u2', role: 'user', content: '普通追问', status: 'complete' },
      ],
    })));
    assert.equal(stopped.status, 400);
    assert.equal(calls.length, beforeEmpty);
  }
});

test('a 200000 character clip can be sent again, and longer input or history is a 413', async t => {
  withSentinels(t);
  const calls = installFetch(t, () => {
    const prefix = 'A'.repeat(MAX_VISIBLE_OUTPUT_CHARS - 1);
    return [{ text: `${prefix}😀`, finishReason: 'STOP' }];
  });
  for (const channel of ['ai-studio', 'vertex']) {
    const before = calls.length;
    const clipped = await read(await api.fetch(post('/api/chat', {
      apiChannel: channel, model: 'gemini-3.1-pro-preview', settings: { webSearch: 'off' },
      messages: [{ id: 'u1', role: 'user', content: '超长输出', status: 'complete' }],
    })));
    assert.equal(clipped.status, 200);
    const visible = clipped.events.filter(event => event.type === 'delta').map(event => event.text).join('');
    assert.equal(visible, clipVisibleText(`${'A'.repeat(MAX_VISIBLE_OUTPUT_CHARS - 1)}😀`, MAX_VISIBLE_OUTPUT_CHARS));
    assert.equal(visible.length, MAX_VISIBLE_OUTPUT_CHARS - 1);
    assert.equal(clipped.events.at(-1).completionReason, 'max_tokens');
    assert.equal(JSON.stringify(clipped.events).includes('😀'), false);
    const call = modelCalls(calls.slice(before)).at(-1);
    assertChannel(call, channel);
    assert.equal(call.body.tools, undefined);
    const again = await read(await api.fetch(post('/api/chat', {
      apiChannel: channel, model: 'gemini-3.1-pro-preview', settings: { webSearch: 'on' },
      messages: [
        { id: 'u1', role: 'user', content: '超长输出', status: 'complete' },
        { id: 'a1', role: 'assistant', content: visible, status: 'incomplete' },
        { id: 'u2', role: 'user', content: '你的输出未完整 请继续输出', status: 'complete' },
      ],
    })));
    assert.equal(again.status, 200);
    const next = modelCalls(calls).at(-1);
    assert.equal(next.body.contents[1].parts[0].text, visible);
    assert.deepEqual(next.body.tools, [{ googleSearch: {} }]);
    const tooLong = await read(await api.fetch(post('/api/chat', {
      apiChannel: channel, model: 'gemini-3.1-pro-preview',
      messages: [
        { id: 'u', role: 'user', content: '问', status: 'complete' },
        { id: 'a', role: 'assistant', content: 'A'.repeat(MAX_VISIBLE_OUTPUT_CHARS + 1), status: 'complete' },
      ],
    })));
    assert.equal(tooLong.status, 413);
    assert.equal(JSON.parse(tooLong.text).error.code, 'CONTEXT_LIMIT');
  }
  const overHistory = await read(await api.fetch(post('/api/chat', {
    apiChannel: 'vertex', model: 'gemini-4-hydrogen',
    messages: [
      { id: 'u', role: 'user', content: 'B'.repeat(50000), status: 'complete' },
      { id: 'a', role: 'assistant', content: 'A'.repeat(MAX_VISIBLE_OUTPUT_CHARS), status: 'complete' },
      { id: 'u2', role: 'user', content: 'x', status: 'complete' },
    ],
  })));
  assert.equal(overHistory.status, 413);
  assert.equal(MAX_HISTORY_CHARS, 250000);
  const overBody = await read(await api.fetch(post('/api/chat', undefined, 'x'.repeat(MAX_BODY_BYTES + 1))));
  assert.equal(overBody.status, 413);
  const storyBody = await read(await storyApi.fetch(post('/api/story-memory', undefined, 'x'.repeat(STORY_MEMORY_MAX_BODY_BYTES + 1))));
  assert.equal(storyBody.status, 413);
  assert.equal(STORY_MEMORY_MAX_BODY_BYTES, 256 * 1024);
  const wide = {
    apiChannel: 'ai-studio', model: 'gemini-3.1-pro-preview', settings: { webSearch: 'off' },
    messages: [
      { id: 'u', role: 'user', content: '问', status: 'complete' },
      { id: 'a', role: 'assistant', content: '哈'.repeat(100000), status: 'complete' },
      { id: 'u2', role: 'user', content: '继续', status: 'complete' },
    ],
  };
  const wideBytes = Buffer.byteLength(JSON.stringify(wide));
  assert.ok(wideBytes > STORY_MEMORY_MAX_BODY_BYTES);
  assert.ok(wideBytes < MAX_BODY_BYTES);
  const chatAboveStoryLimit = await read(await api.fetch(post('/api/chat', wide)));
  assert.equal(chatAboveStoryLimit.status, 200);
});

test('MAX_TOKENS, STOP, and SAFETY stay distinct on both providers and thoughts are not forwarded', async t => {
  withSentinels(t);
  const queue = [];
  const calls = installFetch(t, () => [queue.shift()]);
  const cases = [
    [{ text: '只存在于思考', thought: true, finishReason: 'MAX_TOKENS' }, 'OUTPUT_LIMIT', false],
    [{ text: '看得见', finishReason: 'MAX_TOKENS' }, 'max_tokens', true],
    [{ text: '正常结束', finishReason: 'STOP' }, 'complete', true],
    [{ text: '', finishReason: 'SAFETY' }, 'SAFETY_BLOCKED', false],
    [{ text: '', finishReason: 'STOP' }, 'BLOCKED', false],
  ];
  for (const channel of ['ai-studio', 'vertex']) {
    for (const [event, expected, hasText] of cases) {
      queue.push(event);
      const before = calls.length;
      const result = await read(await api.fetch(post('/api/chat', {
        apiChannel: channel, model: 'gemini-3.1-pro-preview', settings: { webSearch: 'off' },
        messages: [{ id: 'u1', role: 'user', content: expected, status: 'complete' }],
      })));
      const visible = result.events.filter(item => item.type === 'delta').map(item => item.text).join('');
      assert.equal(result.text.includes('只存在于思考'), false);
      assert.equal(result.text.includes(GEMINI_KEY), false);
      assert.equal(result.text.includes(SECRET), false);
      if (hasText) {
        assert.equal(result.events.at(-1).type, 'done');
        assert.equal(result.events.at(-1).completionReason, expected);
        assert.equal(visible.includes(event.text), true);
      } else {
        assert.equal(result.events.at(-1).type, 'error');
        assert.equal(result.events.at(-1).code, expected);
        assert.equal(visible, '');
      }
      assert.equal(calls.slice(before).filter(call => !call.url.includes('oauth2.googleapis.com')).at(-1).body.tools, undefined);
    }
  }
});

test('story memory never attaches search and does not cross providers', async t => {
  withSentinels(t);
  const calls = installFetch(t);
  const user = createMessage('user', 'A met B.');
  for (const channel of ['ai-studio', 'vertex']) {
    const before = calls.length;
    const result = await read(await storyApi.fetch(post('/api/story-memory', {
      apiChannel: channel, model: 'gemini-4-argon', chatId: 'chat-1', anchorId: user.id, messages: [user],
    })));
    assert.equal(result.status, 200, result.text.slice(0, 300));
    const call = modelCalls(calls.slice(before)).at(-1);
    assertChannel(call, channel);
    assert.equal(call.url.includes('streamGenerateContent'), false);
    assert.equal(call.body.tools, undefined);
    assert.equal(JSON.stringify(call.body).includes('googleSearch'), false);
    assert.equal(JSON.stringify(call.body).includes('thinkingBudget'), false);
  }
});

test('entity-encoded javascript links and fixed overlays stay sanitized', () => {
  const win = new JSDOM('<!doctype html><html><body><p id="outside">outside</p><div id="host"></div></body></html>').window;
  const attack = `<a href="&#106;avascript&#58;alert(1)">bad</a>
<a href="javascript&#58;alert(1)">bad2</a>
<style>@import "http://evil.example/a.css"; .chip { background: url("http://evil.example/x.png"); }</style>
<div class="fixed-probe" style="position&#58;fixed; top:0; left:0; width:100vw; height:100vh">cover</div>
<span>local qa</span>`;
  const clean = sanitizeSearchSuggestionHtml(attack, win);
  assert.match(clean, /local qa/);
  assert.equal(/javascript/i.test(clean), false);
  assert.equal(/@import/i.test(clean), false);
  assert.equal(/http:\/\//i.test(clean), false);
  const host = win.document.getElementById('host');
  host.innerHTML = `<div class="search-suggestion-host"><template class="search-suggestion-source">${clean}</template></div>`;
  const suggestionHost = host.querySelector('.search-suggestion-host');
  const shadow = mountSearchSuggestion(suggestionHost, win);
  assert.equal(suggestionHost.style.getPropertyValue('contain'), 'paint');
  assert.equal(suggestionHost.style.getPropertyValue('overflow'), 'hidden');
  assert.equal(shadow.querySelector('.fixed-probe') != null, true);
  assert.equal(suggestionHost.contains(shadow.querySelector('.fixed-probe')), false);
  const grounding = publicGrounding({
    groundingChunks: [
      { web: { uri: 'javascript:alert(1)', title: 'Script' } },
      { web: { uri: '&#106;avascript:alert(1)', title: 'Encoded' } },
      { web: { uri: 'https://example.com/ok', title: 'OK' } },
    ],
    searchEntryPoint: { renderedContent: attack },
  });
  assert.deepEqual(grounding.webSources, [{ title: 'OK', url: 'https://example.com/ok' }]);
  assert.equal(JSON.stringify(grounding.webSources).includes('javascript'), false);
});
