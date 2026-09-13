import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_GLOBAL_SETTINGS, normalizeGlobalSettings } from '../shared/settings.js';
import {
  MAX_SETTINGS_CODE_LENGTH, SETTINGS_CODE_FORMAT, SETTINGS_CODE_PREFIX, SETTINGS_CODE_VERSION,
  SettingsCodeError, createSettingsCode, parseSettingsCode,
} from '../ui/settings-code.js';

const utf8Code = envelope => SETTINGS_CODE_PREFIX + Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
const envelopeFrom = code => JSON.parse(Buffer.from(code.slice(SETTINGS_CODE_PREFIX.length), 'base64url').toString('utf8'));
const validSettings = () => ({
  ...DEFAULT_GLOBAL_SETTINGS,
  defaultModel: 'gemini-3.7-flash',
  systemInstruction: '中文指令：保持角色一致。\nEmoji 🎭✨\n“引号” **Markdown** & <>',
  contextLimit: '20',
  maxOutputTokens: 4096,
  thinkingLevel: 'high',
  samplingOverrides: { enabled: true, temperature: 0.75, topP: 0.88, topK: 32 },
  safetySettings: {
    mode: 'custom', harassment: 'BLOCK_ONLY_HIGH', hateSpeech: 'BLOCK_NONE',
    sexuallyExplicit: 'BLOCK_MEDIUM_AND_ABOVE', dangerousContent: 'BLOCK_LOW_AND_ABOVE',
  },
  mobileDisplay: { density: 'compact', chatTextSize: 'small' },
});

test('Settings Code V1 has a versioned envelope and UTF-8 Base64URL round-trips all supported settings', () => {
  const settings = validSettings();
  const now = new Date('2026-09-13T12:34:56.000Z');
  const code = createSettingsCode({ settings, theme: 'light', now });
  assert.ok(code.startsWith('MAICFG1.'));
  assert.match(code.slice(SETTINGS_CODE_PREFIX.length), /^[A-Za-z0-9_-]+$/);
  const envelope = envelopeFrom(code);
  assert.equal(envelope.format, SETTINGS_CODE_FORMAT);
  assert.equal(envelope.version, SETTINGS_CODE_VERSION);
  assert.equal(envelope.exportedAt, now.toISOString());
  const imported = parseSettingsCode(` \n${code}\t`);
  assert.deepEqual(imported.settings, normalizeGlobalSettings(settings));
  assert.equal(imported.theme, 'light');
  assert.equal(imported.settings.systemInstruction, settings.systemInstruction);
});

test('the full supported Chinese System Instruction length fits the 128 KiB transport limit', () => {
  const systemInstruction = '文'.repeat(20000);
  const code = createSettingsCode({ settings: { systemInstruction }, theme: 'dark' });
  assert.ok(code.length < MAX_SETTINGS_CODE_LENGTH);
  assert.equal(parseSettingsCode(code).settings.systemInstruction, systemInstruction);
});

test('default safety mode round-trips without adding custom behavior', () => {
  const imported = parseSettingsCode(createSettingsCode({ settings: DEFAULT_GLOBAL_SETTINGS, theme: 'dark' }));
  assert.deepEqual(imported.settings.safetySettings, DEFAULT_GLOBAL_SETTINGS.safetySettings);
});

test('export is an explicit settings whitelist and excludes secrets, chats, Story data, styles, wallpaper, and arbitrary keys', () => {
  const settings = {
    ...validSettings(),
    GEMINI_API_KEY: 'server-secret', apiKey: 'client-secret', chats: [{ id: 'chat' }],
    storyMemory: { secret: true }, styleReferences: ['style'], wallpaper: 'blob', activeChatId: 'chat',
  };
  const envelope = envelopeFrom(createSettingsCode({ settings, theme: 'dark' }));
  assert.deepEqual(Object.keys(envelope.globalSettings).sort(), [
    'contextLimit', 'defaultModel', 'maxOutputTokens', 'mobileDisplay', 'safetySettings',
    'samplingOverrides', 'systemInstruction', 'thinkingLevel',
  ]);
  const serialized = JSON.stringify(envelope);
  for (const excluded of ['server-secret', 'client-secret', 'chats', 'storyMemory', 'styleReferences', 'wallpaper', 'activeChatId']) {
    assert.equal(serialized.includes(excluded), false, `${excluded} leaked into Settings Code`);
  }
});

test('missing V1 setting fields use current normalization defaults and unknown fields are ignored', () => {
  const code = utf8Code({
    format: SETTINGS_CODE_FORMAT, version: 1, exportedAt: new Date().toISOString(),
    globalSettings: { systemInstruction: '保留我', futureSetting: { enabled: true }, __protoPollution: 'no' },
    appearance: { theme: 'dark', futureAppearance: true },
    __proto__: { polluted: true },
  });
  const result = parseSettingsCode(code);
  assert.equal(result.settings.systemInstruction, '保留我');
  assert.equal(result.settings.defaultModel, DEFAULT_GLOBAL_SETTINGS.defaultModel);
  assert.deepEqual(result.settings.mobileDisplay, DEFAULT_GLOBAL_SETTINGS.mobileDisplay);
  assert.equal(Object.hasOwn(result.settings, 'futureSetting'), false);
  assert.equal({}.polluted, undefined);
});

test('malformed codes and invalid known fields are rejected before any caller can apply settings', () => {
  const base = {
    format: SETTINGS_CODE_FORMAT, version: 1, exportedAt: new Date().toISOString(),
    globalSettings: {}, appearance: { theme: 'dark' },
  };
  const rejected = [
    'not-a-settings-code',
    SETTINGS_CODE_PREFIX + '%%%bad',
    SETTINGS_CODE_PREFIX + Buffer.from('{broken', 'utf8').toString('base64url'),
    utf8Code({ ...base, format: 'wrong' }),
    utf8Code({ ...base, globalSettings: { contextLimit: '999' } }),
    utf8Code({ ...base, globalSettings: { maxOutputTokens: -1 } }),
    utf8Code({ ...base, globalSettings: { thinkingLevel: 'unlimited' } }),
    utf8Code({ ...base, globalSettings: { samplingOverrides: { temperature: 99 } } }),
    utf8Code({ ...base, globalSettings: { safetySettings: { mode: 'unsafe' } } }),
    utf8Code({ ...base, globalSettings: { mobileDisplay: { density: 'tiny' } } }),
    utf8Code({ ...base, appearance: { theme: 'neon' } }),
  ];
  for (const code of rejected) assert.throws(() => parseSettingsCode(code), SettingsCodeError);
});

test('future prefixes and envelope versions are rejected as unsupported, and oversized input is bounded', () => {
  assert.throws(() => parseSettingsCode('MAICFG2.abc'), error => error.code === 'UNSUPPORTED_VERSION');
  const versionTwo = utf8Code({
    format: SETTINGS_CODE_FORMAT, version: 2, exportedAt: new Date().toISOString(),
    globalSettings: {}, appearance: { theme: 'dark' },
  });
  assert.throws(() => parseSettingsCode(versionTwo), error => error.code === 'UNSUPPORTED_VERSION');
  assert.throws(() => parseSettingsCode('x'.repeat(MAX_SETTINGS_CODE_LENGTH + 1)), error => error.code === 'TOO_LONG');
});

test('Settings portability UI is mobile-safe and keeps one Settings scroll owner', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../ui/styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, />配置迁移</);
  assert.match(html, /id="generateSettingsCode"/);
  assert.match(html, /id="settingsCodeOutput"[^>]*readonly/);
  assert.match(html, /id="settingsCodeInput"[^>]*maxlength="131072"/);
  assert.match(html, /配置码不是加密内容/);
  assert.match(css, /\.settings-card\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.settings-code-block textarea\s*\{[^}]*width:\s*100%;[^}]*overflow-x:\s*hidden;[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /\.settings-code-action\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.settings-code-block textarea\s*\{[^}]*font-size:\s*16px/);
  assert.equal((css.match(/\.settings-card\s*\{[^}]*overflow-y:\s*auto/g) || []).length, 1);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
});
