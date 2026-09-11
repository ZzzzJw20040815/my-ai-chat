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
  removeUserDescendants,
  visibleConversationPath,
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
  assert.equal(restored.messages[0].parentVariantId, null);
  assert.equal(restored.messages[1].parentUserId, restored.messages[0].id);
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

test('visible path and Gemini context follow only the active branch', () => {
  const chat = createChat(FLASH);
  const firstUser = createMessage('user', 'A');
  const assistant = createMessage('assistant', 'B', FLASH);
  assistant.parentUserId = firstUser.id;
  const alternate = createMessage('assistant', 'B2', FLASH);
  addAssistantVariant(assistant, alternate);
  assistant.activeVariantId = assistant.variants[0].id;
  const childB = createMessage('user', 'C');
  childB.parentVariantId = assistant.variants[0].id;
  const replyB = createMessage('assistant', 'D', FLASH);
  replyB.parentUserId = childB.id;
  const childB2 = createMessage('user', 'C2');
  childB2.parentVariantId = alternate.id;
  const replyB2 = createMessage('assistant', 'D2', FLASH);
  replyB2.parentUserId = childB2.id;
  chat.messages.push(firstUser, assistant, childB, replyB, childB2, replyB2);

  assert.deepEqual(visibleConversationPath(chat).map(message => message.content), ['A', 'B', 'C', 'D']);
  assert.deepEqual(contextFor(chat, childB.id).map(message => message.content), ['A', 'B', 'C']);
  assistant.activeVariantId = alternate.id;
  assert.deepEqual(visibleConversationPath(chat).map(message => activeAssistantVariant(message)?.content), ['A', 'B2', 'C2', 'D2']);
  assert.deepEqual(contextFor(chat, childB2.id).map(message => message.content), ['A', 'B2', 'C2']);
  assistant.activeVariantId = assistant.variants[0].id;
  assistant.variants[0].status = 'stopped';
  assert.deepEqual(contextFor(chat, childB.id).map(message => message.content), ['C']);
});

test('editing a historical user removes only its descendant subtree, not sibling branches', () => {
  const chat = createChat(FLASH);
  const firstUser = createMessage('user', 'A1');
  const firstAssistant = createMessage('assistant', 'B1', FLASH);
  firstAssistant.parentUserId = firstUser.id;
  const alternate = createMessage('assistant', 'B1 alternate', FLASH);
  addAssistantVariant(firstAssistant, alternate);
  const secondUser = createMessage('user', 'A2');
  secondUser.parentVariantId = firstAssistant.variants[0].id;
  const secondAssistant = createMessage('assistant', 'B2', FLASH);
  secondAssistant.parentUserId = secondUser.id;
  const siblingUser = createMessage('user', 'A2 sibling');
  siblingUser.parentVariantId = alternate.id;
  const siblingAssistant = createMessage('assistant', 'B2 sibling', FLASH);
  siblingAssistant.parentUserId = siblingUser.id;
  chat.messages.push(firstUser, firstAssistant, secondUser, secondAssistant, siblingUser, siblingAssistant);

  removeUserDescendants(chat, secondUser.id);
  assert.deepEqual(chat.messages.map(message => message.content), ['A1', 'B1', 'A2', 'A2 sibling', 'B2 sibling']);
});
