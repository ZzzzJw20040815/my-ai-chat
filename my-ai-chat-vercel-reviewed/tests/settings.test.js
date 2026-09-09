import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateGenerationSettings, validatePayload } from '../server/chat.js';
import { MODELS } from '../shared/models.js';
import {
  DEFAULT_GLOBAL_SETTINGS, GLOBAL_SETTINGS_STORAGE_KEY, normalizeGlobalSettings,
} from '../shared/settings.js';
import { createChat, createMessage, contextFor } from '../ui/state.js';
import { loadGlobalSettings, requestSettings, resetGlobalSettings, saveGlobalSettings } from '../ui/settings.js';

const PRO = 'gemini-3.1-pro-preview';
const FLASH = 'gemini-3.7-flash';
const memoryStorage = initial => {
  const values = new Map(Object.entries(initial || {}));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
};

test('global settings persist, tolerate malformed/legacy values, and reset independently', () => {
  const storage = memoryStorage();
  const saved = saveGlobalSettings({
    ...DEFAULT_GLOBAL_SETTINGS,
    defaultModel: FLASH,
    systemInstruction: '你是一位资深小说编辑。',
    contextLimit: '20',
    maxOutputTokens: 4096,
    thinkingLevel: 'high',
    samplingOverrides: { enabled: true, temperature: 0.8, topP: 0.9, topK: 32 },
  }, storage);
  assert.deepEqual(loadGlobalSettings(storage), saved);
  assert.equal(JSON.parse(storage.getItem(GLOBAL_SETTINGS_STORAGE_KEY)).defaultModel, FLASH);

  storage.setItem(GLOBAL_SETTINGS_STORAGE_KEY, JSON.stringify({ defaultModel: 'evil', contextLimit: -1, maxOutputTokens: NaN }));
  assert.deepEqual(loadGlobalSettings(storage), normalizeGlobalSettings(null));
  storage.setItem(GLOBAL_SETTINGS_STORAGE_KEY, '{broken');
  assert.deepEqual(loadGlobalSettings(storage), normalizeGlobalSettings(null));
  assert.deepEqual(resetGlobalSettings(storage), normalizeGlobalSettings(DEFAULT_GLOBAL_SETTINGS));
});

test('context limit trims sent history only and continues excluding interrupted assistants', () => {
  const chat = createChat(FLASH);
  for (let index = 0; index < 12; index++) {
    chat.messages.push(createMessage('user', `u${index}`), createMessage('assistant', `a${index}`, FLASH));
  }
  chat.messages[15].status = 'stopped';
  chat.messages[19].status = 'error';
  const latest = createMessage('user', 'latest');
  chat.messages.push(latest);
  const all = contextFor(chat, latest.id, 'all');
  const lastTen = contextFor(chat, latest.id, '10');
  assert.ok(all.length > lastTen.length);
  assert.ok(lastTen.length <= 10);
  assert.equal(lastTen[0].role, 'user');
  assert.equal(lastTen.at(-1).content, 'latest');
  assert.ok(!all.some(message => ['a7', 'a9'].includes(message.content)));
  assert.equal(chat.messages.length, 25);
});

test('server maps only validated settings into official Gemini config', () => {
  const config = validateGenerationSettings({
    systemInstruction: 'Answer concisely.',
    maxOutputTokens: 2048,
    thinkingLevel: 'high',
    samplingOverrides: { enabled: true, temperature: 0.7, topP: 0.8, topK: 40 },
    endpoint: 'https://evil.example', apiKey: 'never', unknown: true,
  }, FLASH);
  assert.deepEqual(config, {
    systemInstruction: 'Answer concisely.', maxOutputTokens: 2048,
    thinkingConfig: { thinkingLevel: 'HIGH' }, temperature: 0.7, topP: 0.8,
  });
  assert.ok(!('topK' in config));
  assert.ok(!('endpoint' in config));
  assert.ok(!('apiKey' in config));
});

test('model defaults omit generation overrides and sampling OFF ignores numeric values', () => {
  assert.deepEqual(validateGenerationSettings(undefined, PRO), {});
  assert.deepEqual(validateGenerationSettings({
    systemInstruction: '', maxOutputTokens: null, thinkingLevel: 'default',
    samplingOverrides: { enabled: false, temperature: 99, topP: -1, topK: -1 },
  }, PRO), {});
  const clientSettings = requestSettings(DEFAULT_GLOBAL_SETTINGS);
  assert.equal(clientSettings.maxOutputTokens, null);
  assert.equal(clientSettings.thinkingLevel, 'default');
  assert.equal(clientSettings.samplingOverrides.enabled, false);
});

test('server rejects invalid known parameters and unsupported thinking levels', () => {
  for (const settings of [
    { systemInstruction: 'x'.repeat(20001) },
    { maxOutputTokens: 0 }, { maxOutputTokens: 999999 }, { maxOutputTokens: 1.5 },
    { thinkingLevel: 'minimal' }, { thinkingLevel: 'extreme' },
    { samplingOverrides: { enabled: true, temperature: -1, topP: 0.9, topK: 40 } },
    { samplingOverrides: { enabled: true, temperature: 1, topP: 2, topK: 40 } },
  ]) assert.throws(() => validateGenerationSettings(settings, PRO), /INVALID_REQUEST/);

  const user = createMessage('user', 'hello');
  assert.throws(() => validatePayload({ model: PRO, messages: [user], settings: { maxOutputTokens: -1 } }), /INVALID_REQUEST/);
  assert.deepEqual(MODELS.map(model => model.capabilities.thinkingLevels), [
    ['low', 'medium', 'high'], ['low', 'medium', 'high'],
  ]);
});

test('settings dialog has exactly one vertical scroll container with mobile safe-area bounds', async () => {
  const css = await readFile(new URL('../ui/styles.css', import.meta.url), 'utf8');
  const dialogRule = css.match(/\.settings-dialog \{([^}]+)\}/)?.[1] || '';
  const cardRule = css.match(/\.settings-card \{([^}]+)\}/)?.[1] || '';
  assert.match(dialogRule, /overflow:\s*hidden/);
  assert.doesNotMatch(dialogRule, /overflow-y:\s*(?:auto|scroll)/);
  assert.match(cardRule, /overflow-y:\s*auto/);
  assert.match(cardRule, /overflow-x:\s*hidden/);
  assert.match(css, /safe-area-inset-top/);
  assert.match(css, /safe-area-inset-bottom/);
});
