// Real Chrome loads the built page, talks to the local API, and only sees mocked upstream responses.
// Sentinels are not credentials. Chrome is prevented from resolving any host except loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import api from '../api/chat.js';
import storyApi from '../api/story-memory.js';
import { ERROR_TEXT, MAX_VISIBLE_OUTPUT_CHARS } from '../server/chat.js';
import { resetVertexAuthForTests } from '../server/vertex-auth.js';
import { createBackup } from '../ui/backup.js';
import { createChat, createMessage } from '../ui/state.js';
import { SEARCH_SUGGESTION_ATTACK } from './search-suggestion-sample.js';

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const ROOT = new URL('../dist/client/', import.meta.url);
const SHOTS = '/opt/cursor/artifacts/integration-ui';
const GEMINI_KEY = 'gemini-key-sentinel';
const ACCESS = 'access-token-sentinel';
const SECRET = 'refresh-token-sentinel';
const CREDENTIALS = {
  type: 'authorized_user', client_id: 'client-id-sentinel', client_secret: 'client-secret-sentinel', refresh_token: SECRET,
};
const MEMORY = {
  version: 1,
  scene: { location: 'Library', time: null, presentCharacters: ['A', 'B'], relativePositions: [], environmentState: [], importantObjects: [] },
  characters: [],
  relationship: { summary: '', establishedChanges: [], sharedHistory: [], unresolvedTension: [] },
  importantEvents: [], knownFacts: ['A met B.'], unknownOrUnconfirmed: [], unresolvedThreads: [],
};
const ATTACK = `${SEARCH_SUGGESTION_ATTACK}
<a href="&#106;avascript&#58;alert(1)">encoded</a>
<div class="fixed-probe" style="position: fixed; inset: 0">cover</div>`;
const encoder = new TextEncoder();
const sse = payload => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
const textEvent = (text, finishReason, groundingMetadata) => sse({
  candidates: [{
    content: { role: 'model', parts: text ? [{ text }] : [] },
    ...(finishReason ? { finishReason } : {}),
    ...(groundingMetadata ? { groundingMetadata } : {}),
  }],
});

function upstream(body, signal) {
  const last = [...(body.contents || [])].reverse().find(item => item.role === 'user');
  const text = (last?.parts || []).map(part => part.text || '').join('\n');
  const stream = chunks => new Response(new ReadableStream({
    async start(controller) {
      try {
        for (const chunk of chunks) {
          if (signal?.aborted) break;
          controller.enqueue(chunk);
          await new Promise(resolve => setTimeout(resolve, 15));
        }
        if (!signal?.aborted) controller.close();
      } catch (error) {
        try { controller.error(error); } catch { /* already closed */ }
      }
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  if (text.includes('Begin the formal story')) return stream([textEvent('正文开场。', 'STOP')]);
  if (text.includes('你的输出未完整') || text.trim() === '继续') return stream([textEvent('续写完成。', 'STOP')]);
  if (text.includes('超长输出')) return stream([
    textEvent('A'.repeat(MAX_VISIBLE_OUTPUT_CHARS - 40000)),
    textEvent('B'.repeat(60000), 'STOP'),
  ]);
  if (text.includes('额度耗尽')) return stream([sse({
    candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [{ text: '只存在于思考', thought: true }] } }],
  })]);
  if (text.includes('恶意建议')) return stream([textEvent('来源在下面。', 'STOP', {
    webSearchQueries: ['local qa'],
    searchEntryPoint: { renderedContent: ATTACK },
    groundingChunks: [
      { web: { uri: 'https://example.com/ok', title: 'OK' } },
      { web: { uri: 'javascript:alert(1)', title: 'Script' } },
      { web: { uri: '&#106;avascript:alert(1)', title: 'Encoded' } },
    ],
  })]);
  if (text.includes('请慢慢写')) {
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(textEvent('已经写出的半句'));
        const fail = reason => { try { controller.error(reason); } catch { /* already closed */ } };
        const timer = setTimeout(() => fail(new Error('stop was not observed')), 8000);
        const abort = () => { clearTimeout(timer); fail(new DOMException('Aborted', 'AbortError')); };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  return stream([textEvent(`回复：${text.slice(0, 24)}`, 'STOP')]);
}

function contentType(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

async function startApp() {
  resetVertexAuthForTests();
  const chatPayloads = [];
  const memoryPayloads = [];
  const upstreamCalls = [];
  const leaked = [];
  let upstreamSignal = null;
  let port = 0;
  const previousFetch = globalThis.fetch;
  const previous = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    VERTEX_PROJECT_ID: process.env.VERTEX_PROJECT_ID,
    VERTEX_LOCATION: process.env.VERTEX_LOCATION,
    GOOGLE_CREDENTIALS_JSON: process.env.GOOGLE_CREDENTIALS_JSON,
  };
  process.env.GEMINI_API_KEY = GEMINI_KEY;
  process.env.VERTEX_PROJECT_ID = 'vertex-proj';
  process.env.VERTEX_LOCATION = 'global';
  process.env.GOOGLE_CREDENTIALS_JSON = JSON.stringify(CREDENTIALS);
  globalThis.fetch = async (input, init = {}) => {
    const request = new Request(input, init);
    const url = request.url;
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return previousFetch(input, init);
    const allowed = url.startsWith('https://generativelanguage.googleapis.com/')
      || url.startsWith('https://oauth2.googleapis.com/token')
      || url.startsWith('https://aiplatform.googleapis.com/');
    if (!allowed) {
      leaked.push(url);
      throw new Error(`blocked egress ${url}`);
    }
    assert.equal(url.includes(SECRET), false);
    assert.equal(url.includes(GEMINI_KEY), false);
    const record = {
      url,
      authorization: request.headers.get('authorization'),
      apiKey: request.headers.get('x-goog-api-key'),
      project: request.headers.get('x-goog-user-project'),
      body: request.headers.get('content-type')?.includes('json') ? await request.json() : null,
    };
    upstreamCalls.push(record);
    upstreamSignal = init.signal || request.signal;
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: ACCESS, expires_in: 3600 });
    if (url.includes(':generateContent') && !url.includes('streamGenerateContent')) {
      assert.equal(record.body?.tools, undefined);
      return Response.json({
        candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: JSON.stringify(MEMORY) }] } }],
      });
    }
    return upstream(record.body, upstreamSignal);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/models') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ models: [], syncedAt: new Date().toISOString() }));
        return;
      }
      if (url.pathname === '/api/chat' || url.pathname === '/api/story-memory') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const parsed = JSON.parse(body.toString('utf8'));
        if (url.pathname === '/api/chat') chatPayloads.push(parsed);
        else memoryPayloads.push(parsed);
        const abort = new AbortController();
        res.on('close', () => { if (!res.writableEnded) abort.abort(); });
        const handler = url.pathname === '/api/chat' ? api : storyApi;
        const response = await handler.fetch(new Request(`http://127.0.0.1:${port}${url.pathname}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: req.headers.origin || `http://127.0.0.1:${port}`,
            'Sec-Fetch-Site': 'same-origin',
          },
          body,
          signal: abort.signal,
        }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (!response.body) { res.end(); return; }
        const reader = response.body.getReader();
        while (true) {
          const step = await reader.read();
          if (step.done) break;
          res.write(step.value);
        }
        res.end();
        return;
      }
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = join(ROOT.pathname, relative);
      await stat(file);
      res.writeHead(200, { 'Content-Type': contentType(file) });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return {
    chatPayloads, memoryPayloads, upstreamCalls, leaked,
    origin: `http://127.0.0.1:${port}`,
    signal: () => upstreamSignal,
    async close() {
      server.close();
      globalThis.fetch = previousFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function openSocket(url) {
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error(`Could not connect to Chrome at ${url}`)), { once: true });
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 0;
    this.pending = new Map();
    this.blocked = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Fetch.requestPaused') {
        const url = message.params.request.url;
        let local = false;
        try {
          const parsed = new URL(url);
          local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:';
        } catch { local = url.startsWith('data:') || url.startsWith('about:'); }
        if (!local) this.blocked.push(url);
        const id = ++this.next;
        this.ws.send(JSON.stringify({
          id, method: local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          params: local ? { requestId: message.params.requestId } : { requestId: message.params.requestId, errorReason: 'BlockedByClient' },
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
        }));
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

async function launchChrome() {
  const profile = `/tmp/chrome-integration-${process.pid}-${Date.now()}`;
  let chrome;
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-background-networking', '--no-first-run',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const browserUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not open a DevTools port')), 10000);
    const read = chunk => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    };
    chrome.stdout.on('data', read);
    chrome.stderr.on('data', read);
    chrome.on('exit', code => reject(new Error(`Chrome exited before DevTools was ready (${code})`)));
  });
  let version;
  try {
    version = await (await fetch(browserUrl.replace(/^ws/, 'http').replace(/\/devtools\/browser\/.*$/, '/json/version'))).json();
  } catch (error) {
    chrome.kill();
    throw error;
  }
  const browser = new Cdp(await openSocket(version.webSocketDebuggerUrl));
  let targetId;
  try {
    ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }));
  } catch (error) {
    chrome.kill();
    browser.ws.close();
    throw error;
  }
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  return {
    blocked: browser.blocked,
    browserVersion: version.Browser,
    async viewport(width, height) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 820 });
    },
    async goto(url) { await send('Page.navigate', { url }); await new Promise(resolve => setTimeout(resolve, 500)); },
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    },
    async shot(name) {
      const image = await send('Page.captureScreenshot', { format: 'png' });
      await mkdir(SHOTS, { recursive: true });
      await writeFile(join(SHOTS, name), Buffer.from(image.data, 'base64'));
    },
    async setFile(selector, path) {
      const root = await send('DOM.getDocument', { depth: 1 });
      const node = await send('DOM.querySelector', { nodeId: root.root.nodeId, selector });
      await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [path] });
    },
    async close() { chrome.kill(); browser.ws.close(); },
  };
}

async function waitFor(check, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Chrome');
}

test('Chrome exercises original UI, both providers, search, and continuation against mocked upstream', { timeout: 180000 }, async () => {
  await stat(new URL('../dist/client/index.html', import.meta.url));
  const app = await startApp();
  let browser;
  try {
    browser = await launchChrome();
    assert.match(browser.browserVersion, /Chrome\/157/);
    await browser.viewport(1280, 800);
    await browser.goto(`${app.origin}/`);
    await browser.evaluate(`new Promise(resolve => {
      const timer = setInterval(() => {
        if (document.querySelector('#newChatButton') && document.querySelector('#messageInput')) { clearInterval(timer); resolve(true); }
      }, 20);
    })`);
    const see = text => browser.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
    const sendText = async text => {
      const before = app.chatPayloads.length;
      await browser.evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#composerForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`);
      return before;
    };
    const fresh = async () => {
      await browser.evaluate(`document.querySelector('#newChatButton').click()`);
      await waitFor(() => browser.evaluate(`document.querySelector('#conversation h1')?.textContent === 'What would you like to explore?'`));
    };
    const lastPayload = text => {
      const payload = app.chatPayloads.at(-1);
      return payload?.messages?.at(-1)?.content === text ? payload : null;
    };
    const lastModel = () => [...app.upstreamCalls].reverse().find(call => !call.url.includes('oauth2.googleapis.com'));

    await fresh();
    const helloCount = await sendText('普通问候');
    await waitFor(() => see('回复：普通问候'));
    const hello = await waitFor(() => app.chatPayloads.length > helloCount && lastPayload('普通问候'));
    assert.equal(hello.apiChannel || 'ai-studio', 'ai-studio');
    assert.equal(hello.settings.webSearch, 'on');
    assert.deepEqual(lastModel().body.tools, [{ googleSearch: {} }]);
    assert.match(lastModel().url, /generativelanguage\.googleapis\.com/);
    const desktop = await browser.evaluate(`(() => {
      const card = document.querySelector('.assistant-body');
      const style = getComputedStyle(card);
      const dot = document.querySelector('.model-dot');
      return {
        dot: Boolean(dot),
        bg: style.backgroundColor,
        shadow: style.boxShadow,
        maxWidth: style.maxWidth,
        conversationMax: getComputedStyle(document.querySelector('.conversation')).maxWidth,
        thinking: Boolean(document.querySelector('#thinkingMode')),
        channel: document.querySelector('#apiChannelToolbar')?.value,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    })()`);
    assert.equal(desktop.dot, true);
    assert.notEqual(desktop.maxWidth, '72ch');
    assert.notEqual(desktop.conversationMax, '72ch');
    assert.equal(desktop.bg === 'rgba(0, 0, 0, 0)' || desktop.bg === 'transparent', false);
    assert.notEqual(desktop.shadow, 'none');
    assert.equal(desktop.thinking, true);
    assert.equal(desktop.channel, 'ai-studio');
    assert.ok(desktop.overflow <= 1);
    await browser.shot('desktop-1280-original.png');
    await browser.viewport(768, 900);
    await new Promise(resolve => setTimeout(resolve, 200));
    const tablet = await browser.evaluate(`(() => {
      const sidebar = document.querySelector('#sidebar');
      return {
        open: sidebar.classList.contains('open'),
        sidebarRight: sidebar.getBoundingClientRect().right,
        model: document.querySelector('#currentModel').textContent,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    })()`);
    assert.equal(tablet.open, false);
    assert.ok(tablet.sidebarRight <= 1, JSON.stringify(tablet));
    assert.equal(tablet.model, 'Gemini 3.1 Pro');
    assert.ok(tablet.overflow <= 1, JSON.stringify(tablet));
    await browser.shot('tablet-768-original.png');
    await browser.viewport(375, 812);
    const mobile = await browser.evaluate(`(() => {
      const thinking = document.querySelector('#thinkingMode');
      const channel = document.querySelector('#apiChannelToolbar');
      return {
        thinkingHeight: thinking.getBoundingClientRect().height,
        channelHeight: channel.getBoundingClientRect().height,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        dot: Boolean(document.querySelector('.model-dot')),
      };
    })()`);
    assert.ok(mobile.thinkingHeight >= 44);
    assert.ok(mobile.channelHeight >= 44);
    assert.ok(mobile.overflow <= 1);
    assert.equal(mobile.dot, true);
    await browser.shot('mobile-375-original.png');
    await browser.viewport(1280, 800);

    await browser.evaluate(`document.querySelector('#settingsButton').click()`);
    await waitFor(() => browser.evaluate(`document.querySelector('#settingsDialog').open && document.querySelector('#webSearchSetting')`));
    await browser.shot('settings-search-toggle.png');
    await browser.evaluate(`document.querySelector('#webSearchSetting').click()`);
    await waitFor(() => browser.evaluate(`document.querySelector('#webSearchSetting').checked === false`));
    await browser.evaluate(`document.querySelector('#settingsDialog').close()`);
    const offCount = await sendText('关闭搜索');
    await waitFor(() => see('回复：关闭搜索'));
    const off = await waitFor(() => app.chatPayloads.length > offCount && lastPayload('关闭搜索'));
    assert.equal(off.settings.webSearch, 'off');
    assert.equal(lastModel().body.tools, undefined);

    await browser.evaluate(`document.querySelector('#settingsButton').click()`);
    await browser.evaluate(`document.querySelector('#webSearchSetting').click()`);
    await waitFor(() => browser.evaluate(`document.querySelector('#webSearchSetting').checked === true`));
    await browser.evaluate(`document.querySelector('#settingsDialog').close()`);

    await fresh();
    const longCount = await sendText('超长输出');
    await waitFor(() => see(ERROR_TEXT.TRUNCATED), 45000);
    const shown = await browser.evaluate(`[...document.querySelectorAll('.message.assistant .message-content')].at(-1).textContent.trim().length`);
    assert.equal(shown, MAX_VISIBLE_OUTPUT_CHARS);
    assert.equal(await browser.evaluate(`Boolean(document.querySelector('[data-action="continue-incomplete"]'))`), true);
    await browser.shot('continuation-partial.png');
    const continueCount = await sendText('你的输出未完整 请继续输出');
    const continued = await waitFor(() => app.chatPayloads.length > continueCount && lastPayload('你的输出未完整 请继续输出'));
    assert.equal(continued.messages.some(message => message.role === 'assistant' && message.content.length === MAX_VISIBLE_OUTPUT_CHARS), true);
    assert.equal(JSON.stringify(continued.messages).includes(ERROR_TEXT.TRUNCATED), false);
    assert.match(continued.settings.systemInstruction, /exact ending/);
    await waitFor(() => see('续写完成。'), 45000);

    await fresh();
    const attackCount = await sendText('恶意建议');
    await waitFor(() => see('来源在下面'));
    await waitFor(() => browser.evaluate(`document.querySelector('.search-suggestion-host')?.shadowRoot?.textContent?.includes('local qa')`));
    const attack = await waitFor(() => app.chatPayloads.length > attackCount && lastPayload('恶意建议'));
    assert.deepEqual(attack.settings.webSearch, 'on');
    assert.deepEqual(lastModel().body.tools, [{ googleSearch: {} }]);
    const cleaned = await browser.evaluate(`(() => {
      const host = document.querySelector('.search-suggestion-host');
      const shadow = host?.shadowRoot;
      const hrefs = [...document.querySelectorAll('a'), ...(shadow ? shadow.querySelectorAll('a') : [])].map(link => link.getAttribute('href') || '');
      const probe = shadow?.querySelector('.fixed-probe');
      const heading = document.querySelector('#conversation h1').getBoundingClientRect();
      return {
        contain: host ? getComputedStyle(host).contain : '',
        overflow: host ? getComputedStyle(host).overflow : '',
        hrefs,
        probeInsideShadow: Boolean(probe),
        probeEscaped: Boolean(document.querySelector('.fixed-probe')),
        headingVisible: heading.width > 0 && heading.height > 0 && heading.top < window.innerHeight,
        body: document.body.innerText.includes('javascript:'),
      };
    })()`);
    assert.match(cleaned.contain, /paint/);
    assert.equal(cleaned.overflow, 'hidden');
    assert.equal(cleaned.hrefs.some(href => /javascript/i.test(href)), false);
    assert.equal(cleaned.probeInsideShadow, true);
    assert.equal(cleaned.probeEscaped, false);
    assert.equal(cleaned.headingVisible, true);
    assert.equal(cleaned.body, false);
    assert.equal(await see('OK'), true);
    assert.equal(await see('Script'), false);
    await browser.shot('search-suggestion-contained.png');

    await fresh();
    await sendText('变体测试');
    await waitFor(() => see('回复：变体测试'));
    await waitFor(() => browser.evaluate(`document.querySelector('#sendButton').getAttribute('aria-label') === 'Send message'`));
    const regenNav = await browser.evaluate(`(() => {
      document.querySelector('.message.assistant [data-action="regenerate"]').click();
      document.querySelector('#regenerateMenu [data-regeneration-reason]').click();
      return document.querySelector('.variant-nav')?.textContent || '';
    })()`);
    assert.match(regenNav, /\/ 2/);
    await waitFor(() => browser.evaluate(`document.querySelector('#sendButton').getAttribute('aria-label') === 'Send message'`));
    await browser.evaluate(`document.querySelector('[data-action="variant-prev"]').click()`);
    await waitFor(() => see('回复：变体测试'));
    await browser.evaluate(`document.querySelector('.message.user [data-action="edit"]').click()`);
    await browser.evaluate(`(() => {
      const editor = document.querySelector('.edit-area textarea');
      editor.value = '另一条用户分支';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-action="edit-save"]').click();
    })()`);
    await waitFor(() => see('回复：另一条用户分支'));
    await browser.evaluate(`document.querySelector('[data-action="user-variant-prev"]').click()`);
    await waitFor(() => see('变体测试'));

    await fresh();
    await browser.evaluate(`document.querySelector('#modelButton').click()`);
    await browser.evaluate(`document.querySelector('[data-model="gemini-4-hydrogen"]').click()`);
    await waitFor(() => see('Gemini 4 Hydrogen'));
    await browser.evaluate(`document.querySelector('#thinkingMode').click()`);
    await browser.evaluate(`document.querySelector('#thinkingMenu [data-thinking-level="xhigh"]').click()`);
    await browser.evaluate(`document.querySelector('#apiChannelToolbar').value = 'vertex';
      document.querySelector('#apiChannelToolbar').dispatchEvent(new Event('change', { bubbles: true }));`);
    await waitFor(() => browser.evaluate(`document.querySelector('#apiChannelToolbar').value === 'vertex' && document.querySelector('#thinkingModeLabel').textContent === 'Extra High'`));
    await browser.shot('thinking-vertex-controls.png');
    const vertexCount = await sendText('Vertex 思考');
    await waitFor(() => see('回复：Vertex 思考'));
    const vertex = await waitFor(() => app.chatPayloads.length > vertexCount && lastPayload('Vertex 思考'));
    assert.equal(vertex.apiChannel, 'vertex');
    assert.equal(vertex.settings.thinkingLevel, 'xhigh');
    assert.equal(vertex.settings.webSearch, 'on');
    const vertexCall = lastModel();
    assert.match(vertexCall.url, /^https:\/\/aiplatform\.googleapis\.com\//);
    assert.equal(vertexCall.authorization, `Bearer ${ACCESS}`);
    assert.equal(vertexCall.project, 'vertex-proj');
    assert.equal(vertexCall.apiKey, null);
    assert.equal(vertexCall.body.generationConfig.thinkingConfig.thinkingLevel, 'XHIGH');
    assert.equal(JSON.stringify(vertexCall.body).includes('thinkingBudget'), false);
    assert.deepEqual(vertexCall.body.tools, [{ googleSearch: {} }]);
    assert.equal(vertexCall.url.includes(GEMINI_KEY), false);

    await browser.evaluate(`document.querySelector('[data-story-runtime-action="prepare_story"]').click()`);
    await waitFor(() => see('构思中'));
    const setupCount = await sendText('构思补充');
    const setup = await waitFor(() => app.chatPayloads.length > setupCount && lastPayload('构思补充'));
    assert.equal(setup.storyRuntime.mode, 'setup');
    assert.equal(setup.apiChannel, 'vertex');
    assert.deepEqual(lastModel().body.tools, [{ googleSearch: {} }]);
    await waitFor(() => see('回复：构思补充'));
    const writingCount = app.chatPayloads.length;
    await browser.evaluate(`document.querySelector('[data-story-runtime-action="start_writing"]').click()`);
    const writing = await waitFor(() => app.chatPayloads.length > writingCount && app.chatPayloads.at(-1).storyRuntime?.action === 'start_writing' ? app.chatPayloads.at(-1) : null);
    assert.equal(writing.storyRuntime.mode, 'writing');
    assert.equal(lastModel().body.tools, undefined);
    await waitFor(() => see('正文开场。'));
    await browser.shot('story-runtime.png');

    await fresh();
    await sendText('请慢慢写');
    await waitFor(() => see('已经写出的半句'));
    await browser.evaluate(`document.querySelector('#sendButton').click()`);
    await waitFor(async () => await see('Stopped') && await browser.evaluate(`document.querySelector('#sendButton').getAttribute('aria-label') === 'Send message'`));
    assert.equal(app.signal().aborted, true);
    const afterStop = await sendText('普通追问');
    const stoppedFollow = await waitFor(() => app.chatPayloads.length > afterStop && lastPayload('普通追问'));
    assert.equal(stoppedFollow.messages.some(message => message.content === '已经写出的半句'), false);
    assert.equal(stoppedFollow.apiChannel, 'vertex');

    await fresh();
    const emptyCount = await sendText('额度耗尽');
    await waitFor(() => see(ERROR_TEXT.OUTPUT_LIMIT));
    assert.equal(await see('只存在于思考'), false);
    assert.equal(await see('安全'), false);
    const nextCount = await sendText('下一问');
    const next = await waitFor(() => app.chatPayloads.length > emptyCount + 1 && lastPayload('下一问'));
    assert.equal(next.messages.some(message => message.role === 'assistant'), false);
    assert.equal(next.apiChannel, 'vertex');
    await waitFor(() => see('回复：下一问'));

    const memoryCount = app.memoryPayloads.length;
    await browser.evaluate(`document.querySelector('[data-update-story-memory]').click()`);
    await waitFor(() => see('Library'));
    const memory = app.memoryPayloads.at(-1);
    assert.ok(app.memoryPayloads.length > memoryCount);
    assert.equal(memory.apiChannel, 'vertex');
    assert.equal(lastModel().url.includes('streamGenerateContent'), false);
    assert.equal(lastModel().body.tools, undefined);

    const png = join('/tmp', `wallpaper-${process.pid}.png`);
    await writeFile(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    await browser.evaluate(`document.querySelector('#settingsButton').click()`);
    await browser.setFile('#wallpaperInput', png);
    await waitFor(() => browser.evaluate(`document.querySelector('#conversation').classList.contains('has-wallpaper')`));
    await browser.evaluate(`window.confirm = () => true; document.querySelector('#exportBackup').click()`);
    await waitFor(() => see('Backup downloaded'));
    const imported = createChat('gemini-3.1-pro-preview');
    imported.title = '导入的备份对话';
    imported.titleInitialized = true;
    const importedUser = createMessage('user', '备份里的问题');
    const importedAssistant = createMessage('assistant', '备份里的回答', imported.model);
    importedAssistant.parentUserId = importedUser.id;
    imported.messages = [importedUser, importedAssistant];
    const backupPath = join('/tmp', `backup-${process.pid}.json`);
    await writeFile(backupPath, JSON.stringify(createBackup({
      chats: [imported], settings: { webSearch: 'off', apiChannel: 'ai-studio', thinkingLevel: 'default' }, activeChatId: imported.id,
    })));
    await browser.setFile('#backupInput', backupPath);
    await waitFor(() => see('导入的备份对话'));
    assert.equal(await browser.evaluate(`document.querySelector('#webSearchSetting').checked`), false);
    await browser.shot('wallpaper-backup.png');
    if (await browser.evaluate(`document.querySelector('#settingsDialog').open`)) {
      await browser.evaluate(`document.querySelector('#settingsDialog').close()`);
    }

    assert.equal(app.leaked.length, 0);
    assert.equal(browser.blocked.some(url => /googleapis|google\.com|aiplatform/i.test(url) && !url.startsWith('http://127.0.0.1')), false);
    assert.equal(JSON.stringify(app.upstreamCalls).includes(SECRET), false);
    assert.equal(JSON.stringify(app.chatPayloads).includes(GEMINI_KEY), false);
  } finally {
    await browser?.close();
    await app.close();
  }
});
