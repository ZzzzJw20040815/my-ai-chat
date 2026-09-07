import { handleChat } from '../server/chat.js';

// Vercel Node.js Function. The secret is resolved only at request time and is
// never included in the Vite client bundle.
export default {
  fetch(request) {
    return handleChat(request, { GEMINI_API_KEY: process.env.GEMINI_API_KEY });
  },
};
