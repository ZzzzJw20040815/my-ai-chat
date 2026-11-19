import test from 'node:test';
import assert from 'node:assert/strict';
import api from '../api/chat.js';
import { resetServerCatalogForTests } from '../server/model-catalog.js';
import { resetVertexAuthForTests } from '../server/vertex-auth.js';
import { MAX_OUTPUT_TOKENS_LIMIT } from '../shared/settings.js';
import {
  CURATED_MODELS, DEFAULT_MODEL, mergeModelCatalog, modelMetadata, normalizeDiscoveredModel,
} from '../shared/models.js';

const MODEL = 'gemini-4-neon';
const GEMINI_KEY = 'gemini-key-sentinel';
const ACCESS = 'access-token-sentinel';
const SECRET = 'refresh-token-sentinel';
const CREDENTIALS = {
  type: 'authorized_user', client_id: 'client-id-sentinel', client_secret: 'client-secret-sentinel', refresh_token: SECRET,
};

function withSentinels(t, location = 'global') {
  const previous = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    VERTEX_PROJECT_ID: process.env.VERTEX_PROJECT_ID,
    VERTEX_LOCATION: process.env.VERTEX_LOCATION,
    GOOGLE_CREDENTIALS_JSON: process.env.GOOGLE_CREDENTIALS_JSON,
  };
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  process.env.VERTEX_PROJECT_ID = 'vertex-proj';
  process.env.VERTEX_LOCATION = location;
  process.env.GOOGLE_CREDENTIALS_JSON = JSON.stringify(CREDENTIALS);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function installFetch(t) {
  resetVertexAuthForTests();
  resetServerCatalogForTests();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const request = new Request(input, init);
    const url = request.url;
    const allowed = url.startsWith('https://generativelanguage.googleapis.com/')
      || url.startsWith('https://oauth2.googleapis.com/token')
      || url.startsWith('https://aiplatform.googleapis.com/');
    if (!allowed) throw new Error(`blocked egress ${url}`);
    const record = {
      url,
      apiKey: request.headers.get('x-goog-api-key'),
      authorization: request.headers.get('authorization'),
      body: request.headers.get('content-type')?.includes('json') ? await request.json() : null,
    };
    calls.push(record);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ access_token: ACCESS, expires_in: 3600 });
    }
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'ok' }] } }],
      })}\n\n`));
      controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  return calls;
}

function post(body) {
  return api.fetch(new Request('https://site.example/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://site.example' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ id: 'u1', role: 'user', content: 'hello', status: 'complete' }],
      ...body,
    }),
  }));
}

function modelCall(calls) {
  return calls.filter(call => !call.url.includes('oauth2.googleapis.com')).at(-1);
}

test('Gemini 4 Neon is one curated model and a discovered copy does not duplicate it', () => {
  const model = modelMetadata(MODEL);
  assert.equal(DEFAULT_MODEL, 'gemini-3.1-pro-preview');
  assert.equal(model.name, 'Gemini 4 Neon');
  assert.equal(model.id, 'gemini-4-neon');
  assert.equal(model.stage, 'stable');
  assert.equal(model.source, 'curated');
  assert.deepEqual(model.capabilities.thinkingLevels, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(model.capabilities.samplingOverrides, false);
  assert.equal(model.capabilities.outputTokenLimit, 65536);
  assert.equal(MAX_OUTPUT_TOKENS_LIMIT, 65536);
  assert.equal(CURATED_MODELS.filter(item => item.id === MODEL).length, 1);
  const discovered = normalizeDiscoveredModel({
    id: MODEL, name: 'Gemini 4 Neon', description: 'discovered copy', stage: 'stable', source: 'discovered',
    capabilities: { thinking: true, thinkingLevels: ['low'], outputTokenLimit: 1024 },
  });
  const merged = mergeModelCatalog([discovered]);
  const matches = merged.filter(item => item.id === MODEL);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].source, 'curated');
  assert.deepEqual(matches[0].capabilities.thinkingLevels, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(matches[0].capabilities.outputTokenLimit, 65536);
});

test('Neon thinking, output, and search follow the shared gates on both providers', async t => {
  withSentinels(t);
  const calls = installFetch(t);
  for (const channel of ['ai-studio', 'vertex']) {
    for (const [settings, thinking, tools] of [
      [{ thinkingLevel: 'xhigh', webSearch: 'on' }, 'XHIGH', [{ googleSearch: {} }]],
      [{ thinkingLevel: 'high', webSearch: 'off' }, 'HIGH', undefined],
      [{ thinkingLevel: 'default', webSearch: 'on' }, undefined, [{ googleSearch: {} }]],
      [{ thinkingLevel: 'low', webSearch: 'on', story: true }, 'LOW', undefined],
    ]) {
      const before = calls.length;
      const response = await post({
        apiChannel: channel,
        settings: { thinkingLevel: settings.thinkingLevel, webSearch: settings.webSearch },
        ...(settings.story ? { storyRuntime: { mode: 'writing', stability: 'balanced' } } : {}),
      });
      assert.equal(response.status, 200, `${channel} ${settings.thinkingLevel} ${settings.webSearch}`);
      await response.text();
      const call = modelCall(calls.slice(before));
      assert.match(call.url, new RegExp(`/models/${MODEL}:(streamGenerateContent|generateContent)`));
      if (channel === 'vertex') {
        assert.match(call.url, /^https:\/\/aiplatform\.googleapis\.com\/v1beta1\/projects\/vertex-proj\/locations\/global\/publishers\/google\/models\/gemini-4-neon:streamGenerateContent\?alt=sse$/);
        assert.equal(call.authorization, `Bearer ${ACCESS}`);
        assert.equal(call.apiKey, null);
      } else {
        assert.match(call.url, /^https:\/\/generativelanguage\.googleapis\.com\//);
        assert.equal(call.apiKey, GEMINI_KEY);
      }
      assert.equal(call.body.generationConfig?.thinkingConfig?.thinkingLevel, thinking);
      assert.equal(JSON.stringify(call.body).includes('thinkingBudget'), false);
      assert.equal(JSON.stringify(call.body).includes('只存在于思考'), false);
      if (tools) assert.deepEqual(call.body.tools, tools);
      else assert.equal(call.body.tools, undefined);
    }
    for (const settings of [
      { thinkingLevel: 'minimal' },
      { thinkingLevel: 'extreme' },
      { maxOutputTokens: 65537 },
      { samplingOverrides: { enabled: true, temperature: 1, topP: 0.95, topK: 64 } },
    ]) {
      const before = calls.length;
      const response = await post({ apiChannel: channel, settings });
      assert.equal(response.status, 400, `${channel} ${JSON.stringify(settings)}`);
      assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
      assert.equal(calls.length, before);
    }
    const capped = await post({ apiChannel: channel, settings: { maxOutputTokens: 65536, webSearch: 'off' } });
    assert.equal(capped.status, 200);
    await capped.text();
    assert.equal(modelCall(calls).body.generationConfig.maxOutputTokens, 65536);
  }
});
