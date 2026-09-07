export const MODELS = Object.freeze([
  { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', description: 'Advanced reasoning · Preview' },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', description: 'Fast, everyday conversations' },
]);
export const DEFAULT_MODEL = MODELS[0].id;
export const modelName = id => MODELS.find(model => model.id === id)?.name || 'Gemini';
export const isAllowedModel = id => MODELS.some(model => model.id === id);
