import { handleModels } from '../server/model-catalog.js';

export default {
  fetch(request) {
    return handleModels(request, { GEMINI_API_KEY: process.env.GEMINI_API_KEY });
  },
};
