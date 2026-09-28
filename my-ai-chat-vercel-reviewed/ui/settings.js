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
  const capabilities = model?.capabilities && typeof model.capabilities === 'object' ? model.capabilities : null;
  const supportedThinkingLevels = Array.isArray(capabilities?.thinkingLevels) ? capabilities.thinkingLevels : [];
  const thinkingLevel = normalized.thinkingLevel !== 'default' && supportedThinkingLevels.includes(normalized.thinkingLevel)
    ? normalized.thinkingLevel : 'default';
  const samplingEnabled = capabilities?.samplingOverrides === true && normalized.samplingOverrides.enabled;
  const outputTokenLimit = Number.isInteger(capabilities?.outputTokenLimit) && capabilities.outputTokenLimit > 0
    ? capabilities.outputTokenLimit : null;
  const maxOutputTokens = normalized.maxOutputTokens != null && outputTokenLimit != null
    && normalized.maxOutputTokens <= outputTokenLimit ? normalized.maxOutputTokens : null;
  const customSafety = capabilities?.safetySettings === true && normalized.safetySettings.mode === 'custom';
  const samplingOverrides = samplingEnabled ? {
    enabled: true,
    temperature: normalized.samplingOverrides.temperature,
    topP: normalized.samplingOverrides.topP,
    ...(capabilities?.topK === true ? { topK: normalized.samplingOverrides.topK } : {}),
  } : { enabled: false };
  return {
    systemInstruction: normalized.systemInstruction,
    maxOutputTokens,
    thinkingLevel,
    samplingOverrides,
    safetySettings: customSafety ? { ...normalized.safetySettings, mode: 'custom' } : { mode: 'default' },
  };
}
