export const MODELS = Object.freeze([
  {
    id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', description: 'Advanced reasoning · Preview', stage: 'preview',
    capabilities: Object.freeze({ thinkingLevels: Object.freeze(['low', 'medium', 'high']), topK: false, safetySettings: true }),
  },
  {
    id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', description: 'Most capable Flash · Stable', stage: 'stable',
    capabilities: Object.freeze({ thinkingLevels: Object.freeze(['low', 'medium', 'high']), topK: false, safetySettings: true }),
  },
  {
    id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', description: 'Complex everyday work · Stable', stage: 'stable',
    capabilities: Object.freeze({ thinkingLevels: Object.freeze(['low', 'medium', 'high']), topK: false, safetySettings: true }),
  },
  {
    id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', description: 'Balanced speed and quality · Stable', stage: 'stable',
    capabilities: Object.freeze({ thinkingLevels: Object.freeze(['minimal', 'low', 'medium', 'high']), topK: false, safetySettings: true }),
  },
  {
    id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', description: 'High-throughput workflows · Stable', stage: 'stable',
    capabilities: Object.freeze({ thinkingLevels: Object.freeze(['minimal', 'low', 'medium', 'high']), topK: false, safetySettings: true }),
  },
  {
    id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', description: 'Earlier Flash generation · Preview', stage: 'preview',
    capabilities: Object.freeze({ thinkingLevels: Object.freeze(['minimal', 'low', 'medium', 'high']), topK: false, safetySettings: true }),
  },
  {
    id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', description: 'Fastest, cost-efficient · Stable', stage: 'stable',
    capabilities: Object.freeze({ thinkingLevels: Object.freeze(['minimal', 'low', 'medium', 'high']), topK: false, safetySettings: true }),
  },
  {
    id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', description: 'Lightweight high-volume tasks · Stable', stage: 'stable',
    capabilities: Object.freeze({ thinkingLevels: Object.freeze(['high']), topK: false, safetySettings: true }),
  },
]);
export const DEFAULT_MODEL = MODELS[0].id;
export const modelName = id => MODELS.find(model => model.id === id)?.name || 'Gemini';
export const isAllowedModel = id => MODELS.some(model => model.id === id);
export const modelMetadata = id => MODELS.find(model => model.id === id) || null;
