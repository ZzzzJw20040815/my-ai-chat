import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChat } from '../server/chat.js';
import { handleStoryMemory } from '../server/story-memory.js';
import { handleModels, resetServerCatalogForTests } from '../server/model-catalog.js';
import { resetVertexAuthForTests } from '../server/vertex-auth.js';
import { createMessage } from '../ui/state.js';
import { createModelCatalog, MODEL_CATALOG_STORAGE_KEY, VERTEX_MODEL_CATALOG_STORAGE_KEY } from '../ui/model-catalog.js';
import {
  API_CHANNELS, GLOBAL_SETTINGS_STORAGE_KEY, InvalidApiChannelError, LOCAL_GEMINI_KEY_STORAGE_KEY,
  requestApiChannel,
} from '../shared/settings.js';
import { loadGlobalSettings, saveGlobalSettings } from '../ui/settings.js';
import { normalizeDiscoveredModel } from '../shared/models.js';

const SECRET = 'refresh-token-sentinel';
const GEMINI_KEY = 'gemini-key-sentinel';
const ACCESS = 'access-token-sentinel';
const credentials = {
  type: 'authorized_user', client_id: 'client-id-sentinel', client_secret: 'client-secret-sentinel', refresh_token: SECRET,
};
const env = {
  GEMINI_API_KEY: GEMINI_KEY, VERTEX_PROJECT_ID: 'vertex-proj', VERTEX_LOCATION: 'us-central1',
  GOOGLE_CREDENTIALS_JSON: JSON.stringify(credentials),
};
const memory = () => ({
  version: 1,
  scene: { location: null, time: null, presentCharacters: [], relativePositions: [], environmentState: [], importantObjects: [] },
  characters: [],
  relationship: { summary: '', establishedChanges: [], sharedHistory: [], unresolvedTension: [] },
  importantEvents: [], knownFacts: ['A met B.'], unknownOrUnconfirmed: [], unresolvedThreads: [],
});
const sse = text => new TextEncoder().encode('data: ' + JSON.stringify({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { totalTokenCount: 3 },
}) + '\n\n');

function installFetch(t, handler) {
  resetVertexAuthForTests();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const request = new Request(input, init);
    calls.push(request);
    return handler(request, calls);
  });
  return calls;
}
const chatRequest = (body) => new Request('https://site.example/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://site.example' },
  body: JSON.stringify(body),
});

test('Vertex and AI Studio chat requests stay on separate endpoints', async t => {
  const calls = installFetch(t, async request => {
    if (request.url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: ACCESS, expires_in: 3600 });
    if (request.url.includes('streamGenerateContent')) {
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(sse('ok')); controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(sse('studio')); controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const vertex = await handleChat(chatRequest({
    apiChannel: 'vertex', model: 'gemini-4-hydrogen',
    messages: [
      { id: 'u1', role: 'user', content: '第一问', status: 'complete' },
      { id: 'a1', role: 'assistant', content: '第一答', status: 'complete' },
      { id: 'u2', role: 'user', content: '继续', status: 'complete' },
    ],
    settings: { thinkingLevel: 'xhigh' },
  }), env);
  assert.equal(vertex.status, 200);
  const clientBody = await vertex.text();
  assert.equal(clientBody.includes(ACCESS), false);
  assert.equal(clientBody.includes(GEMINI_KEY), false);
  assert.equal(clientBody.includes(SECRET), false);
  const upstream = calls.find(call => call.url.includes(':streamGenerateContent'));
  assert.equal(upstream.url, 'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/vertex-proj/locations/us-central1/publishers/google/models/gemini-4-hydrogen:streamGenerateContent?alt=sse');
  assert.equal(upstream.headers.get('authorization'), 'Bearer ' + ACCESS);
  assert.equal(upstream.headers.get('x-goog-user-project'), 'vertex-proj');
  assert.equal(upstream.headers.get('x-goog-api-key'), null);
  assert.equal(new URL(upstream.url).searchParams.has('key'), false);
  const body = await upstream.json();
  assert.deepEqual(body.contents.map(item => item.role), ['user', 'model', 'user']);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'XHIGH');
  assert.equal(JSON.stringify(body).includes('thinkingBudget'), false);
  assert.deepEqual(body.tools, [{ googleSearch: {} }]);
  assert.equal(JSON.stringify(body).includes(GEMINI_KEY), false);

  const before = calls.length;
  const studio = await handleChat(chatRequest({
    apiChannel: 'ai-studio', model: 'gemini-3.1-pro-preview',
    messages: [{ id: 'u1', role: 'user', content: '你好', status: 'complete' }],
  }), env);
  await studio.text();
  const studioCall = calls.slice(before).find(call => call.url.includes('generativelanguage.googleapis.com'));
  assert.ok(studioCall);
  assert.equal(calls.slice(before).some(call => call.url.includes('aiplatform.googleapis.com') || call.url.includes('oauth2.googleapis.com')), false);
});

test('Vertex story memory is non-streaming and does not fall back to AI Studio', async t => {
  const calls = installFetch(t, async request => {
    if (request.url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: ACCESS, expires_in: 3600 });
    return Response.json({
      candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(memory()) }] }, finishReason: 'STOP' }],
    });
  });
  const user = createMessage('user', 'A met B.');
  const response = await handleStoryMemory(new Request('https://site.example/api/story-memory', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://site.example' },
    body: JSON.stringify({
      apiChannel: 'vertex', model: 'gemini-4-argon', chatId: 'chat-1', anchorId: user.id, messages: [user],
    }),
  }), env);
  assert.equal(response.status, 200);
  const upstream = calls.find(call => call.url.includes(':generateContent'));
  assert.equal(upstream.url, 'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/vertex-proj/locations/us-central1/publishers/google/models/gemini-4-argon:generateContent');
  assert.equal(upstream.headers.get('x-goog-api-key'), null);
  const body = await upstream.json();
  assert.equal(body.contents[0].role, 'user');
  assert.equal(typeof body.systemInstruction.parts[0].text, 'string');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(JSON.stringify(body).includes('thinkingBudget'), false);
  assert.equal(calls.some(call => call.url.includes('generativelanguage.googleapis.com')), false);

  const denied = await handleStoryMemory(new Request('https://site.example/api/story-memory', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://site.example' },
    body: JSON.stringify({
      apiChannel: 'vertex', model: 'gemini-4-flash', chatId: 'chat-1', anchorId: user.id, messages: [user],
    }),
  }), env, async () => { throw new Error('studio fallback'); });
  assert.equal((await denied.json()).error.code, 'MODEL_UNAVAILABLE');
});

test('model catalog channel is explicit and Vertex does not call AI Studio', async t => {
  resetServerCatalogForTests();
  let listed = 0;
  const options = { listModels: async () => { listed += 1; return []; } };
  const vertex = await handleModels(new Request('https://site.example/api/models?channel=vertex', {
    headers: { Origin: 'https://site.example' },
  }), {}, options);
  const payload = await vertex.json();
  assert.equal(vertex.status, 200);
  assert.deepEqual(payload.models, []);
  assert.equal(payload.catalog, 'curated');
  assert.equal(listed, 0);
  assert.equal(JSON.stringify(payload).includes(GEMINI_KEY), false);
  const invalid = await handleModels(new Request('https://site.example/api/models?channel=other', {
    headers: { Origin: 'https://site.example' },
  }), env, options);
  assert.equal(invalid.status, 400);
  assert.equal(listed, 0);
  const chat = await handleChat(chatRequest({
    apiChannel: 'not-a-channel', model: 'gemini-3.1-pro-preview',
    messages: [{ id: 'u1', role: 'user', content: '你好', status: 'complete' }],
  }), env, async () => { throw new Error('should not send'); });
  assert.equal((await chat.json()).error.code, 'INVALID_REQUEST');
});

test('saved settings keep an invalid channel and a local Gemini key distinct from the server key', () => {
  assert.equal(requestApiChannel(undefined), 'ai-studio');
  assert.throws(() => requestApiChannel('vertex-express'), InvalidApiChannelError);
  assert.deepEqual(API_CHANNELS, ['ai-studio', 'vertex']);
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  storage.setItem(GLOBAL_SETTINGS_STORAGE_KEY, JSON.stringify({ thinkingLevel: 'xhigh', apiChannel: 'billing-proxy' }));
  storage.setItem(LOCAL_GEMINI_KEY_STORAGE_KEY, 'local-gemini-key-sentinel');
  const loaded = loadGlobalSettings(storage);
  assert.equal(loaded.apiChannelInvalid, true);
  assert.equal(loaded.apiChannel, null);
  assert.equal(loaded.thinkingLevel, 'xhigh');
  saveGlobalSettings({ ...loaded, apiChannel: 'vertex', apiChannelInvalid: false }, storage);
  assert.equal(storage.getItem(LOCAL_GEMINI_KEY_STORAGE_KEY), 'local-gemini-key-sentinel');
  assert.equal(JSON.parse(storage.getItem(GLOBAL_SETTINGS_STORAGE_KEY)).apiChannel, 'vertex');
  assert.equal(JSON.parse(storage.getItem(GLOBAL_SETTINGS_STORAGE_KEY)).thinkingLevel, 'xhigh');
  const legacy = loadGlobalSettings({ getItem: () => JSON.stringify({ thinkingLevel: 'low' }), setItem() {} });
  assert.equal(legacy.apiChannel, 'ai-studio');
});

test('catalog caches are isolated by channel and stale responses do not land on the new channel', async () => {
  const discovered = normalizeDiscoveredModel({
    id: 'gemini-4-flash', name: 'Gemini 4 Flash', description: 'discovered', stage: 'stable', source: 'discovered',
    capabilities: { thinking: true, outputTokenLimit: 1024 },
  });
  const values = new Map([[MODEL_CATALOG_STORAGE_KEY, JSON.stringify({ version: 1, models: [discovered] })]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  let release;
  const catalog = createModelCatalog({
    storage, fetcher: () => new Promise(resolve => { release = resolve; }),
  });
  assert.equal(catalog.has('gemini-4-flash'), true);
  const pending = catalog.refresh();
  assert.equal(catalog.setChannel('vertex'), true);
  assert.equal(catalog.has('gemini-4-flash'), false);
  assert.equal(catalog.has('gemini-4-hydrogen'), true);
  release(Response.json({ models: [discovered], syncedAt: new Date().toISOString() }));
  await pending;
  assert.equal(catalog.channel, 'vertex');
  assert.equal(catalog.has('gemini-4-flash'), false);
  assert.equal(values.has(VERTEX_MODEL_CATALOG_STORAGE_KEY), false);
  catalog.setChannel('ai-studio');
  assert.equal(catalog.has('gemini-4-flash'), true);
});
