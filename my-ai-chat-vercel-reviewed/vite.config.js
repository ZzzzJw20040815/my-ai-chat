import { defineConfig } from 'vite';
import { Readable } from 'node:stream';
import { handleChat } from './server/chat.js';
import { qaTransport } from './tests/qa-transport.js';
export default defineConfig({
  root: 'ui',
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: { host: '0.0.0.0', allowedHosts: ['terminal.local'] },
  plugins: [{
    name: 'no-key-server-preview',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        // Exact-size QA frames exist only in Vite development, never in the deployed Worker.
        if (req.url?.startsWith('/__qa')) {
          const mobile = req.url.includes('mobile');
          const scenario = new URL(req.url, 'http://terminal.local:4173').searchParams.get('scenario');
          const valid = ['stream','slow','429','network','model','server'].includes(scenario);
          res.setHeader('Set-Cookie', 'phase2_qa=' + (valid ? scenario : '') + '; Path=/api/chat; HttpOnly; SameSite=Strict');
          res.setHeader('Content-Type', 'text/html');
          res.end('<!doctype html><html><head><title>Phase 2 ' + (mobile ? 'Mobile' : 'Desktop') + ' QA</title><style>body{margin:0;background:#30333a;display:flex;justify-content:center;padding-top:20px}iframe{border:0;width:' + (mobile ? '390' : '1440') + 'px;height:' + (mobile ? '844' : '900') + 'px;flex-shrink:0;' + (mobile ? '' : 'transform:scale(.8);transform-origin:top center') + '}</style></head><body><iframe title="My AI Chat preview" src="/"></iframe></body></html>');
          return;
        }
        if (req.url?.split('?')[0] !== '/api/chat') return next();
        const abort = new AbortController();
        res.on('close', () => { if (!res.writableEnded) abort.abort(); });
        try {
          const request = new Request('http://terminal.local:4173/api/chat', {
            method: req.method, headers: req.headers, signal: abort.signal,
            ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
          });
          // Local QA deliberately stays keyless. Vercel reads process.env only in api/chat.js.
          const scenario = /(?:^|; )phase2_qa=(stream|slow|429|network|model|server)(?:;|$)/.exec(req.headers.cookie || '')?.[1];
          const response = scenario
            ? await handleChat(request, { GEMINI_API_KEY: 'local-qa-sentinel-not-a-key' }, qaTransport(scenario))
            : await handleChat(request, {});
          res.writeHead(response.status, Object.fromEntries(response.headers));
          for await (const chunk of response.body) res.write(chunk);
          res.end();
        } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
      });
    },
  }],
});
