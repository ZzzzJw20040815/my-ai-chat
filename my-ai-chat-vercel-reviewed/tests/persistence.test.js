import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createChat, createMessage, contextFor } from '../ui/state.js';
import {
  CHAT_DB_NAME,
  CHAT_DB_VERSION,
  CHAT_STORE_NAME,
  loadChats,
  loadOrSeedChats,
  openChatDatabase,
  saveChat,
} from '../ui/storage.js';

const FLASH = 'gemini-3.7-flash';
const PRO = 'gemini-3.1-pro-preview';

test('IndexedDB v1 creates the chats store and initializes demo records once', async () => {
  const indexedDB = new IDBFactory();
  let seedCalls = 0;
  const createSeeds = () => {
    seedCalls++;
    const demo = createChat(FLASH);
    demo.id = 'demo-stable';
    demo.title = 'Demo';
    demo.demo = true;
    return [demo];
  };

  const firstOpen = await loadOrSeedChats(createSeeds, indexedDB);
  const secondOpen = await loadOrSeedChats(createSeeds, indexedDB);
  const database = await openChatDatabase(indexedDB);

  assert.equal(database.name, CHAT_DB_NAME);
  assert.equal(database.version, CHAT_DB_VERSION);
  assert.ok(database.objectStoreNames.contains(CHAT_STORE_NAME));
  assert.equal(seedCalls, 1);
  assert.equal(firstOpen.length, 1);
  assert.equal(secondOpen.length, 1);
  assert.equal(secondOpen[0].id, 'demo-stable');
});

test('chat, message, model and edits survive a database reopen', async () => {
  const indexedDB = new IDBFactory();
  const chat = createChat(FLASH);
  chat.title = 'Remember 7263';
  chat.folderId = 'projects';
  const firstUser = createMessage('user', '请记住测试代码 7263。');
  const firstAssistant = createMessage('assistant', '好的，我会记住。', FLASH);
  const secondUser = createMessage('user', '代码是什么？');
  const secondAssistant = createMessage('assistant', '7263', PRO);
  chat.messages.push(firstUser, firstAssistant, secondUser, secondAssistant);
  chat.model = PRO;
  await saveChat(chat, indexedDB);

  let restored = (await loadChats(indexedDB))[0];
  assert.equal(restored.id, chat.id);
  assert.equal(restored.title, chat.title);
  assert.equal(restored.folderId, 'projects');
  assert.equal(restored.model, PRO);
  assert.deepEqual(restored.messages.map(message => message.id), chat.messages.map(message => message.id));
  assert.deepEqual(restored.messages.map(message => message.model), [null, FLASH, null, PRO]);

  restored.messages[0].content = '请记住测试代码 9918。';
  restored.messages[0].updatedAt = new Date().toISOString();
  restored.messages.splice(1);
  await saveChat(restored, indexedDB);
  restored = (await loadChats(indexedDB))[0];
  assert.equal(restored.messages.length, 1);
  assert.equal(restored.messages[0].content, '请记住测试代码 9918。');
  assert.ok(restored.messages[0].updatedAt);
});

test('stopped and network-error partial replies persist but stay out of later Gemini context', async () => {
  const indexedDB = new IDBFactory();
  const chat = createChat(FLASH);
  const stoppedUser = createMessage('user', '写一个长回答');
  const stoppedReply = createMessage('assistant', '已经生成的部分', FLASH);
  stoppedReply.status = 'stopped';
  const errorUser = createMessage('user', '再试一次');
  const errorReply = createMessage('assistant', '网络中断前的部分', FLASH);
  errorReply.status = 'error';
  errorReply.error = '网络连接失败，请检查网络后重试。';
  const retryUser = createMessage('user', '继续');
  chat.messages.push(stoppedUser, stoppedReply, errorUser, errorReply, retryUser);
  await saveChat(chat, indexedDB);

  const restored = (await loadChats(indexedDB))[0];
  assert.equal(restored.messages[1].status, 'stopped');
  assert.equal(restored.messages[1].content, '已经生成的部分');
  assert.equal(restored.messages[3].status, 'error');
  assert.equal(restored.messages[3].content, '网络中断前的部分');
  assert.deepEqual(contextFor(restored, retryUser.id).map(message => message.content), ['继续']);

  const regenerated = createMessage('assistant', '重试后的完整回答', PRO);
  restored.messages.splice(3, 1, regenerated);
  restored.model = PRO;
  await saveChat(restored, indexedDB);
  const afterRetry = (await loadChats(indexedDB))[0];
  assert.equal(afterRetry.messages[3].content, '重试后的完整回答');
  assert.equal(afterRetry.messages[3].status, 'complete');
  assert.equal(afterRetry.messages[3].model, PRO);
});
