import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { handleChat } from '../server/chat.js';
import {
  handleModels, isChatModel, resetServerCatalogForTests, sanitizeListedModel, trustedModelMetadata,
} from '../server/model-catalog.js';
import { CURATED_MODELS, mergeModelCatalog } from '../shared/models.js';
import { DEFAULT_GLOBAL_SETTINGS, normalizeGlobalSettings } from '../shared/settings.js';
import { requestSettings } from '../ui/settings.js';
import {
  MODEL_CATALOG_STORAGE_KEY, MODEL_CATALOG_SYNC_STORAGE_KEY, createModelCatalog,
  availableDefaultModel,
} from '../ui/model-catalog.js';
import { createMessage } from '../ui/state.js';

const KEY = 'unit-test-sentinel-not-a-key';
const now = Date.parse('2026-09-11T12:00:00.000Z');
const discoveredRaw = {
  name: 'models/gemini-4-flash', displayName: 'Gemini 4 Flash', description: 'Future text chat model',
  supportedActions: ['generateContent'], outputTokenLimit: 32768, maxTemperature: 1.5, topP: 0.95, topK: 40, thinking: true,
};
const discovered = sanitizeListedModel(discoveredRaw);
const memoryStorage = initial => {
  const values = new Map(Object.entries(initial || {}));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
};
const modelRequest = (search = '') => new Request(`https://site.example/api/models${search}`, {
  headers: { Origin: 'https://site.example', 'Sec-Fetch-Site': 'same-origin' },
});
const chatRequest = model => new Request('https://site.example/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://site.example' },
  body: JSON.stringify({ model, messages: [createMessage('user', 'hello')], settings: requestSettings(DEFAULT_GLOBAL_SETTINGS, discovered) }),
});

test('catalog keeps curated models, accepts generateContent Gemini chat, and applies conservative metadata', () => {
  assert.equal(isChatModel(discoveredRaw), true);
  assert.equal(discovered.source, 'discovered');
  assert.deepEqual(discovered.capabilities.thinkingLevels, []);
  assert.equal(discovered.capabilities.safetySettings, false);
  assert.equal(discovered.capabilities.topK, true);
  assert.equal(discovered.capabilities.outputTokenLimit, 32768);
  const merged = mergeModelCatalog([discovered]);
  assert.deepEqual(merged.slice(0, CURATED_MODELS.length).map(model => model.id), CURATED_MODELS.map(model => model.id));
  assert.equal(merged.at(-1).id, 'gemini-4-flash');
});

test('specialized, non-Gemini and models without generateContent are filtered', () => {
  for (const name of [
    'models/gemini-4-image', 'models/gemini-tts-pro', 'models/gemini-live-audio', 'models/gemini-embedding-001',
    'models/gemini-computer-use-preview', 'models/gemini-deep-research', 'models/not-gemini-chat',
  ]) assert.equal(isChatModel({ name, supportedActions: ['generateContent'] }), false, name);
  assert.equal(isChatModel({ name: 'models/gemini-4-flash', supportedActions: ['countTokens'] }), false);
});

test('/api/models is same-origin, sanitized, cached server-side, and never exposes its key', async () => {
  resetServerCatalogForTests();
  let calls = 0;
  const options = { now, listModels: async key => {
    assert.equal(key, KEY); calls += 1;
    return [discoveredRaw, { name: 'models/gemini-4-image', supportedActions: ['generateContent'] }];
  } };
  const first = await handleModels(modelRequest(), { GEMINI_API_KEY: KEY }, options);
  const payload = await first.json();
  assert.equal(first.status, 200);
  assert.deepEqual(payload.models.map(model => model.id), ['gemini-4-flash']);
  assert.ok(!JSON.stringify(payload).includes(KEY));
  await handleModels(modelRequest(), { GEMINI_API_KEY: KEY }, options);
  assert.equal(calls, 1);
  assert.equal((await handleModels(new Request('https://site.example/api/models', { headers: { Origin: 'https://evil.example' } }), { GEMINI_API_KEY: KEY }, options)).status, 403);
  assert.equal((await handleModels(modelRequest(), {}, options)).status, 503);
});

test('server authorizes discovered models only from its trusted catalog and rejects forged gemini IDs', async () => {
  resetServerCatalogForTests();
  let calls = 0, received;
  const catalogOptions = { now, listModels: async () => { calls += 1; return [discoveredRaw]; } };
  assert.equal((await trustedModelMetadata('gemini-4-flash', KEY, catalogOptions)).id, 'gemini-4-flash');
  assert.equal(await trustedModelMetadata('gemini-forged-chat', KEY, catalogOptions), null);
  const response = await handleChat(chatRequest('gemini-4-flash'), { GEMINI_API_KEY: KEY }, async function* (_, params) {
    received = params.model; yield { text: 'ok', candidates: [{ finishReason: 'STOP' }] };
  }, 1000, catalogOptions);
  await response.text();
  assert.equal(received, 'gemini-4-flash');
  const denied = await handleChat(chatRequest('gemini-forged-chat'), { GEMINI_API_KEY: KEY }, async () => assert.fail(), 1000, catalogOptions);
  assert.equal((await denied.json()).error.code, 'MODEL_UNAVAILABLE');
  assert.equal(calls, 1);
});

test('discovered model request settings omit unsupported thinking and custom safety', () => {
  const settings = {
    ...DEFAULT_GLOBAL_SETTINGS, thinkingLevel: 'high', maxOutputTokens: 64000,
    samplingOverrides: { enabled: true, temperature: 1, topP: 0.9, topK: 40 },
    safetySettings: { ...DEFAULT_GLOBAL_SETTINGS.safetySettings, mode: 'custom' },
  };
  const conservative = requestSettings(settings, {
    ...discovered, capabilities: { ...discovered.capabilities, topK: false, samplingOverrides: false, outputTokenLimit: 32768 },
  });
  assert.equal(conservative.thinkingLevel, 'default');
  assert.equal(conservative.safetySettings.mode, 'default');
  assert.equal(conservative.samplingOverrides.enabled, false);
  assert.equal(conservative.maxOutputTokens, null);
});

test('client startup uses cache immediately, refreshes once after 24h, and only saves successful syncs', async () => {
  const oldSync = new Date(now - 25 * 60 * 60 * 1000).toISOString();
  const storage = memoryStorage({
    [MODEL_CATALOG_STORAGE_KEY]: JSON.stringify({ version: 1, models: [discovered] }),
    [MODEL_CATALOG_SYNC_STORAGE_KEY]: oldSync,
  });
  let calls = 0;
  const catalog = createModelCatalog({ storage, now: () => now, fetcher: async url => {
    calls += 1; assert.equal(url, '/api/models');
    return Response.json({ models: [discovered], syncedAt: new Date(now).toISOString() });
  } });
  assert.equal(catalog.has('gemini-4-flash'), true);
  assert.deepEqual(await catalog.autoRefresh(), { attempted: true, ok: true });
  assert.equal((await catalog.autoRefresh()).reason, 'session');
  assert.equal(calls, 1);
  assert.equal(storage.getItem(MODEL_CATALOG_SYNC_STORAGE_KEY), new Date(now).toISOString());

  const failedStorage = memoryStorage({ [MODEL_CATALOG_SYNC_STORAGE_KEY]: oldSync });
  const failed = createModelCatalog({ storage: failedStorage, now: () => now, fetcher: async () => { throw new Error('offline'); } });
  assert.equal((await failed.autoRefresh()).ok, false);
  assert.equal((await failed.autoRefresh()).reason, 'session');
  assert.equal(failedStorage.getItem(MODEL_CATALOG_SYNC_STORAGE_KEY), oldSync);
});

test('fresh client cache skips startup fetch while manual refresh bypasses age and replaces unavailable discoveries', async () => {
  const storage = memoryStorage({
    [MODEL_CATALOG_STORAGE_KEY]: JSON.stringify({ version: 1, models: [discovered] }),
    [MODEL_CATALOG_SYNC_STORAGE_KEY]: new Date(now - 60_000).toISOString(),
  });
  let calls = 0;
  const catalog = createModelCatalog({ storage, now: () => now, fetcher: async url => {
    calls += 1; assert.equal(url, '/api/models?refresh=1');
    return Response.json({ models: [], syncedAt: new Date(now).toISOString() });
  } });
  assert.equal((await catalog.autoRefresh()).reason, 'fresh');
  assert.equal(calls, 0);
  await catalog.refresh({ force: true });
  assert.equal(calls, 1);
  assert.equal(catalog.has('gemini-4-flash'), false);
  assert.equal(CURATED_MODELS.every(model => catalog.has(model.id)), true);
  assert.equal(availableDefaultModel('gemini-4-flash', catalog), CURATED_MODELS[0].id);
});

test('future model IDs survive settings and backup compatibility without catalog cache entering backup', async () => {
  assert.equal(normalizeGlobalSettings({ defaultModel: 'gemini-4-flash' }).defaultModel, 'gemini-4-flash');
  const [backupSource, appSource] = await Promise.all([
    readFile(new URL('../ui/backup.js', import.meta.url), 'utf8'),
    readFile(new URL('../ui/app.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(backupSource, /MODEL_CATALOG_STORAGE_KEY|last-model-catalog-sync/);
  assert.match(appSource, /modelCatalog\.autoRefresh\(\)/);
  assert.match(appSource, /refresh\(\{ force: true \}\)/);
  assert.match(appSource, /modelCatalog\.models\.map\(model => '<button class="model-option/);
  assert.match(appSource, /defaultModelSetting'\)\.innerHTML = modelCatalog\.models/);
});
