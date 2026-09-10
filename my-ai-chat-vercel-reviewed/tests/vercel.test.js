// Exercise the Vercel Function and official SDK with intercepted fetch.
// The sentinel is not a real credential and no request can leave this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import api from '../api/chat.js';

const makeRequest = (settings) => new Request('https://app.example/api/chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://app.example' },
  body: JSON.stringify({ model: 'gemini-3.1-pro-preview', messages: [
    { id:'u1', role:'user', content:'我叫小明', status:'complete' },
    { id:'a1', role:'assistant', content:'你好，小明', status:'complete' },
    { id:'u2', role:'user', content:'我叫什么？', status:'complete' },
  ], ...(settings ? { settings } : {}) }),
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
  const response = await api.fetch(makeRequest({
    systemInstruction: 'Answer in Chinese.', maxOutputTokens: 2048, thinkingLevel: 'high',
    samplingOverrides: { enabled: true, temperature: 0.7, topP: 0.8, topK: 40 },
    safetySettings: {
      mode: 'custom', harassment: 'OFF', hateSpeech: 'BLOCK_NONE',
      sexuallyExplicit: 'BLOCK_ONLY_HIGH', dangerousContent: 'BLOCK_LOW_AND_ABOVE',
    },
  }));
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value),/start/);
  assert.match(new TextDecoder().decode((await reader.read()).value),/小/);
  assert.match(captured.url,/^https:\/\/generativelanguage.googleapis.com\/v1beta\/models\/gemini-3\.1-pro-preview:streamGenerateContent/);
  assert.ok(!captured.url.includes('unit-test-sentinel'));
  const body=await captured.json(); assert.deepEqual(body.contents.map(m=>m.role),['user','model','user']);
  assert.equal(body.systemInstruction.parts[0].text, 'Answer in Chinese.');
  assert.equal(body.generationConfig.maxOutputTokens, 2048);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
  assert.equal(body.generationConfig.temperature, 0.7);
  assert.equal(body.generationConfig.topP, 0.8);
  assert.ok(!('topK' in body.generationConfig));
  assert.deepEqual(body.safetySettings, [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_LOW_AND_ABOVE' },
  ]);
  upstream.enqueue(sse('明',true)); upstream.close();
  let output=''; while(true){const {done,value}=await reader.read();if(done)break;output+=new TextDecoder().decode(value);}
  assert.match(output,/明/); assert.match(output,/done/); assert.ok(!output.includes('unit-test-sentinel'));
});

test('Vercel Function leaves Gemini generation defaults untouched when settings use Default', async t => {
  withTestKey(t);
  let captured;
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    captured = new Request(input, init);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(sse('ok', true)); controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const response = await api.fetch(makeRequest({
    systemInstruction: '', maxOutputTokens: null, thinkingLevel: 'default',
    samplingOverrides: { enabled: false, temperature: 1, topP: 0.95, topK: 40 },
    safetySettings: {
      mode: 'default', harassment: 'BLOCK_MEDIUM_AND_ABOVE', hateSpeech: 'BLOCK_MEDIUM_AND_ABOVE',
      sexuallyExplicit: 'BLOCK_MEDIUM_AND_ABOVE', dangerousContent: 'BLOCK_MEDIUM_AND_ABOVE',
    },
  }));
  await response.text();
  const body = await captured.json();
  assert.ok(!body.systemInstruction);
  assert.ok(!body.generationConfig?.maxOutputTokens);
  assert.ok(!body.generationConfig?.thinkingConfig);
  assert.ok(!body.generationConfig?.temperature);
  assert.ok(!body.generationConfig?.topP);
  assert.ok(!body.generationConfig?.topK);
  assert.ok(!body.safetySettings);
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
