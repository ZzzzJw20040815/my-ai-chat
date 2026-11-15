import { DEFAULT_MODEL, isPersistableModelId } from './models.js';

export const GLOBAL_SETTINGS_STORAGE_KEY = 'my-ai-chat-global-settings';
export const LOCAL_GEMINI_KEY_STORAGE_KEY = 'my-ai-chat-gemini-api-key';
export const API_CHANNELS = Object.freeze(['ai-studio', 'vertex']);
export const CONTEXT_LIMITS = Object.freeze(['all', '50', '20', '10']);
export const THINKING_LEVELS = Object.freeze(['default', 'minimal', 'low', 'medium', 'high', 'xhigh']);
export const THINKING_LEVEL_LABELS = Object.freeze({
  default: '默认',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
});
export const MAX_SYSTEM_INSTRUCTION_LENGTH = 20000;
export const MAX_OUTPUT_TOKENS_LIMIT = 65536;
export const SAMPLING_LIMITS = Object.freeze({
  temperature: Object.freeze({ min: 0, max: 2 }),
  topP: Object.freeze({ min: 0, max: 1 }),
  topK: Object.freeze({ min: 1, max: 1000 }),
});
export const SAFETY_MODES = Object.freeze(['default', 'custom']);
export const MOBILE_DENSITIES = Object.freeze(['compact', 'standard', 'comfortable']);
export const CHAT_TEXT_SIZES = Object.freeze(['small', 'standard', 'large']);
export const SAFETY_LEVELS = Object.freeze([
  Object.freeze({ label: 'Off', shortLabel: 'Off', threshold: 'OFF' }),
  Object.freeze({ label: 'Block none', shortLabel: 'None', threshold: 'BLOCK_NONE' }),
  Object.freeze({ label: 'Block few', shortLabel: 'Few', threshold: 'BLOCK_ONLY_HIGH' }),
  Object.freeze({ label: 'Block some', shortLabel: 'Some', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }),
  Object.freeze({ label: 'Block most', shortLabel: 'Most', threshold: 'BLOCK_LOW_AND_ABOVE' }),
]);
export const SAFETY_THRESHOLDS = Object.freeze(SAFETY_LEVELS.map(({ threshold }) => threshold));
export const SAFETY_CATEGORIES = Object.freeze([
  Object.freeze({ key: 'harassment', label: 'Harassment', category: 'HARM_CATEGORY_HARASSMENT' }),
  Object.freeze({ key: 'hateSpeech', label: 'Hate speech', category: 'HARM_CATEGORY_HATE_SPEECH' }),
  Object.freeze({ key: 'sexuallyExplicit', label: 'Sexually explicit', category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT' }),
  Object.freeze({ key: 'dangerousContent', label: 'Dangerous content', category: 'HARM_CATEGORY_DANGEROUS_CONTENT' }),
]);
const DEFAULT_SAFETY_THRESHOLD = 'BLOCK_MEDIUM_AND_ABOVE';

export const DEFAULT_GLOBAL_SETTINGS = Object.freeze({
  defaultModel: DEFAULT_MODEL,
  systemInstruction: '',
  contextLimit: 'all',
  maxOutputTokens: null,
  thinkingLevel: 'default',
  samplingOverrides: Object.freeze({ enabled: false, temperature: 1, topP: 0.95, topK: 40 }),
  safetySettings: Object.freeze({
    mode: 'default',
    harassment: DEFAULT_SAFETY_THRESHOLD,
    hateSpeech: DEFAULT_SAFETY_THRESHOLD,
    sexuallyExplicit: DEFAULT_SAFETY_THRESHOLD,
    dangerousContent: DEFAULT_SAFETY_THRESHOLD,
  }),
  mobileDisplay: Object.freeze({ density: 'standard', chatTextSize: 'standard' }),
  apiChannel: 'ai-studio',
});

export class InvalidApiChannelError extends Error {
  constructor(value) {
    super('INVALID_API_CHANNEL');
    this.name = 'InvalidApiChannelError';
    this.code = 'INVALID_API_CHANNEL';
    this.rejectedChannel = typeof value === 'string' ? value.slice(0, 80) : null;
  }
}

export function requestApiChannel(value) {
  if (value == null) return 'ai-studio';
  if (API_CHANNELS.includes(value)) return value;
  throw new InvalidApiChannelError(value);
}

const inRange = (value, limits) => typeof value === 'number' && Number.isFinite(value)
  && value >= limits.min && value <= limits.max;

export function normalizeGlobalSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sampling = source.samplingOverrides && typeof source.samplingOverrides === 'object'
    && !Array.isArray(source.samplingOverrides) ? source.samplingOverrides : {};
  const safety = source.safetySettings && typeof source.safetySettings === 'object'
    && !Array.isArray(source.safetySettings) ? source.safetySettings : {};
  const mobileDisplay = source.mobileDisplay && typeof source.mobileDisplay === 'object'
    && !Array.isArray(source.mobileDisplay) ? source.mobileDisplay : {};
  const maxOutputTokens = Number.isInteger(source.maxOutputTokens)
    && source.maxOutputTokens > 0 && source.maxOutputTokens <= MAX_OUTPUT_TOKENS_LIMIT
    ? source.maxOutputTokens : null;
  const channelPresent = Object.prototype.hasOwnProperty.call(source, 'apiChannel')
    && source.apiChannel != null && source.apiChannel !== '';
  const apiChannelInvalid = channelPresent && !API_CHANNELS.includes(source.apiChannel);
  return {
    defaultModel: isPersistableModelId(source.defaultModel) ? source.defaultModel : DEFAULT_GLOBAL_SETTINGS.defaultModel,
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
    safetySettings: {
      mode: SAFETY_MODES.includes(safety.mode) ? safety.mode : 'default',
      ...Object.fromEntries(SAFETY_CATEGORIES.map(({ key }) => [
        key,
        SAFETY_THRESHOLDS.includes(safety[key]) ? safety[key] : DEFAULT_GLOBAL_SETTINGS.safetySettings[key],
      ])),
    },
    mobileDisplay: {
      density: MOBILE_DENSITIES.includes(mobileDisplay.density) ? mobileDisplay.density : 'standard',
      chatTextSize: CHAT_TEXT_SIZES.includes(mobileDisplay.chatTextSize) ? mobileDisplay.chatTextSize : 'standard',
    },
    apiChannel: apiChannelInvalid ? null : (channelPresent ? source.apiChannel : 'ai-studio'),
    ...(apiChannelInvalid ? {
      apiChannelInvalid: true,
      rejectedApiChannel: typeof source.apiChannel === 'string' ? source.apiChannel.slice(0, 80) : 'invalid',
    } : {}),
  };
}
