import {
  DEFAULT_GLOBAL_SETTINGS, GLOBAL_SETTINGS_STORAGE_KEY, normalizeGlobalSettings,
} from '../shared/settings.js';

export function loadGlobalSettings(storage = localStorage) {
  try {
    const raw = storage.getItem(GLOBAL_SETTINGS_STORAGE_KEY);
    return normalizeGlobalSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeGlobalSettings(null);
  }
}

export function saveGlobalSettings(settings, storage = localStorage) {
  const normalized = normalizeGlobalSettings(settings);
  try { storage.setItem(GLOBAL_SETTINGS_STORAGE_KEY, JSON.stringify(normalized)); } catch {}
  return normalized;
}

export function resetGlobalSettings(storage = localStorage) {
  return saveGlobalSettings(DEFAULT_GLOBAL_SETTINGS, storage);
}

export function requestSettings(settings) {
  const normalized = normalizeGlobalSettings(settings);
  return {
    systemInstruction: normalized.systemInstruction,
    maxOutputTokens: normalized.maxOutputTokens,
    thinkingLevel: normalized.thinkingLevel,
    samplingOverrides: { ...normalized.samplingOverrides },
    safetySettings: { ...normalized.safetySettings },
  };
}
