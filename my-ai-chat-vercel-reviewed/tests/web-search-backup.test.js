import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createBackup, parseBackupText } from '../ui/backup.js';
import { createChat, createMessage } from '../ui/state.js';
import { SEARCH_SUGGESTION_ATTACK, SEARCH_SUGGESTION_SAMPLE } from './search-suggestion-sample.js';

function withWindow(run) {
  const previous = globalThis.window;
  globalThis.window = new JSDOM('<!doctype html><html><body></body></html>').window;
  try { return run(); }
  finally {
    if (previous) globalThis.window = previous;
    else delete globalThis.window;
  }
}

function chatWithSearch() {
  const chat = createChat('gemini-3.1-pro-preview');
  chat.titleInitialized = true;
  const user = createMessage('user', 'Who won?');
  user.parentVariantId = null;
  const assistant = createMessage('assistant', 'Spain won.', 'gemini-3.1-pro-preview');
  assistant.parentUserId = user.id;
  assistant.webSources = [
    { title: 'UEFA', url: 'https://www.uefa.com/euro2024/' },
    { title: 'Insecure', url: 'http://insecure.example/final' },
  ];
  assistant.searchSuggestionHtml = SEARCH_SUGGESTION_SAMPLE;
  chat.messages = [user, assistant];
  return chat;
}

test('backup export and import keep cleaned search sources and suggestions', () => {
  withWindow(() => {
    const chat = chatWithSearch();
    const backup = createBackup({ chats: [chat], settings: {}, activeChatId: chat.id, now: new Date('2026-10-02T00:00:00.000Z') });
    const exported = JSON.parse(JSON.stringify(backup));
    const reply = exported.chats[0].messages[1];
    assert.deepEqual(reply.webSources, [{ title: 'UEFA', url: 'https://www.uefa.com/euro2024/' }]);
    assert.match(reply.searchSuggestionHtml, /local qa/);
    const imported = parseBackupText(JSON.stringify(exported));
    const restored = imported.chats[0].messages[1];
    assert.deepEqual(restored.webSources, reply.webSources);
    assert.match(restored.searchSuggestionHtml, /local qa/);
    assert.match(restored.searchSuggestionHtml, /noopener noreferrer/);
  });
});

test('malicious search fields are cleaned during backup import and old backups still import', () => {
  withWindow(() => {
    const chat = chatWithSearch();
    const backup = createBackup({ chats: [chat], settings: { systemInstruction: 'keep' }, now: new Date('2026-10-02T00:00:00.000Z') });
    const payload = JSON.parse(JSON.stringify(backup));
    const reply = payload.chats[0].messages[1];
    reply.webSources = [
      { title: 'UEFA', url: 'https://www.uefa.com/euro2024/' },
      { title: 'Bad', url: 'http://insecure.example/' },
      { title: 'x'.repeat(300), url: 'https://example.com/long-title' },
    ];
    reply.searchSuggestionHtml = SEARCH_SUGGESTION_ATTACK;
    const imported = parseBackupText(JSON.stringify(payload));
    const restored = imported.chats[0].messages[1];
    assert.deepEqual(restored.webSources.map(source => source.url), [
      'https://www.uefa.com/euro2024/',
      'https://example.com/long-title',
    ]);
    assert.equal(restored.webSources[1].title.length, 180);
    assert.match(restored.searchSuggestionHtml, /local qa/);
    assert.equal(/<script/i.test(restored.searchSuggestionHtml), false);
    assert.equal(/javascript:/i.test(restored.searchSuggestionHtml), false);
    assert.equal(imported.settings.systemInstruction, 'keep');

    delete payload.chats[0].messages[1].webSources;
    delete payload.chats[0].messages[1].searchSuggestionHtml;
    const legacy = parseBackupText(JSON.stringify(payload));
    assert.equal(legacy.chats[0].messages[1].webSources, undefined);
    assert.equal(legacy.chats[0].messages[1].searchSuggestionHtml, undefined);
    assert.equal(legacy.settings.webSearch, 'on');
  });
});
