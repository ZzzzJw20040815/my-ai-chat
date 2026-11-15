import {
  DEFAULT_GLOBAL_SETTINGS, GLOBAL_SETTINGS_STORAGE_KEY, THINKING_LEVELS, normalizeGlobalSettings,
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
  const normalized = normalizeGlobalSettings(settings?.apiChannelInvalid ? { ...settings, apiChannel: undefined } : settings);
  const stored = settings?.apiChannelInvalid
    ? { ...normalized, apiChannel: settings.rejectedApiChannel || 'invalid' }
    : normalized;
  delete stored.apiChannelInvalid;
  delete stored.rejectedApiChannel;
  try { storage.setItem(GLOBAL_SETTINGS_STORAGE_KEY, JSON.stringify(stored)); } catch {}
  return settings?.apiChannelInvalid
    ? { ...normalized, apiChannel: null, apiChannelInvalid: true, rejectedApiChannel: stored.apiChannel }
    : normalized;
}

export function resetGlobalSettings(storage = localStorage) {
  return saveGlobalSettings(DEFAULT_GLOBAL_SETTINGS, storage);
}

export function thinkingLevelForModel(thinkingLevel, model) {
  const level = THINKING_LEVELS.includes(thinkingLevel) ? thinkingLevel : 'default';
  const supported = Array.isArray(model?.capabilities?.thinkingLevels) ? model.capabilities.thinkingLevels : [];
  return level !== 'default' && supported.includes(level) ? level : 'default';
}

export function requestSettings(settings, model = null) {
  const normalized = normalizeGlobalSettings(settings);
  const capabilities = model?.capabilities && typeof model.capabilities === 'object' ? model.capabilities : null;
  const thinkingLevel = thinkingLevelForModel(normalized.thinkingLevel, model);
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
