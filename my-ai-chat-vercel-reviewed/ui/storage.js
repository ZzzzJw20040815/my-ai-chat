import { DEFAULT_MODEL, isAllowedModel } from '../shared/models.js';

export const CHAT_DB_NAME = 'my-ai-chat';
export const CHAT_DB_VERSION = 1;
export const CHAT_STORE_NAME = 'chats';

let sharedDatabase;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error || new Error('IndexedDB request failed')), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', resolve, { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error || new Error('IndexedDB transaction aborted')), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error || new Error('IndexedDB transaction failed')), { once: true });
  });
}

export function openChatDatabase(indexedDBApi = globalThis.indexedDB) {
  if (!indexedDBApi) return Promise.reject(new Error('IndexedDB is unavailable'));
  if (indexedDBApi === globalThis.indexedDB && sharedDatabase) return sharedDatabase;
  const opening = new Promise((resolve, reject) => {
    const request = indexedDBApi.open(CHAT_DB_NAME, CHAT_DB_VERSION);
    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHAT_STORE_NAME)) {
        const store = database.createObjectStore(CHAT_STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
        store.createIndex('demo', 'demo');
      }
    });
    request.addEventListener('success', () => {
      const database = request.result;
      database.addEventListener('versionchange', () => database.close());
      resolve(database);
    }, { once: true });
    request.addEventListener('error', () => reject(request.error || new Error('Could not open IndexedDB')), { once: true });
    request.addEventListener('blocked', () => reject(new Error('IndexedDB upgrade is blocked')), { once: true });
  });
  if (indexedDBApi === globalThis.indexedDB) sharedDatabase = opening.catch(error => {
    sharedDatabase = undefined;
    throw error;
  });
  return opening;
}

function normalizeMessage(message) {
  return {
    id: String(message.id),
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: typeof message.content === 'string' ? message.content : '',
    createdAt: message.createdAt || new Date().toISOString(),
    status: typeof message.status === 'string' ? message.status : 'complete',
    model: message.role === 'assistant' && isAllowedModel(message.model) ? message.model : null,
    feedback: ['like', 'dislike'].includes(message.feedback) ? message.feedback : null,
    ...(message.updatedAt ? { updatedAt: message.updatedAt } : {}),
    ...(typeof message.error === 'string' ? { error: message.error } : {}),
    ...(typeof message.notice === 'string' ? { notice: message.notice } : {}),
  };
}

export function storedChat(chat) {
  return {
    id: String(chat.id),
    title: typeof chat.title === 'string' && chat.title ? chat.title : 'New conversation',
    createdAt: chat.createdAt || new Date().toISOString(),
    updatedAt: chat.updatedAt || chat.createdAt || new Date().toISOString(),
    model: isAllowedModel(chat.model) ? chat.model : DEFAULT_MODEL,
    folderId: chat.folderId == null ? null : String(chat.folderId),
    messages: Array.isArray(chat.messages) ? chat.messages.map(normalizeMessage) : [],
    group: chat.group === 'Yesterday' ? 'Yesterday' : 'Today',
    demo: chat.demo === true,
  };
}

export async function loadChats(indexedDBApi = globalThis.indexedDB) {
  const database = await openChatDatabase(indexedDBApi);
  const transaction = database.transaction(CHAT_STORE_NAME, 'readonly');
  const records = await requestResult(transaction.objectStore(CHAT_STORE_NAME).getAll());
  await transactionDone(transaction);
  return records.map(record => ({ ...storedChat(record), draft: '', scrollTop: 0 }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function saveChat(chat, indexedDBApi = globalThis.indexedDB) {
  const database = await openChatDatabase(indexedDBApi);
  const transaction = database.transaction(CHAT_STORE_NAME, 'readwrite');
  transaction.objectStore(CHAT_STORE_NAME).put(storedChat(chat));
  await transactionDone(transaction);
}

export async function saveChats(chatList, indexedDBApi = globalThis.indexedDB) {
  const database = await openChatDatabase(indexedDBApi);
  const transaction = database.transaction(CHAT_STORE_NAME, 'readwrite');
  const store = transaction.objectStore(CHAT_STORE_NAME);
  for (const chat of chatList) store.put(storedChat(chat));
  await transactionDone(transaction);
}

export async function loadOrSeedChats(createSeedChats, indexedDBApi = globalThis.indexedDB) {
  const existing = await loadChats(indexedDBApi);
  if (existing.length) return existing;
  const seeds = createSeedChats();
  await saveChats(seeds, indexedDBApi);
  return loadChats(indexedDBApi);
}

export async function deleteChat(chatId, indexedDBApi = globalThis.indexedDB) {
  const database = await openChatDatabase(indexedDBApi);
  const transaction = database.transaction(CHAT_STORE_NAME, 'readwrite');
  transaction.objectStore(CHAT_STORE_NAME).delete(chatId);
  await transactionDone(transaction);
}

export async function closeChatDatabase() {
  if (!sharedDatabase) return;
  const database = await sharedDatabase;
  database.close();
  sharedDatabase = undefined;
}
