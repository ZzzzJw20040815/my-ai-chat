import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ERROR_TEXT, handleChat, validateGenerationSettings } from '../server/chat.js';
import {
  DEFAULT_GLOBAL_SETTINGS, GLOBAL_SETTINGS_STORAGE_KEY, SAFETY_CATEGORIES, SAFETY_LEVELS,
  normalizeGlobalSettings,
} from '../shared/settings.js';
import { createMessage } from '../ui/state.js';
import { loadGlobalSettings, requestSettings, resetGlobalSettings, saveGlobalSettings } from '../ui/settings.js';

const MODEL = 'gemini-3.7-flash';
const testEnv = { GEMINI_API_KEY: 'unit-test-sentinel-not-a-key' };
const memoryStorage = initial => {
  const values = new Map(Object.entries(initial || {}));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
};
const request = settings => new Request('https://site.example/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://site.example' },
  body: JSON.stringify({ model: MODEL, messages: [createMessage('user', 'hello')], settings }),
});
const events = async response => (await response.text()).split('\n')
  .map(line => line.trim()).filter(Boolean)
  .map(line => JSON.parse(line.startsWith('data:') ? line.slice(5).trimStart() : line));

test('legacy Phase 3B-1 settings upgrade without changing existing values', () => {
  const legacy = {
    defaultModel: MODEL, systemInstruction: 'Be concise.', contextLimit: '20', maxOutputTokens: 2048,
    thinkingLevel: 'high', samplingOverrides: { enabled: true, temperature: 0.8, topP: 0.9, topK: 32 },
  };
  const upgraded = normalizeGlobalSettings(legacy);
  assert.deepEqual({ ...upgraded, safetySettings: undefined }, { ...legacy, safetySettings: undefined });
  assert.deepEqual(upgraded.safetySettings, DEFAULT_GLOBAL_SETTINGS.safetySettings);
});

test('custom safety settings persist across reload and Reset restores defaults', () => {
  const storage = memoryStorage();
  const safetySettings = {
    mode: 'custom', harassment: 'OFF', hateSpeech: 'BLOCK_NONE',
    sexuallyExplicit: 'BLOCK_ONLY_HIGH', dangerousContent: 'BLOCK_LOW_AND_ABOVE',
  };
  const saved = saveGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, safetySettings }, storage);
  assert.deepEqual(loadGlobalSettings(storage).safetySettings, safetySettings);
  assert.deepEqual(JSON.parse(storage.getItem(GLOBAL_SETTINGS_STORAGE_KEY)).safetySettings, safetySettings);
  assert.deepEqual(resetGlobalSettings(storage).safetySettings, DEFAULT_GLOBAL_SETTINGS.safetySettings);
  assert.deepEqual(loadGlobalSettings(storage).safetySettings, DEFAULT_GLOBAL_SETTINGS.safetySettings);
  assert.deepEqual(requestSettings(saved).safetySettings, safetySettings);
});

test('all five UI levels map to the official Gemini thresholds', () => {
  assert.deepEqual(SAFETY_LEVELS.map(({ label, threshold }) => [label, threshold]), [
    ['Off', 'OFF'], ['Block none', 'BLOCK_NONE'], ['Block few', 'BLOCK_ONLY_HIGH'],
    ['Block some', 'BLOCK_MEDIUM_AND_ABOVE'], ['Block most', 'BLOCK_LOW_AND_ABOVE'],
  ]);
});

test('default mode omits overrides; custom mode maps exactly four whitelisted categories', () => {
  const defaults = validateGenerationSettings(requestSettings(DEFAULT_GLOBAL_SETTINGS), MODEL);
  assert.ok(!('safetySettings' in defaults));
  const custom = {
    mode: 'custom', harassment: 'OFF', hateSpeech: 'BLOCK_NONE',
    sexuallyExplicit: 'BLOCK_ONLY_HIGH', dangerousContent: 'BLOCK_LOW_AND_ABOVE',
  };
  const config = validateGenerationSettings({ safetySettings: custom }, MODEL);
  assert.deepEqual(config.safetySettings, SAFETY_CATEGORIES.map(({ key, category }) => ({
    category, threshold: custom[key],
  })));
  assert.equal(config.safetySettings.length, 4);
  assert.ok(!config.safetySettings.some(({ category }) => category.includes('CIVIC')));
});

test('server rejects unknown categories, invalid modes and invalid thresholds', () => {
  const valid = { ...DEFAULT_GLOBAL_SETTINGS.safetySettings, mode: 'custom' };
  for (const safetySettings of [
    { ...valid, civicIntegrity: 'BLOCK_NONE' },
    { ...valid, harassment: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED' },
    { ...valid, dangerousContent: 'anything' },
    { ...valid, mode: 'bypass' },
  ]) assert.throws(() => validateGenerationSettings({ safetySettings }, MODEL), /INVALID_REQUEST/);
});

test('validated custom settings reach the transport and default mode does not', async () => {
  for (const mode of ['default', 'custom']) {
    const safetySettings = { ...DEFAULT_GLOBAL_SETTINGS.safetySettings, mode };
    let params;
    const response = await handleChat(request({ safetySettings }), testEnv, async function* (_, received) {
      params = received;
      yield { text: 'ok', candidates: [{ finishReason: 'STOP' }] };
    });
    await response.text();
    assert.equal('safetySettings' in params.config, mode === 'custom');
  }
});

test('Gemini safety blocks return friendly feedback with optional whitelisted rating detail', async () => {
  const response = await handleChat(request(), testEnv, async function* () {
    yield { candidates: [{ finishReason: 'SAFETY', safetyRatings: [{
      category: 'HARM_CATEGORY_HATE_SPEECH', probability: 'HIGH', blocked: true,
    }] }] };
  });
  const output = await events(response);
  assert.equal(output.at(-1).code, 'SAFETY_BLOCKED');
  assert.equal(output.at(-1).message, ERROR_TEXT.SAFETY_BLOCKED + ' Category: Hate speech. Probability: HIGH.');
  assert.ok(!JSON.stringify(output).includes('unit-test-sentinel'));

  const promptResponse = await handleChat(request(), testEnv, async function* () {
    yield { promptFeedback: { blockReason: 'SAFETY' } };
  });
  assert.equal((await events(promptResponse)).at(-1).message, ERROR_TEXT.SAFETY_BLOCKED);
});

test('Safety UI is discrete, touchable and preserves the single Settings scroll container', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../ui/styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /Safety Settings/);
  assert.match(html, /Built-in core safety protections still apply/);
  assert.match(html, /id="safetyModeSetting"/);
  assert.match(css, /\.safety-levels\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /\.safety-levels button\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.safety-levels button\s*\{[^}]*min-height:\s*44px/);
  const dialogRule = css.match(/\.settings-dialog \{([^}]+)\}/)?.[1] || '';
  const cardRule = css.match(/\.settings-card \{([^}]+)\}/)?.[1] || '';
  assert.match(dialogRule, /overflow:\s*hidden/);
  assert.match(cardRule, /overflow-y:\s*auto/);
  assert.match(cardRule, /overflow-x:\s*hidden/);
});
