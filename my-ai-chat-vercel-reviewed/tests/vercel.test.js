// Exercise the Vercel Function and official SDK with intercepted fetch.
// The sentinel is not a real credential and no request can leave this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import api from '../api/chat.js';

const makeRequest = () => new Request('https://app.example/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.example' },
  body: JSON.stringify({ model: 'gemini-3.1-pro-preview', messages: [
    { id:'u1', role:'user', content:'我叫小明', status:'complete' },
    { id:'a1', role:'assistant', content:'你好，小明', status:'complete' },
    { id:'u2', role:'user', content:'我叫什么？', status:'complete' },
  ] }),
});
const encoder = new TextEncoder();
const sse = (text, done=false) => encoder.encode('data: ' + JSON.stringify({ candidates:[{
  content:{role:'model',parts:[{text}]}, ...(done ? {finishReason:'STOP'} : {}),
}] }) + '\n\n');
const withTestKey = t => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'unit-test-sentinel';
  t.after(() => previous === undefined ? delete process.env.GEMINI_API_KEY : process.env.GEMINI_API_KEY = previous);
};

test('Vercel Function and official SDK stream SSE and forward all context', async t => {
  withTestKey(t);
  let upstream, captured;
  t.mock.method(globalThis,'fetch',async (input,init) => {
    captured = new Request(input,init);
    return new Response(new ReadableStream({start(c){upstream=c; c.enqueue(sse('小'));}}),{headers:{'Content-Type':'text/event-stream'}});
  });
  const response = await api.fetch(makeRequest());
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value),/start/);
  assert.match(new TextDecoder().decode((await reader.read()).value),/小/);
  assert.match(captured.url,/^https:\/\/generativelanguage.googleapis.com\/v1beta\/models\/gemini-3\.1-pro-preview:streamGenerateContent/);
  assert.ok(!captured.url.includes('unit-test-sentinel'));
  const body=await captured.json(); assert.deepEqual(body.contents.map(m=>m.role),['user','model','user']);
  upstream.enqueue(sse('明',true)); upstream.close();
  let output=''; while(true){const {done,value}=await reader.read();if(done)break;output+=new TextDecoder().decode(value);}
  assert.match(output,/明/); assert.match(output,/done/); assert.ok(!output.includes('unit-test-sentinel'));
});

test('Vercel Function Stop propagates to Gemini upstream fetch AbortSignal', async t => {
  withTestKey(t);
  let signal;
  t.mock.method(globalThis,'fetch',async (input,init) => {
    signal = init?.signal || input.signal;
    return new Response(new ReadableStream({start(c){
      c.enqueue(sse('partial'));
      signal.addEventListener('abort',()=>c.error(new DOMException('Aborted','AbortError')),{once:true});
    }}),{headers:{'Content-Type':'text/event-stream'}});
  });
  const response=await api.fetch(makeRequest());
  const reader=response.body.getReader(); await reader.read(); await reader.read(); await reader.cancel();
  assert.equal(signal.aborted,true);
});

test('Vite output is static, keyless and separate from the server function', async t => {
  const previous = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => previous === undefined ? delete process.env.GEMINI_API_KEY : process.env.GEMINI_API_KEY = previous);
  const html=await readFile('dist/client/index.html','utf8');
  const assets=await readdir('dist/client/assets');
  const scripts=assets.filter(name=>name.endsWith('.js'));
  assert.ok(scripts.length);
  const js=(await Promise.all(scripts.map(name=>readFile('dist/client/assets/'+name,'utf8')))).join('\n');
  assert.ok(!html.includes('GEMINI_API_KEY'));
  assert.ok(!js.includes('GEMINI_API_KEY'));
  assert.ok(!js.includes('generateContentStream'));
  const response=await api.fetch(makeRequest()); assert.equal(response.status,503);
  assert.equal((await response.json()).error.code,'KEY_MISSING');
});
