export const MODELS = Object.freeze([
  {
    id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', description: 'Advanced reasoning · Preview',
    capabilities: Object.freeze({ thinkingLevels: Object.freeze(['low', 'medium', 'high']), topK: false }),
  },
  {
    id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', description: 'Fast, everyday conversations',
    capabilities: Object.freeze({ thinkingLevels: Object.freeze(['low', 'medium', 'high']), topK: false }),
  },
]);
export const DEFAULT_MODEL = MODELS[0].id;
export const modelName = id => MODELS.find(model => model.id === id)?.name || 'Gemini';
export const isAllowedModel = id => MODELS.some(model => model.id === id);
export const modelMetadata = id => MODELS.find(model => model.id === id) || null;
