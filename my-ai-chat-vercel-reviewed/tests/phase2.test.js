import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { handleChat, validatePayload, ERROR_TEXT } from '../server/chat.js';
import { MODELS, DEFAULT_MODEL } from '../shared/models.js';
import { createChat, createMessage, contextFor, uniqueId } from '../ui/state.js';
import { renderMarkdown } from '../ui/markdown.js';
import { consumeStream } from '../ui/stream.js';

const user = (content = '你好') => createMessage('user', content);
const payload = () => ({ model: DEFAULT_MODEL, messages: [user()] });
const request = (data = payload(), options = {}) => new Request('https://site.example/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://site.example' },
  body: JSON.stringify(data), ...options,
});
// This is a noncredential sentinel. Every keyed test injects a local transport; no network calls.
const testEnv = { GEMINI_API_KEY: 'unit-test-sentinel-not-a-key' };
const events = async response => (await response.text()).split('\n')
  .map(line => line.trim()).filter(Boolean)
  .map(line => JSON.parse(line.startsWith('data:') ? line.slice(5).trimStart() : line));
test('UUID fallback works without secure-context randomUUID', () => {
  const id = uniqueId({ getRandomValues: bytes => crypto.getRandomValues(bytes) });
  assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('missing key is friendly, has no stack and never invokes transport', async () => {
  const response = await handleChat(request(), {}, () => assert.fail('SDK must not run'));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: 'KEY_MISSING', message: ERROR_TEXT.KEY_MISSING } });
});
test('all configured model IDs are allowed; caller URLs, old IDs and arbitrary models are not', async () => {
  for (const model of MODELS) assert.equal(validatePayload({ ...payload(), model: model.id }).model, model.id);
  for (const model of ['gemini-3-pro-preview','https://evil.example','other',null]) {
    assert.equal((await handleChat(request({ ...payload(), model }), {}, () => assert.fail())).status, 400);
  }
});
test('method, same-origin, JSON and body/context boundaries are enforced', async () => {
  assert.equal((await handleChat(new Request('https://site.example/api/chat'), {})).status, 405);
  assert.equal((await handleChat(request(payload(), { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } }), {})).status, 403);
  assert.equal((await handleChat(request(payload(), { headers: { 'Content-Type': 'text/plain' } }), {})).status, 415);
  assert.equal((await handleChat(request(payload(), { body: '{bad-json' }), {})).status, 400);
  assert.equal((await handleChat(request(payload(), { body: 'x'.repeat(262145) }), {})).status, 413);
  assert.equal((await handleChat(request({ ...payload(), messages: [user('x'.repeat(50001))] }), {})).status, 413);
  assert.equal((await handleChat(request({ ...payload(), messages: Array.from({length:101}, () => user()) }), {})).status, 413);
});
test('stable IDs, multi-turn mapping, stopped/error exclusions and duplicate validation', () => {
  const chat = createChat();
  const u1 = user('我叫小明'), a1 = createMessage('assistant','你好，小明。',DEFAULT_MODEL);
  const failedUser = user('失败的请求'), partial = createMessage('assistant','不完整',DEFAULT_MODEL); partial.status = 'stopped';
  const u2 = user('我刚才告诉你我叫什么？');
  chat.messages.push(u1,a1,failedUser,partial,u2);
  const context = contextFor(chat,u2.id);
  assert.deepEqual(context.map(m => m.content), [u1.content,a1.content,u2.content]);
  assert.deepEqual(validatePayload({ model:DEFAULT_MODEL,messages:context }).contents.map(m => m.role), ['user','model','user']);
  assert.equal(new Set(chat.messages.map(m => m.id)).size,5);
  assert.ok(chat.messages.every(m => m.createdAt && m.id && m.status));
  assert.throws(() => validatePayload({ model:DEFAULT_MODEL,messages:[u1,a1,u1] }), /INVALID_REQUEST/);
  assert.throws(() => validatePayload({ model:DEFAULT_MODEL,messages:[a1] }), /INVALID_REQUEST/);
  assert.throws(() => validatePayload({ model:DEFAULT_MODEL,messages:[u1,a1] }), /INVALID_REQUEST/);
});
test('transport emits first delta before generation finishes, forwards context and never returns key', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const response = await handleChat(request(), testEnv, async function* (key, params, signal) {
    assert.equal(key,testEnv.GEMINI_API_KEY); assert.equal(params.contents[0].parts[0].text,'你好'); assert.ok(signal);
    yield { text:'小' }; await gate; yield { text:'明', candidates:[{finishReason:'STOP'}] };
  });
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"start"/);
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /小/); release();
  let rest = ''; while (true) { const {done,value} = await reader.read(); if(done) break; rest += new TextDecoder().decode(value); }
  assert.match(rest, /明/); assert.match(rest, /"done"/); assert.ok(!rest.includes(testEnv.GEMINI_API_KEY));
});
test('429, model errors, network and server exceptions are sanitized', async () => {
  for (const [error, code] of [[{status:429},'RATE_LIMIT'],[{status:404},'MODEL_UNAVAILABLE'],[{status:403},'KEY_INVALID'],[new TypeError('secret stack'),'NETWORK_ERROR'],[new Error('secret stack'),'SERVER_ERROR']]) {
    const output = await events(await handleChat(request(),testEnv,async () => { throw error; }));
    assert.equal(output.at(-1).code,code); assert.equal(output.at(-1).message,ERROR_TEXT[code]);
    assert.ok(!JSON.stringify(output).includes('secret stack'));
  }
});
test('reader cancellation aborts upstream generation', async () => {
  let signalSeen, started;
  const ready = new Promise(resolve => { started = resolve; });
  const response = await handleChat(request(),testEnv,async function* (_,__,signal) {
    signalSeen = signal; started(); yield {text:'partial'};
    await new Promise((resolve,reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted','AbortError')), {once:true}));
  });
  const reader = response.body.getReader(); await ready; await reader.read(); await reader.read();
  await reader.cancel(); assert.equal(signalSeen.aborted,true);
});
test('request disconnect aborts transport and timeout returns friendly error', async () => {
  for (const disconnect of [true,false]) {
    const controller = new AbortController(); let signalSeen;
    const response = await handleChat(request(payload(),{signal:controller.signal}), testEnv, async function* (_,__,signal) {
      signalSeen = signal;
      await new Promise((resolve,reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted','AbortError')), {once:true}));
    }, 15);
    if(disconnect) controller.abort();
    const output = await events(response); assert.equal(signalSeen.aborted,true);
    if(!disconnect) assert.equal(output.at(-1).code,'TIMEOUT');
  }
});
test('UTF-8 and arbitrary network chunk boundaries preserve streamed Chinese', async () => {
  const bytes = new TextEncoder().encode('{"type":"start"}\n{"type":"delta","text":"你好，小明"}\n{"type":"done"}\n');
  const response = new Response(new ReadableStream({start(c) { for(const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); }}), {headers:{'Content-Type':'application/x-ndjson'}});
  const output=[]; await consumeStream(response,event => output.push(event));
  assert.equal(output[1].text,'你好，小明');
  await assert.rejects(consumeStream(new Response('{"type":"start"}\n',{headers:{'Content-Type':'application/x-ndjson'}}), () => {}), /中断/);
});
test('Markdown supports requested elements and sanitizes scripts, HTML, unsafe links and images', () => {
  const win = new JSDOM('').window;
  const html = renderMarkdown('# Heading\n\n**Bold** *Italic*\n\n- One\n- Two\n\n|A|B|\n|-|-|\n|1|2|\n\n`inline`\n\n```js\nconsole.log("hi");\n```\n\n[Good](https://example.com) [Bad](javascript:alert%281%29)\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n![tracking](https://evil.example/track)',win);
  const doc = new JSDOM(html).window.document;
  for(const selector of ['h1','strong','em','li','table','code','pre','.code-head button','.table-scroll']) assert.ok(doc.querySelector(selector),selector);
  assert.equal(doc.querySelectorAll('script,img,iframe,[onerror]').length,0);
  assert.ok([...doc.querySelectorAll('a')].every(a => !a.getAttribute('href') || a.href.startsWith('https://')));
  assert.equal(doc.querySelector('a').rel,'noopener noreferrer');
});
test('Chinese quoted emphasis next to Chinese prose renders without exposing Markdown markers', () => {
  const win = new JSDOM('').window;
  const html = renderMarkdown('***“狂魔哥”***是一个……\n\n**“关键词”**是一个……\n\n`***“代码”***是`\n\n```md\n**“代码块”**是\n```', win);
  const doc = new JSDOM(html).window.document;
  assert.equal(doc.querySelector('em strong')?.textContent, '“狂魔哥”');
  assert.equal(doc.querySelector('strong:not(em strong)')?.textContent, '“关键词”');
  assert.doesNotMatch(doc.body.textContent, /\*\*\*“狂魔哥”|\*\*“关键词”/);
  assert.equal(doc.querySelector('p code')?.textContent, '***“代码”***是');
  assert.equal(doc.querySelector('pre code')?.textContent, '**“代码块”**是\n');
});
