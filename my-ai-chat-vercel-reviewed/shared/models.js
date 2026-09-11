const curatedCapabilities = (thinkingLevels, options = {}) => Object.freeze({
  thinking: thinkingLevels.length > 0,
  thinkingLevels: Object.freeze(thinkingLevels),
  topK: options.topK === true,
  safetySettings: true,
  samplingOverrides: true,
  outputTokenLimit: null,
  maxTemperature: null,
  topP: null,
});

export const CURATED_MODELS = Object.freeze([
  {
    id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', description: 'Advanced reasoning · Preview', stage: 'preview',
    source: 'curated', capabilities: curatedCapabilities(['low', 'medium', 'high']),
  },
  {
    id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', description: 'Most capable Flash · Stable', stage: 'stable',
    source: 'curated', capabilities: curatedCapabilities(['low', 'medium', 'high']),
  },
  {
    id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', description: 'Complex everyday work · Stable', stage: 'stable',
    source: 'curated', capabilities: curatedCapabilities(['low', 'medium', 'high']),
  },
  {
    id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', description: 'Balanced speed and quality · Stable', stage: 'stable',
    source: 'curated', capabilities: curatedCapabilities(['minimal', 'low', 'medium', 'high']),
  },
  {
    id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', description: 'High-throughput workflows · Stable', stage: 'stable',
    source: 'curated', capabilities: curatedCapabilities(['minimal', 'low', 'medium', 'high']),
  },
  {
    id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', description: 'Earlier Flash generation · Preview', stage: 'preview',
    source: 'curated', capabilities: curatedCapabilities(['minimal', 'low', 'medium', 'high']),
  },
  {
    id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', description: 'Fastest, cost-efficient · Stable', stage: 'stable',
    source: 'curated', capabilities: curatedCapabilities(['minimal', 'low', 'medium', 'high']),
  },
  {
    id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', description: 'Lightweight high-volume tasks · Stable', stage: 'stable',
    source: 'curated', capabilities: curatedCapabilities(['high']),
  },
]);
export const MODELS = CURATED_MODELS;
export const DEFAULT_MODEL = CURATED_MODELS[0].id;
export const modelName = id => CURATED_MODELS.find(model => model.id === id)?.name || modelDisplayName(id);
export const isAllowedModel = id => CURATED_MODELS.some(model => model.id === id);
export const modelMetadata = id => CURATED_MODELS.find(model => model.id === id) || null;

export function isPersistableModelId(id) {
  return typeof id === 'string' && /^gemini-[a-z0-9][a-z0-9.-]{0,99}$/.test(id);
}

export function modelDisplayName(id) {
  if (!isPersistableModelId(id)) return 'Gemini';
  return id.split('-').map(part => part === 'gemini' ? 'Gemini' : part === 'lite' ? 'Lite' : part === 'preview' ? 'Preview'
    : /^\d+(?:\.\d+)*$/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
}

export function normalizeDiscoveredModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.source !== 'discovered'
    || !isPersistableModelId(value.id)) return null;
  const capabilities = value.capabilities && typeof value.capabilities === 'object' && !Array.isArray(value.capabilities)
    ? value.capabilities : {};
  const finitePositive = number => typeof number === 'number' && Number.isFinite(number) && number > 0;
  return Object.freeze({
    id: value.id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 100) : modelDisplayName(value.id),
    description: typeof value.description === 'string' ? value.description.trim().slice(0, 180) : '',
    stage: value.stage === 'preview' ? 'preview' : 'stable',
    source: 'discovered',
    capabilities: Object.freeze({
      thinking: capabilities.thinking === true,
      // The Models API exposes a thinking boolean, not supported level enums.
      thinkingLevels: Object.freeze([]),
      topK: capabilities.topK === true,
      safetySettings: false,
      samplingOverrides: capabilities.samplingOverrides === true,
      outputTokenLimit: Number.isInteger(capabilities.outputTokenLimit) && capabilities.outputTokenLimit > 0
        ? capabilities.outputTokenLimit : null,
      maxTemperature: finitePositive(capabilities.maxTemperature) ? capabilities.maxTemperature : null,
      topP: typeof capabilities.topP === 'number' && Number.isFinite(capabilities.topP)
        && capabilities.topP >= 0 && capabilities.topP <= 1 ? capabilities.topP : null,
    }),
  });
}

export function mergeModelCatalog(discovered = []) {
  const curatedIds = new Set(CURATED_MODELS.map(model => model.id));
  const unique = new Map();
  for (const value of discovered) {
    const model = normalizeDiscoveredModel(value);
    if (model && !curatedIds.has(model.id)) unique.set(model.id, model);
  }
  const rank = stage => stage === 'stable' ? 0 : 1;
  const dynamic = [...unique.values()]
    .sort((left, right) => rank(left.stage) - rank(right.stage) || left.name.localeCompare(right.name));
  return [...CURATED_MODELS, ...dynamic];
}
