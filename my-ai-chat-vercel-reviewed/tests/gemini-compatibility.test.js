import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { canonicalModelId, CURATED_MODELS, DEFAULT_MODEL, DEPRECATED_MODEL_REDIRECTS, modelMetadata } from '../shared/models.js';
import { DEFAULT_GLOBAL_SETTINGS } from '../shared/settings.js';
import { handleChat, validateGenerationSettings } from '../server/chat.js';
import { handleStoryMemory } from '../server/story-memory.js';
import { sanitizeListedModel } from '../server/model-catalog.js';
import { availableDefaultModel, createModelCatalog, MODEL_CATALOG_STORAGE_KEY } from '../ui/model-catalog.js';
import { requestSettings } from '../ui/settings.js';
import { createSettingsCode, parseSettingsCode } from '../ui/settings-code.js';
import { createBackup, parseBackupText } from '../ui/backup.js';
import { createChat, createMessage, visibleConversationPath } from '../ui/state.js';
import { closeChatDatabase, loadChats, saveChat } from '../ui/storage.js';

const pairs = Object.entries(DEPRECATED_MODEL_REDIRECTS);
const request = (path, payload) => new Request('https://app.example/api/' + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.example' },
  body: JSON.stringify(payload),
});
const safety = { ...DEFAULT_GLOBAL_SETTINGS.safetySettings, mode: 'custom' };
const preferences = model => ({ ...DEFAULT_GLOBAL_SETTINGS, defaultModel: model, thinkingLevel: 'high',
  samplingOverrides: { enabled: true, temperature: 0.7, topP: 0.8, topK: 30 }, safetySettings: safety });
const assertNoDeprecatedConfig = config => {
  for (const key of ['temperature', 'topP', 'topK', 'top_p', 'top_k', 'thinkingBudget', 'thinking_budget']) {
    assert.equal(Object.hasOwn(config || {}, key), false, key);
    assert.equal(Object.hasOwn(config?.thinkingConfig || {}, key), false, key);
  }
};
const memory = {
  version: 1,
  scene: { location: '图书馆', time: null, presentCharacters: [], relativePositions: [], environmentState: [], importantObjects: [] },
  characters: [], relationship: { summary: '', establishedChanges: [], sharedHistory: [], unresolvedTension: [] },
  importantEvents: [], knownFacts: [], unknownOrUnconfirmed: [], unresolvedThreads: [],
};

test('official aliases share target capabilities but never return as independent active catalog options', async () => {
  assert.equal(DEFAULT_MODEL, 'gemini-3.1-pro-preview');
  assert.equal(canonicalModelId('gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite');
  assert.equal(canonicalModelId('gemini-unconfirmed-alias'), 'gemini-unconfirmed-alias');
  const legacyDiscoveries = pairs.map(([id]) => ({ id, source: 'discovered', capabilities: {} }));
  const storage = { getItem: key => key === MODEL_CATALOG_STORAGE_KEY
    ? JSON.stringify({ version: 1, models: legacyDiscoveries }) : null, setItem() {} };
  const catalog = createModelCatalog({ storage, fetcher: async () => Response.json({ models: legacyDiscoveries }) });
  for (const [oldId, target] of pairs) {
    assert.equal(canonicalModelId(oldId), target);
    assert.equal(modelMetadata(oldId).stage, 'deprecated');
    assert.equal(modelMetadata(oldId).canonicalModelId, target);
    assert.equal(modelMetadata(oldId).capabilities, modelMetadata(target).capabilities);
    assert.match(catalog.name(oldId), new RegExp(modelMetadata(target).name));
    assert.equal(availableDefaultModel(oldId, catalog), oldId);
    assert.equal(sanitizeListedModel({ name: 'models/' + oldId, supportedActions: ['generateContent'] }), null);
    assert.equal(catalog.models.some(model => model.id === oldId), false);
  }
  await catalog.refresh({ force: true });
  assert.deepEqual(catalog.models, CURATED_MODELS);
});

test('old Chat, Backup V1 and MAICFG1 retain historical IDs, variants and sampling data', async () => {
  const db = new IDBFactory();
  try {
    for (const [id] of pairs) {
      const chat = createChat(id);
      const user = createMessage('user', '旧故事');
      const assistant = createMessage('assistant', '旧回复', id); assistant.parentUserId = user.id;
      chat.messages.push(user, assistant);
      await saveChat(chat, db);
      const loaded = (await loadChats(db)).find(value => value.id === chat.id);
      assert.equal(loaded.model, id);
      assert.equal(loaded.messages[1].model, id);
      const settings = preferences(id);
      const imported = parseSettingsCode(createSettingsCode({ settings, theme: 'dark' }));
      assert.equal(imported.settings.defaultModel, id);
      assert.deepEqual(imported.settings.samplingOverrides, settings.samplingOverrides);
      const backup = createBackup({ chats: [loaded], settings, activeChatId: chat.id });
      assert.equal(backup.version, 1);
      const restored = parseBackupText(JSON.stringify(backup));
      assert.equal(restored.chats[0].model, id);
      assert.deepEqual(visibleConversationPath(restored.chats[0]).map(m => m.id), [user.id, assistant.id]);
      assert.equal(restored.settings.defaultModel, id);
      const actualSettings = requestSettings(imported.settings, modelMetadata(id));
      assert.deepEqual(actualSettings.samplingOverrides, { enabled: false });
      assert.equal(actualSettings.thinkingLevel, 'high');
    }
  } finally { await closeChatDatabase(); }
});

test('server rejects budget and sampling penetration while thinking follows the routed target', () => {
  for (const [oldId, target] of pairs) {
    for (const invalid of [{ thinkingBudget: 100 }, { thinking_budget: 100 },
      { thinkingConfig: { thinkingBudget: 100 } }, { temperature: 0.7 }, { topP: 0.8 }, { topK: 30 },
      { samplingOverrides: { enabled: true, temperature: 0.7, topP: 0.8 } },
      { samplingOverrides: { enabled: false, temperature: '0.7' } }]) {
      assert.throws(() => validateGenerationSettings(invalid, oldId), /INVALID_REQUEST/);
    }
    for (const level of modelMetadata(target).capabilities.thinkingLevels) {
      assert.deepEqual(validateGenerationSettings({ thinkingLevel: level }, oldId), { thinkingConfig: { thinkingLevel: level.toUpperCase() } });
    }
    const minimal = requestSettings({ ...preferences(oldId), thinkingLevel: 'minimal' }, modelMetadata(oldId));
    assert.equal(minimal.thinkingLevel, target === 'gemini-3.8-flash' ? 'default' : 'minimal');
    assertNoDeprecatedConfig(validateGenerationSettings(minimal, oldId));
    assert.deepEqual(validateGenerationSettings({ thinkingLevel: 'default' }, oldId), {});
  }
});

test('final Google SDK stream requests route aliases and preserve Runtime, regenerate and custom safety', async t => {
  const captured = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const outgoing = new Request(input, init); captured.push({ url: outgoing.url, body: await outgoing.json() });
    return new Response('data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '继续正文' }] }, finishReason: 'STOP' }] }) + '\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
  });
  for (const [id, target] of pairs) {
    for (const action of [null, 'start_writing', 'continue_story', 'continue_incomplete']) {
      const messages = [{ id: 'u', role: 'user', content: '故事设定', status: 'complete' }];
      if (action?.startsWith('continue')) messages.push({ id: 'a', role: 'assistant', content: '当前正文结尾', status: 'complete' });
      const response = await handleChat(request('chat', { model: id, messages,
        settings: requestSettings(preferences(id), modelMetadata(id)), regenerationReason: 'continuity_issue',
        ...(action ? { storyRuntime: { mode: 'writing', stability: 'strict', action } } : {}),
      }), { GEMINI_API_KEY: 'test-only-sentinel' });
      assert.equal(response.status, 200); assert.match(await response.text(), /"type":"done"/);
      const last = captured.at(-1);
      assert.ok(last.url.includes('/models/' + target + ':streamGenerateContent'));
      assertNoDeprecatedConfig(last.body.generationConfig);
      assert.equal(last.body.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
      assert.equal(last.body.safetySettings.length, 4);
      if (action) assert.match(last.body.systemInstruction.parts[0].text, /STORY STABILITY — STRICT/);
      if (action?.startsWith('continue')) assert.deepEqual(last.body.contents.map(m => m.role), ['user', 'model', 'user']);
    }
  }
  assert.equal(captured.length, 8);
});

test('Story Memory final SDK config routes old IDs, retains custom safety and omits budgets and sampling', async t => {
  t.mock.method(console, 'info', () => {});
  const captured = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const outgoing = new Request(input, init); captured.push({ url: outgoing.url, body: await outgoing.json() });
    return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(memory) }] }, finishReason: 'STOP' }] });
  });
  for (const [id, target] of pairs) {
    const response = await handleStoryMemory(request('story-memory', { model: id, chatId: 'chat', anchorId: 'u', safetySettings: safety,
      messages: [{ id: 'u', role: 'user', content: '地点是图书馆', status: 'complete', createdAt: new Date().toISOString() }],
    }), { GEMINI_API_KEY: 'test-only-sentinel' });
    assert.equal(response.status, 200); assert.equal((await response.json()).memory.scene.location, '图书馆');
    const last = captured.at(-1);
    assert.ok(last.url.includes('/models/' + target + ':generateContent'));
    assertNoDeprecatedConfig(last.body.generationConfig);
    assert.equal(last.body.generationConfig.responseMimeType, 'application/json');
    assert.equal(last.body.safetySettings.length, 4);
  }
  assert.equal(captured.length, 2);
});
