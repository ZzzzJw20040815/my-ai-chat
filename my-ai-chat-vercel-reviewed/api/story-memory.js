import { handleStoryMemory } from '../server/story-memory.js';

export default {
  fetch(request) {
    return handleStoryMemory(request, {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      VERTEX_PROJECT_ID: process.env.VERTEX_PROJECT_ID,
      VERTEX_LOCATION: process.env.VERTEX_LOCATION,
      GOOGLE_CREDENTIALS_JSON: process.env.GOOGLE_CREDENTIALS_JSON,
    });
  },
};
