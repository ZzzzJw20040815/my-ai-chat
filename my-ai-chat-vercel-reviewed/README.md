# My AI Chat — Vercel Migration Package

Vanilla HTML/CSS/JavaScript AI chat client migrated from the tagged
`phase-2-sites-stable-baseline`. The UI and browser behavior are unchanged.

## Architecture

- `ui/` contains the Vite frontend. It always calls the same-origin `POST /api/chat` route.
- `api/chat.js` is a Vercel Node.js Function and is the only place that reads
  `process.env.GEMINI_API_KEY`.
- `server/chat.js` validates requests and the model whitelist, forwards complete
  conversation context to the official `@google/genai` SDK, and converts
  `generateContentStream()` chunks into SSE events.
- `ui/stream.js` incrementally consumes SSE; the existing browser AbortController
  propagates through `request.signal` to Gemini's `abortSignal`.
- `ui/state.js` owns UUID-based in-memory Chat and Message records.
- `ui/markdown.js` renders Markdown with marked and sanitizes it with DOMPurify.

Curated model IDs live in `shared/models.js`. The default remains `gemini-3.1-pro-preview`. Automatically discovered chat models stay available, but only curated models expose thinking levels.

- `gemini-3.1-pro-preview` (default)
- `gemini-3.8-flash`
- `gemini-3.7-flash`
- `gemini-3.6-flash`
- `gemini-3.5-flash`
- `gemini-3-flash-preview`
- `gemini-3.5-flash-lite`
- `gemini-3.1-flash-lite`
- `gemini-4-carbon`
- `gemini-4-argon`
- `gemini-4-hydrogen`

## Local validation

```sh
npm install
npm run build
npm test
```

The test suite intercepts SDK network requests and uses noncredential sentinels.
It does not call Google.

## API channels and secrets

AI Studio requests keep using the server-only `GEMINI_API_KEY`. Vertex requests use
`VERTEX_PROJECT_ID`, optional `VERTEX_LOCATION` (default `global`), and
`GOOGLE_CREDENTIALS_JSON` (an `authorized_user` JSON document with `client_id`,
`client_secret`, and `refresh_token`). Set all of these as server Secrets.
Do not add a `VITE_` prefix, do not commit them, and do not put them in a file
uploaded with the project. The browser never receives an access token, refresh
token, client secret, or credential JSON.

This app has no user login. Same-origin visitors can call the chat, story-memory,
and model routes. Turning on Vertex therefore lets those visitors spend the
Google Cloud project's quota. Do not enable Vertex on a public deployment until
you add an access control that you control. The curated Vertex catalog is not
proof that the project or region can actually serve a model. Tests mock OAuth
and the Vertex HTTP API; they do not verify live model access or billing.

Switching channels does not delete a Gemini API key saved in browser storage
under `my-ai-chat-gemini-api-key`, and Vertex requests do not send that key.
AI Studio continues to read only the server `GEMINI_API_KEY`.

## Vercel setup

Deploy the project root. Vercel uses `vercel.json`, runs `npm run build`, serves
`dist/client`, and exposes the function as `/api/chat`.

In Vercel Project Settings, add `GEMINI_API_KEY` as a Secret for Production and,
if desired, Preview. Do not add a `VITE_` prefix and do not place a real key in
any `.env` file committed or uploaded with this project.

After deploying, verify real streaming, Stop propagation, both model permissions,
and the configured function-duration limit. Chats remain browser-memory only;
there is no database, login, upload system, or cloud sync in this package.

## Vercel cancellation note

`vercel.json` explicitly enables `supportsCancellation` for `api/chat.js` so a
browser-side Stop/cancel can propagate through `request.signal` to the Gemini
SDK on Vercel's Node.js runtime.
test for chat
