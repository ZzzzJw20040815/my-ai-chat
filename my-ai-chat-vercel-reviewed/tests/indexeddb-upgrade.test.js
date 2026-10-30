import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import {
  ASSET_STORE_NAME, CHAT_DB_NAME, CHAT_DB_VERSION, CHAT_STORE_NAME,
  STORY_MEMORY_STORE_NAME, STYLE_REFERENCE_STORE_NAME, loadChats, loadStoryMemories,
  loadWallpaperAsset, openChatDatabase,
} from '../ui/storage.js';

function openAt(indexedDB, version, upgrade) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CHAT_DB_NAME, version);
    request.onupgradeneeded = () => upgrade(request.result);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function put(database, storeName, record) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite');
    transaction.objectStore(storeName).put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

function indexNames(database, storeName) {
  const store = database.transaction(storeName).objectStore(storeName);
  return [...store.indexNames].sort();
}

test('IndexedDB upgrades from empty, v1, v2, and v3 keep data and finish at v4', async () => {
  const fresh = new IDBFactory();
  const freshDatabase = await openChatDatabase(fresh);
  assert.equal(freshDatabase.version, CHAT_DB_VERSION);
  assert.deepEqual(indexNames(freshDatabase, CHAT_STORE_NAME), ['demo', 'updatedAt']);
  assert.equal(freshDatabase.objectStoreNames.contains(ASSET_STORE_NAME), true);
  assert.deepEqual(indexNames(freshDatabase, STORY_MEMORY_STORE_NAME), ['anchorId', 'chatId', 'updatedAt']);
  assert.deepEqual(indexNames(freshDatabase, STYLE_REFERENCE_STORE_NAME), ['createdAt', 'sourceVariantId']);

  const fromV1 = new IDBFactory();
  const version1 = await openAt(fromV1, 1, database => {
    const store = database.createObjectStore(CHAT_STORE_NAME, { keyPath: 'id' });
    store.createIndex('updatedAt', 'updatedAt');
    store.createIndex('demo', 'demo');
  });
  await put(version1, CHAT_STORE_NAME, {
    id: 'v1-chat', title: 'From v1', model: 'gemini-3.1-pro-preview', messages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  version1.close();
  const upgradedV1 = await openChatDatabase(fromV1);
  assert.equal(upgradedV1.version, 4);
  assert.deepEqual(indexNames(upgradedV1, STORY_MEMORY_STORE_NAME), ['anchorId', 'chatId', 'updatedAt']);
  assert.deepEqual(indexNames(upgradedV1, STYLE_REFERENCE_STORE_NAME), ['createdAt', 'sourceVariantId']);
  assert.equal((await loadChats(fromV1))[0].title, 'From v1');

  const fromV2 = new IDBFactory();
  const version2 = await openAt(fromV2, 2, database => {
    database.createObjectStore(CHAT_STORE_NAME, { keyPath: 'id' });
    database.createObjectStore(ASSET_STORE_NAME, { keyPath: 'id' });
  });
  await put(version2, CHAT_STORE_NAME, {
    id: 'v2-chat', title: 'From v2', model: 'gemini-3.1-pro-preview', messages: [],
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  await put(version2, ASSET_STORE_NAME, { id: 'chat-wallpaper', blob: new Blob(['png']), name: 'v2.png' });
  version2.close();
  const upgradedV2 = await openChatDatabase(fromV2);
  assert.equal(upgradedV2.objectStoreNames.contains(STORY_MEMORY_STORE_NAME), true);
  assert.equal((await loadChats(fromV2))[0].id, 'v2-chat');
  assert.equal((await loadWallpaperAsset(fromV2)).name, 'v2.png');

  const fromV3 = new IDBFactory();
  const version3 = await openAt(fromV3, 3, database => {
    database.createObjectStore(CHAT_STORE_NAME, { keyPath: 'id' });
    database.createObjectStore(ASSET_STORE_NAME, { keyPath: 'id' });
    const memories = database.createObjectStore(STORY_MEMORY_STORE_NAME, { keyPath: 'id' });
    memories.createIndex('chatId', 'chatId');
    memories.createIndex('anchorId', 'anchorId');
    memories.createIndex('updatedAt', 'updatedAt');
  });
  await put(version3, CHAT_STORE_NAME, {
    id: 'v3-chat', title: 'From v3', model: 'gemini-3.1-pro-preview', messages: [],
    createdAt: '2026-01-03T00:00:00.000Z',
  });
  await put(version3, STORY_MEMORY_STORE_NAME, {
    id: 'memory-v3', chatId: 'v3-chat', anchorId: 'anchor', schemaVersion: 1,
    createdAt: '2026-01-03T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z',
    memory: {
      version: 1,
      scene: { location: '旧地点', time: null, presentCharacters: [], relativePositions: [], environmentState: [], importantObjects: [] },
      characters: [],
      relationship: { summary: '', establishedChanges: [], sharedHistory: [], unresolvedTension: [] },
      importantEvents: [], knownFacts: [], unknownOrUnconfirmed: [], unresolvedThreads: [],
    },
  });
  version3.close();
  const upgradedV3 = await openChatDatabase(fromV3);
  assert.deepEqual(indexNames(upgradedV3, STYLE_REFERENCE_STORE_NAME), ['createdAt', 'sourceVariantId']);
  assert.equal((await loadChats(fromV3))[0].id, 'v3-chat');
  assert.equal((await loadStoryMemories('v3-chat', fromV3))[0].id, 'memory-v3');
});
