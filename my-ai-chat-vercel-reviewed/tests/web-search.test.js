import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IDBFactory } from 'fake-indexeddb';
import { handleChat, validatePayload } from '../server/chat.js';
import { addAssistantVariant, contextFor, createChat, createMessage } from '../ui/state.js';
import { loadChats, saveChat } from '../ui/storage.js';
import { publicGrounding, webSearchMarkup } from '../shared/web-search.js';

const MODEL = 'gemini-3.1-pro-preview';
const env = { GEMINI_API_KEY: 'unit-test-sentinel-not-a-key' };
const escapeHtml = value => String(value).replace(/[&<>'"]/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[character]));
const suggestion = '<div class="container"><a href="https://www.google.com/search?q=euro+2024">euro 2024</a></div>';

function request(body) {
  return new Request('https://app.example/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://app.example' },
    body: JSON.stringify(body),
  });
}
async function events(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const output = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line.startsWith('data:')) output.push(JSON.parse(line.slice(5)));
    }
  }
  return output;
}

test('chat requests enable Google Search and ignore caller-supplied tools', () => {
  const params = validatePayload({ model: MODEL, messages: [createMessage('user', 'Who won Euro 2024?')] });
  assert.deepEqual(params.config.tools, [{ googleSearch: {} }]);
  assert.throws(() => validatePayload({
    model: MODEL, messages: [createMessage('user', 'hello')], tools: [{ googleSearch: {} }],
  }), /INVALID_REQUEST/);
});

test('story memory extraction does not enable Google Search', async () => {
  const source = await readFile(new URL('../server/story-memory.js', import.meta.url), 'utf8');
  assert.equal(source.includes('googleSearch'), false);
});

test('grounded chunks become source links and a search suggestion, without unsafe URLs or HTML', async () => {
  const output = await events(await handleChat(request({
    model: MODEL, messages: [createMessage('user', 'Who won Euro 2024?')],
  }), env, async function* () {
    yield { text: 'Spain won. ' };
    yield {
      text: 'The final was in Berlin.',
      candidates: [{
        finishReason: 'STOP',
        groundingMetadata: {
          webSearchQueries: ['Euro 2024 winner'],
          searchEntryPoint: { renderedContent: suggestion },
          groundingChunks: [
            { web: { uri: 'https://www.uefa.com/euro2024/', title: 'UEFA' } },
            { web: { uri: 'http://insecure.example/final', title: 'Insecure' } },
            { web: { uri: 'javascript:alert(1)', title: 'Script' } },
            { web: { uri: 'https://user:secret@www.uefa.com/euro2024/', title: 'Credentials' } },
            { web: { uri: 'https://www.uefa.com/euro2024/#final', title: 'Duplicate' } },
          ],
        },
      }],
    };
  }));
  assert.deepEqual(output.at(-1).webSources, [{ title: 'UEFA', url: 'https://www.uefa.com/euro2024/' }]);
  assert.equal(output.at(-1).searchSuggestionHtml, suggestion);
  assert.equal(JSON.stringify(output).includes('secret'), false);
  assert.equal(JSON.stringify(output).includes('javascript:'), false);

  const blocked = publicGrounding({
    searchEntryPoint: { renderedContent: '<div><script>alert(1)</script></div>' },
    groundingChunks: [{ web: { uri: 'https://example.com/a', title: '<script>alert(1)</script>' } }],
  });
  const markup = webSearchMarkup(blocked, escapeHtml);
  assert.equal(markup.includes('<script'), false);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(markup, /href="https:\/\/example.com\/a"/);
});

test('search metadata stays in chat history and out of the next Gemini prompt', async () => {
  const indexedDB = new IDBFactory();
  const chat = createChat(MODEL);
  const user = createMessage('user', 'Who won?');
  const assistant = createMessage('assistant', 'Spain won.', MODEL);
  assistant.webSources = [
    { title: 'UEFA', url: 'https://www.uefa.com/euro2024/' },
    { title: 'Bad', url: 'http://insecure.example/' },
  ];
  assistant.searchSuggestionHtml = suggestion;
  chat.messages.push(user, assistant);
  addAssistantVariant(assistant, createMessage('assistant', 'Another answer.', MODEL));
  await saveChat(chat, indexedDB);

  const restored = (await loadChats(indexedDB))[0];
  const turn = restored.messages.find(message => message.role === 'assistant');
  assert.deepEqual(turn.variants[0].webSources, [{ title: 'UEFA', url: 'https://www.uefa.com/euro2024/' }]);
  assert.equal(turn.variants[0].searchSuggestionHtml, suggestion);
  assert.equal(turn.variants[1].webSources, undefined);
  turn.activeVariantId = turn.variants[0].id;
  const followUp = createMessage('user', 'Where was the final?');
  followUp.parentVariantId = turn.variants[0].id;
  restored.messages.push(followUp);
  const context = contextFor(restored, followUp.id);
  assert.equal(JSON.stringify(context).includes('uefa.com'), false);
  assert.equal(JSON.stringify(context).includes('google.com'), false);
  assert.deepEqual(context.map(message => message.content), ['Who won?', 'Spain won.', 'Where was the final?']);
});
