import { DEFAULT_MODEL, isAllowedModel } from './models.js';

export const GLOBAL_SETTINGS_STORAGE_KEY = 'my-ai-chat-global-settings';
export const CONTEXT_LIMITS = Object.freeze(['all', '50', '20', '10']);
export const THINKING_LEVELS = Object.freeze(['default', 'minimal', 'low', 'medium', 'high']);
export const MAX_SYSTEM_INSTRUCTION_LENGTH = 20000;
export const MAX_OUTPUT_TOKENS_LIMIT = 65536;
export const SAMPLING_LIMITS = Object.freeze({
  temperature: Object.freeze({ min: 0, max: 2 }),
  topP: Object.freeze({ min: 0, max: 1 }),
  topK: Object.freeze({ min: 1, max: 1000 }),
});

export const DEFAULT_GLOBAL_SETTINGS = Object.freeze({
  defaultModel: DEFAULT_MODEL,
  systemInstruction: '',
  contextLimit: 'all',
  maxOutputTokens: null,
  thinkingLevel: 'default',
  samplingOverrides: Object.freeze({ enabled: false, temperature: 1, topP: 0.95, topK: 40 }),
});

const inRange = (value, limits) => typeof value === 'number' && Number.isFinite(value)
  && value >= limits.min && value <= limits.max;

export function normalizeGlobalSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sampling = source.samplingOverrides && typeof source.samplingOverrides === 'object'
    && !Array.isArray(source.samplingOverrides) ? source.samplingOverrides : {};
  const maxOutputTokens = Number.isInteger(source.maxOutputTokens)
    && source.maxOutputTokens > 0 && source.maxOutputTokens <= MAX_OUTPUT_TOKENS_LIMIT
    ? source.maxOutputTokens : null;
  return {
    defaultModel: isAllowedModel(source.defaultModel) ? source.defaultModel : DEFAULT_GLOBAL_SETTINGS.defaultModel,
    systemInstruction: typeof source.systemInstruction === 'string'
      ? source.systemInstruction.slice(0, MAX_SYSTEM_INSTRUCTION_LENGTH) : '',
    contextLimit: CONTEXT_LIMITS.includes(String(source.contextLimit)) ? String(source.contextLimit) : 'all',
    maxOutputTokens,
    thinkingLevel: THINKING_LEVELS.includes(source.thinkingLevel) ? source.thinkingLevel : 'default',
    samplingOverrides: {
      enabled: sampling.enabled === true,
      temperature: inRange(sampling.temperature, SAMPLING_LIMITS.temperature)
        ? sampling.temperature : DEFAULT_GLOBAL_SETTINGS.samplingOverrides.temperature,
      topP: inRange(sampling.topP, SAMPLING_LIMITS.topP)
        ? sampling.topP : DEFAULT_GLOBAL_SETTINGS.samplingOverrides.topP,
      topK: Number.isInteger(sampling.topK) && inRange(sampling.topK, SAMPLING_LIMITS.topK)
        ? sampling.topK : DEFAULT_GLOBAL_SETTINGS.samplingOverrides.topK,
    },
  };
}
