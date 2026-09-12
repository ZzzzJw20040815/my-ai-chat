import { handleStoryMemory } from '../server/story-memory.js';

export default {
  fetch(request) {
    return handleStoryMemory(request, { GEMINI_API_KEY: process.env.GEMINI_API_KEY });
  },
};
