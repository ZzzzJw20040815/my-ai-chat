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

export function requestSettings(settings, model = null) {
  const normalized = normalizeGlobalSettings(settings);
  const capabilities = model?.capabilities;
  const conservative = model?.source === 'discovered';
  const thinkingLevel = capabilities && !capabilities.thinkingLevels.includes(normalized.thinkingLevel)
    ? 'default' : normalized.thinkingLevel;
  const samplingEnabled = capabilities
    ? normalized.samplingOverrides.enabled && capabilities.samplingOverrides === true
    : normalized.samplingOverrides.enabled;
  const safetyMode = capabilities && capabilities.safetySettings !== true ? 'default' : normalized.safetySettings.mode;
  const maxOutputTokens = capabilities?.outputTokenLimit && normalized.maxOutputTokens > capabilities.outputTokenLimit
    ? null : normalized.maxOutputTokens;
  return {
    systemInstruction: normalized.systemInstruction,
    maxOutputTokens,
    thinkingLevel: conservative && !capabilities ? 'default' : thinkingLevel,
    samplingOverrides: { ...normalized.samplingOverrides, enabled: samplingEnabled },
    safetySettings: { ...normalized.safetySettings, mode: safetyMode },
  };
}
