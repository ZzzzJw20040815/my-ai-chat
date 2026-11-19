import { handleChat } from '../server/chat.js';

// Vercel Node.js Function. The secret is resolved only at request time and is
// never included in the Vite client bundle.
export default {
  fetch(request) {
    return handleChat(request, {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      VERTEX_PROJECT_ID: process.env.VERTEX_PROJECT_ID,
      VERTEX_LOCATION: process.env.VERTEX_LOCATION,
      GOOGLE_CREDENTIALS_JSON: process.env.GOOGLE_CREDENTIALS_JSON,
    });
  },
};
