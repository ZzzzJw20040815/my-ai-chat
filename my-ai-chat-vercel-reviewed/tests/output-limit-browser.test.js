import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import api from '../api/chat.js';
import { ERROR_TEXT, MAX_VISIBLE_OUTPUT_CHARS } from '../server/chat.js';

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const ROOT = new URL('../dist/client/', import.meta.url);
const encoder = new TextEncoder();
const sse = payload => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
const textEvent = (text, finishReason) => sse({
  candidates: [{
    content: { role: 'model', parts: text ? [{ text }] : [] },
    ...(finishReason ? { finishReason } : {}),
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
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (!signal?.aborted) controller.close();
      } catch (error) {
        try { controller.error(error); } catch { /* already closed */ }
      }
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  if (text.includes('Begin the formal story')) return stream([textEvent('正文开场。', 'STOP')]);
  if (text.includes('exact ending') || text.includes('Continue directly')) return stream([textEvent('续写完成。', 'STOP')]);
  if (text.includes('你的输出未完整') || text.trim() === '继续') return stream([textEvent('续写完成。', 'STOP')]);
  if (text.includes('超长输出')) return stream([
    textEvent('A'.repeat(MAX_VISIBLE_OUTPUT_CHARS - 40000)),
    textEvent('B'.repeat(60000), 'STOP'),
  ]);
  if (text.includes('额度耗尽')) return stream([sse({
    candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model', parts: [{ text: '只存在于思考', thought: true }] } }],
  })]);
  if (text.includes('下一问')) return stream([textEvent('这是下一问。', 'STOP')]);
  if (text.includes('构思补充')) return stream([textEvent('补充完成。', 'STOP')]);
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
  throw new Error(`Unexpected upstream prompt: ${text.slice(0, 140)}`);
}

function contentType(path) {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (path.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}

async function startApp() {
  const payloads = [];
  let upstreamSignal = null;
  let port = 0;
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'unit-test-sentinel-not-a-key';
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    if (!url.includes('generativelanguage.googleapis.com')) return previousFetch(input, init);
    assert.equal(url.includes('unit-test-sentinel'), false);
    const body = JSON.parse(init.body);
    upstreamSignal = init.signal;
    return upstream(body, init.signal);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/models') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unavailable' } }));
        return;
      }
      if (url.pathname === '/api/chat') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        payloads.push(JSON.parse(body.toString('utf8')));
        const abort = new AbortController();
        res.on('close', () => { if (!res.writableEnded) abort.abort(); });
        const response = await api.fetch(new Request(`http://127.0.0.1:${port}${url.pathname}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: req.headers.origin || `http://127.0.0.1:${port}` },
          body,
          signal: abort.signal,
        }));
        res.writeHead(response.status, Object.fromEntries(response.headers));
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
    payloads,
    origin: `http://127.0.0.1:${port}`,
    signal: () => upstreamSignal,
    async close() {
      server.close();
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previousKey;
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
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
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
  const profile = `/tmp/chrome-output-limit-${process.pid}-${Date.now()}`;
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
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
  const version = await (await fetch(browserUrl.replace(/^ws/, 'http').replace(/\/devtools\/browser\/.*$/, '/json/version'))).json();
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
  return {
    async goto(url) { await send('Page.navigate', { url }); await new Promise(resolve => setTimeout(resolve, 400)); },
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
      return result.result?.value;
    },
    async close() { chrome.kill(); browser.ws.close(); },
  };
}

async function waitFor(check, timeout = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Chrome');
}

test('Chrome keeps capped output and does not present thought-only exhaustion as a safety block', { timeout: 180000 }, async () => {
  const { acquireChromeLock, releaseChromeLock } = await import('./chrome-lock.js');
  await acquireChromeLock();
  let app;
  let browser;
  try {
    await stat(new URL('../dist/client/index.html', import.meta.url));
    app = await startApp();
    browser = await launchChrome();
    await browser.goto(`${app.origin}/`);
    await browser.evaluate(`new Promise(resolve => {
      const timer = setInterval(() => {
        if (document.querySelector('#newChatButton')) { clearInterval(timer); resolve(true); }
      }, 20);
    })`);
    const fresh = async () => {
      await browser.evaluate(`document.querySelector('#newChatButton').click()`);
      await waitFor(() => browser.evaluate(`document.querySelector('#conversation h1')?.textContent === 'What would you like to explore?'`));
    };
    const sendText = async text => {
      await browser.evaluate(`(() => {
        const input = document.querySelector('#messageInput');
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#composerForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      })()`);
    };
    const see = text => browser.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
    const contents = payload => payload.messages.map(message => message.content);
    await fresh();
    const beforeLong = app.payloads.length;
    await sendText('超长输出');
    await waitFor(() => see(ERROR_TEXT.TRUNCATED));
    const shown = await browser.evaluate(`(() => {
      const text = (document.querySelector('.message.assistant .message-content')?.textContent || '').trim();
      return { length: text.length, startsWithA: text.startsWith('A'.repeat(60)), includesB: text.includes('B') };
    })()`);
    assert.equal(shown.length, MAX_VISIBLE_OUTPUT_CHARS);
    assert.equal(shown.startsWithA, true);
    assert.equal(shown.includesB, true);
    assert.equal(await see('新建聊天'), false);
    assert.equal(await see('安全'), false);
    assert.equal(await browser.evaluate(`Boolean(document.querySelector('[data-action="continue-incomplete"]'))`), true);
    await sendText('你的输出未完整 请继续输出');
    const continued = await waitFor(() => {
      const payload = app.payloads.at(-1);
      return app.payloads.length > beforeLong + 1 && contents(payload).at(-1) === '你的输出未完整 请继续输出' ? payload : null;
    });
    assert.equal(contents(continued)[1].length, MAX_VISIBLE_OUTPUT_CHARS);
    assert.equal(contents(continued)[1].startsWith('A'), true);
    assert.match(continued.settings.systemInstruction, /exact ending/);
    assert.equal(JSON.stringify(continued.messages).includes(ERROR_TEXT.TRUNCATED), false);
    await waitFor(() => see('续写完成。'));

    await browser.evaluate(`document.querySelector('[data-story-runtime-action="prepare_story"]').click()`);
    await waitFor(() => see('构思中'));
    const setupCount = app.payloads.length;
    await sendText('构思补充');
    const setup = await waitFor(() => app.payloads.length > setupCount && contents(app.payloads.at(-1)).at(-1) === '构思补充' ? app.payloads.at(-1) : null);
    assert.equal(setup.storyRuntime.mode, 'setup');
    assert.equal(contents(setup).some(text => text.length === MAX_VISIBLE_OUTPUT_CHARS), true);
    await waitFor(() => see('补充完成。'));
    const writingCount = app.payloads.length;
    await browser.evaluate(`document.querySelector('[data-story-runtime-action="start_writing"]').click()`);
    const writing = await waitFor(() => app.payloads.length > writingCount && app.payloads.at(-1).storyRuntime?.action === 'start_writing' ? app.payloads.at(-1) : null);
    assert.equal(writing.storyRuntime.mode, 'writing');
    assert.equal(contents(writing).some(text => text.length === MAX_VISIBLE_OUTPUT_CHARS), true);
    await waitFor(() => see('正文开场。'));

    await fresh();
    const emptyCount = app.payloads.length;
    await sendText('额度耗尽');
    await waitFor(() => see(ERROR_TEXT.OUTPUT_LIMIT));
    assert.equal(await see('安全'), false);
    assert.equal(await see('只存在于思考'), false);
    assert.equal(await browser.evaluate(`Boolean(document.querySelector('[data-action="continue-incomplete"]'))`), false);
    await sendText('下一问');
    const next = await waitFor(() => app.payloads.length > emptyCount + 1 && contents(app.payloads.at(-1)).at(-1) === '下一问' ? app.payloads.at(-1) : null);
    assert.deepEqual(contents(next), ['下一问']);
    assert.equal(next.messages.some(message => message.role === 'assistant'), false);
    await waitFor(() => see('这是下一问。'));

    await fresh();
    await sendText('请慢慢写');
    await waitFor(() => see('已经写出的半句'));
    await browser.evaluate(`document.querySelector('#sendButton').click()`);
    await waitFor(async () => await see('Stopped · partial response excluded from context')
      && await browser.evaluate(`document.querySelector('#sendButton').getAttribute('aria-label') === 'Send message'`));
    assert.equal(app.signal().aborted, true);
  } finally {
    await browser?.close();
    await app?.close();
    const { releaseChromeLock } = await import('./chrome-lock.js');
    await releaseChromeLock();
  }
});
