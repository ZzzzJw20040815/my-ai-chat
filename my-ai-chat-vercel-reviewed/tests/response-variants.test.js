import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  activeAssistantVariant,
  addAssistantVariant,
  createChat,
  createMessage,
  contextFor,
  formatLocalChatTitle,
} from '../ui/state.js';
import { loadChats, saveChat } from '../ui/storage.js';

const FLASH = 'gemini-3.7-flash';

test('local timestamp title is deterministic for the original user createdAt', () => {
  const createdAt = new Date(2026, 8, 10, 8, 40, 37).toISOString();
  assert.equal(formatLocalChatTitle(createdAt), '2026-09-10 08:40');
  assert.equal(formatLocalChatTitle('not-a-date'), 'New conversation');
});

test('legacy assistant remains a single response and variants persist with active selection', async () => {
  const indexedDB = new IDBFactory();
  const chat = createChat(FLASH);
  chat.title = 'Existing title stays unchanged';
  delete chat.titleInitialized;
  const user = createMessage('user', 'A');
  const assistant = createMessage('assistant', 'B', FLASH);
  chat.messages.push(user, assistant);
  await saveChat(chat, indexedDB);

  let restored = (await loadChats(indexedDB))[0];
  assert.equal(restored.title, 'Existing title stays unchanged');
  assert.equal(restored.titleInitialized, true);
  assert.equal(restored.messages[1].variants, undefined);
  assert.equal(activeAssistantVariant(restored.messages[1]).content, 'B');

  const second = createMessage('assistant', 'C', FLASH);
  second.status = 'stopped';
  addAssistantVariant(restored.messages[1], second);
  const third = createMessage('assistant', 'D', FLASH);
  third.status = 'error';
  third.error = 'Network interrupted';
  addAssistantVariant(restored.messages[1], third);
  restored.messages[1].activeVariantId = second.id;
  await saveChat(restored, indexedDB);

  restored = (await loadChats(indexedDB))[0];
  assert.equal(restored.messages[1].variants.length, 3);
  assert.equal(restored.messages[1].activeVariantId, second.id);
  assert.equal(activeAssistantVariant(restored.messages[1]).status, 'stopped');
  assert.equal(restored.messages[1].variants[2].error, 'Network interrupted');
});

test('Gemini context includes only the active complete variant', () => {
  const chat = createChat(FLASH);
  const firstUser = createMessage('user', 'A');
  const assistant = createMessage('assistant', 'B', FLASH);
  const active = createMessage('assistant', 'C', FLASH);
  addAssistantVariant(assistant, active);
  const nextUser = createMessage('user', 'D');
  chat.messages.push(firstUser, assistant, nextUser);

  assert.deepEqual(contextFor(chat, nextUser.id).map(message => message.content), ['A', 'C', 'D']);
  assistant.activeVariantId = assistant.variants[0].id;
  assert.deepEqual(contextFor(chat, nextUser.id).map(message => message.content), ['A', 'B', 'D']);
  assistant.variants[0].status = 'stopped';
  assert.deepEqual(contextFor(chat, nextUser.id).map(message => message.content), ['D']);
});

test('editing a historical user turn truncates the entire later assistant turn with variants', () => {
  const chat = createChat(FLASH);
  const firstUser = createMessage('user', 'A1');
  const firstAssistant = createMessage('assistant', 'B1', FLASH);
  addAssistantVariant(firstAssistant, createMessage('assistant', 'B1 alternate', FLASH));
  const secondUser = createMessage('user', 'A2');
  const secondAssistant = createMessage('assistant', 'B2', FLASH);
  addAssistantVariant(secondAssistant, createMessage('assistant', 'B2 alternate', FLASH));
  chat.messages.push(firstUser, firstAssistant, secondUser, secondAssistant);

  const editIndex = chat.messages.findIndex(message => message.id === firstUser.id);
  chat.messages.splice(editIndex + 1);
  assert.deepEqual(chat.messages.map(message => message.content), ['A1']);
});
