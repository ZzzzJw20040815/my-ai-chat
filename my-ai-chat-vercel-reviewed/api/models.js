import { handleModels } from '../server/model-catalog.js';

export default {
  fetch(request) {
    return handleModels(request, {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      VERTEX_PROJECT_ID: process.env.VERTEX_PROJECT_ID,
      VERTEX_LOCATION: process.env.VERTEX_LOCATION,
      GOOGLE_CREDENTIALS_JSON: process.env.GOOGLE_CREDENTIALS_JSON,
    });
  },
};
