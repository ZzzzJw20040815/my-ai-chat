import {
  CHAT_TEXT_SIZES, CONTEXT_LIMITS, MAX_OUTPUT_TOKENS_LIMIT, MAX_SYSTEM_INSTRUCTION_LENGTH,
  MOBILE_DENSITIES, SAFETY_CATEGORIES, SAFETY_MODES, SAFETY_THRESHOLDS, SAMPLING_LIMITS,
  THINKING_LEVELS, normalizeGlobalSettings,
} from '../shared/settings.js';
import { isPersistableModelId } from '../shared/models.js';

export const SETTINGS_CODE_FORMAT = 'my-ai-chat-settings';
export const SETTINGS_CODE_VERSION = 1;
export const SETTINGS_CODE_PREFIX = 'MAICFG1.';
export const MAX_SETTINGS_CODE_LENGTH = 128 * 1024;
export const THEMES = Object.freeze(['dark', 'light']);

export class SettingsCodeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SettingsCodeError';
    this.code = code;
  }
}

const invalid = (message = 'Invalid settings code') => { throw new SettingsCodeError('INVALID', message); };
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requireRecord = value => { if (!record(value)) invalid(); return value; };
const validateOptional = (source, key, valid) => { if (has(source, key) && !valid(source[key])) invalid(); };
const inRange = (value, limits) => typeof value === 'number' && Number.isFinite(value)
  && value >= limits.min && value <= limits.max;

function binaryFromBytes(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return binary;
}

function encodeBase64Url(text) {
  return btoa(binaryFromBytes(new TextEncoder().encode(text)))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) invalid();
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  let binary;
  try { binary = atob(padded); } catch { invalid(); }
  try {
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { invalid(); }
}

function exportableSettings(settings) {
  const normalized = normalizeGlobalSettings(settings);
  return {
    defaultModel: normalized.defaultModel,
    systemInstruction: normalized.systemInstruction,
    contextLimit: normalized.contextLimit,
    maxOutputTokens: normalized.maxOutputTokens,
    thinkingLevel: normalized.thinkingLevel,
    samplingOverrides: { ...normalized.samplingOverrides },
    safetySettings: { ...normalized.safetySettings },
    mobileDisplay: { ...normalized.mobileDisplay },
  };
}

function validateSettings(source) {
  requireRecord(source);
  validateOptional(source, 'defaultModel', isPersistableModelId);
  validateOptional(source, 'systemInstruction', value => typeof value === 'string' && value.length <= MAX_SYSTEM_INSTRUCTION_LENGTH);
  validateOptional(source, 'contextLimit', value => CONTEXT_LIMITS.includes(String(value)));
  validateOptional(source, 'maxOutputTokens', value => value === null || (Number.isInteger(value)
    && value > 0 && value <= MAX_OUTPUT_TOKENS_LIMIT));
  validateOptional(source, 'thinkingLevel', value => THINKING_LEVELS.includes(value));

  const candidate = {};
  for (const key of ['defaultModel', 'systemInstruction', 'contextLimit', 'maxOutputTokens', 'thinkingLevel']) {
    if (has(source, key)) candidate[key] = source[key];
  }

  if (has(source, 'samplingOverrides')) {
    const sampling = requireRecord(source.samplingOverrides);
    validateOptional(sampling, 'enabled', value => typeof value === 'boolean');
    validateOptional(sampling, 'temperature', value => inRange(value, SAMPLING_LIMITS.temperature));
    validateOptional(sampling, 'topP', value => inRange(value, SAMPLING_LIMITS.topP));
    validateOptional(sampling, 'topK', value => Number.isInteger(value) && inRange(value, SAMPLING_LIMITS.topK));
    candidate.samplingOverrides = Object.fromEntries(['enabled', 'temperature', 'topP', 'topK']
      .filter(key => has(sampling, key)).map(key => [key, sampling[key]]));
  }

  if (has(source, 'safetySettings')) {
    const safety = requireRecord(source.safetySettings);
    validateOptional(safety, 'mode', value => SAFETY_MODES.includes(value));
    const categoryKeys = SAFETY_CATEGORIES.map(({ key }) => key);
    for (const key of categoryKeys) validateOptional(safety, key, value => SAFETY_THRESHOLDS.includes(value));
    candidate.safetySettings = Object.fromEntries(['mode', ...categoryKeys]
      .filter(key => has(safety, key)).map(key => [key, safety[key]]));
  }

  if (has(source, 'mobileDisplay')) {
    const mobileDisplay = requireRecord(source.mobileDisplay);
    validateOptional(mobileDisplay, 'density', value => MOBILE_DENSITIES.includes(value));
    validateOptional(mobileDisplay, 'chatTextSize', value => CHAT_TEXT_SIZES.includes(value));
    candidate.mobileDisplay = Object.fromEntries(['density', 'chatTextSize']
      .filter(key => has(mobileDisplay, key)).map(key => [key, mobileDisplay[key]]));
  }

  return normalizeGlobalSettings(candidate);
}

export function createSettingsCode({ settings, theme, now = new Date() }) {
  const safeTheme = THEMES.includes(theme) ? theme : 'dark';
  const envelope = {
    format: SETTINGS_CODE_FORMAT,
    version: SETTINGS_CODE_VERSION,
    exportedAt: now.toISOString(),
    globalSettings: exportableSettings(settings),
    appearance: { theme: safeTheme },
  };
  const code = SETTINGS_CODE_PREFIX + encodeBase64Url(JSON.stringify(envelope));
  if (code.length > MAX_SETTINGS_CODE_LENGTH) throw new SettingsCodeError('TOO_LONG', 'Settings code is too long');
  return code;
}

export function parseSettingsCode(input) {
  if (typeof input !== 'string') invalid();
  const code = input.trim();
  if (code.length > MAX_SETTINGS_CODE_LENGTH) throw new SettingsCodeError('TOO_LONG', 'Settings code is too long');
  if (!code.startsWith(SETTINGS_CODE_PREFIX)) {
    if (/^MAICFG\d+\./.test(code)) throw new SettingsCodeError('UNSUPPORTED_VERSION', 'Unsupported settings code version');
    invalid();
  }
  let envelope;
  try { envelope = JSON.parse(decodeBase64Url(code.slice(SETTINGS_CODE_PREFIX.length))); }
  catch (error) { if (error instanceof SettingsCodeError) throw error; invalid(); }
  requireRecord(envelope);
  if (envelope.format !== SETTINGS_CODE_FORMAT) invalid();
  if (envelope.version !== SETTINGS_CODE_VERSION) {
    throw new SettingsCodeError('UNSUPPORTED_VERSION', 'Unsupported settings code version');
  }
  if (typeof envelope.exportedAt !== 'string' || !Number.isFinite(Date.parse(envelope.exportedAt))) invalid();
  const appearance = requireRecord(envelope.appearance);
  validateOptional(appearance, 'theme', value => THEMES.includes(value));
  return {
    settings: validateSettings(envelope.globalSettings),
    theme: has(appearance, 'theme') ? appearance.theme : 'dark',
  };
}
