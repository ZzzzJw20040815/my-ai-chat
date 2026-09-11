import { DEFAULT_MODEL, isAllowedModel } from '../shared/models.js';
import { ensureBranchLineage } from './state.js';

export const CHAT_DB_NAME = 'my-ai-chat';
export const CHAT_DB_VERSION = 2;
export const CHAT_STORE_NAME = 'chats';
export const ASSET_STORE_NAME = 'assets';
export const WALLPAPER_ASSET_ID = 'chat-wallpaper';
export const CANONICAL_DEMO_ID = 'demo-welcome';

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
      if (!database.objectStoreNames.contains(ASSET_STORE_NAME)) {
        database.createObjectStore(ASSET_STORE_NAME, { keyPath: 'id' });
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

function normalizeAssistantVariant(variant) {
  return {
    id: String(variant.id),
    content: typeof variant.content === 'string' ? variant.content : '',
    createdAt: variant.createdAt || new Date().toISOString(),
    status: typeof variant.status === 'string' ? variant.status : 'complete',
    model: isAllowedModel(variant.model) ? variant.model : null,
    feedback: ['like', 'dislike'].includes(variant.feedback) ? variant.feedback : null,
    ...(variant.updatedAt ? { updatedAt: variant.updatedAt } : {}),
    ...(typeof variant.error === 'string' ? { error: variant.error } : {}),
    ...(typeof variant.notice === 'string' ? { notice: variant.notice } : {}),
  };
}

function normalizeMessage(message) {
  const normalized = {
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
  if (normalized.role === 'assistant' && Array.isArray(message.variants) && message.variants.length) {
    normalized.variants = message.variants.map(normalizeAssistantVariant);
    normalized.activeVariantId = normalized.variants.some(variant => variant.id === String(message.activeVariantId))
      ? String(message.activeVariantId)
      : normalized.variants[0].id;
  }
  if (normalized.role === 'user' && Object.hasOwn(message, 'parentVariantId')) {
    normalized.parentVariantId = message.parentVariantId == null ? null : String(message.parentVariantId);
  }
  if (normalized.role === 'assistant' && Object.hasOwn(message, 'parentUserId')) {
    normalized.parentUserId = message.parentUserId == null ? null : String(message.parentUserId);
  }
  return normalized;
}

export function storedChat(chat) {
  const stored = {
    id: String(chat.id),
    title: typeof chat.title === 'string' && chat.title ? chat.title : 'New conversation',
    createdAt: chat.createdAt || new Date().toISOString(),
    updatedAt: chat.updatedAt || chat.createdAt || new Date().toISOString(),
    model: isAllowedModel(chat.model) ? chat.model : DEFAULT_MODEL,
    folderId: chat.folderId == null ? null : String(chat.folderId),
    messages: Array.isArray(chat.messages) ? chat.messages.map(normalizeMessage) : [],
    group: chat.group === 'Yesterday' ? 'Yesterday' : 'Today',
    demo: chat.demo === true,
    // Records created before timestamp titles have no flag, so their existing title stays locked.
    titleInitialized: chat.titleInitialized === false ? false : true,
  };
  ensureBranchLineage(stored);
  return stored;
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
  const demos = existing.filter(chat => chat.demo === true);
  if (existing.length && (demos.length === 0 || (demos.length === 1 && demos[0].id === CANONICAL_DEMO_ID))) return existing;
  const [canonicalDemo] = createSeedChats();
  if (!canonicalDemo || canonicalDemo.demo !== true || canonicalDemo.id !== CANONICAL_DEMO_ID)
    throw new Error('Canonical demo seed is invalid');
  if (!existing.length) {
    await saveChat(canonicalDemo, indexedDBApi);
    return loadChats(indexedDBApi);
  }
  const database = await openChatDatabase(indexedDBApi);
  const transaction = database.transaction(CHAT_STORE_NAME, 'readwrite');
  const store = transaction.objectStore(CHAT_STORE_NAME);
  for (const demo of demos) store.delete(demo.id);
  store.put(storedChat(canonicalDemo));
  await transactionDone(transaction);
  return loadChats(indexedDBApi);
}

export async function deleteChat(chatId, indexedDBApi = globalThis.indexedDB) {
  const database = await openChatDatabase(indexedDBApi);
  const transaction = database.transaction(CHAT_STORE_NAME, 'readwrite');
  transaction.objectStore(CHAT_STORE_NAME).delete(chatId);
  await transactionDone(transaction);
}

export async function loadWallpaperAsset(indexedDBApi = globalThis.indexedDB) {
  const database = await openChatDatabase(indexedDBApi);
  const transaction = database.transaction(ASSET_STORE_NAME, 'readonly');
  const record = await requestResult(transaction.objectStore(ASSET_STORE_NAME).get(WALLPAPER_ASSET_ID));
  await transactionDone(transaction);
  return record || null;
}

export async function saveWallpaperAsset(file, indexedDBApi = globalThis.indexedDB) {
  const record = {
    id: WALLPAPER_ASSET_ID,
    blob: file,
    name: typeof file.name === 'string' && file.name ? file.name : 'Wallpaper',
    type: file.type,
    size: file.size,
    updatedAt: new Date().toISOString(),
  };
  const database = await openChatDatabase(indexedDBApi);
  const transaction = database.transaction(ASSET_STORE_NAME, 'readwrite');
  transaction.objectStore(ASSET_STORE_NAME).put(record);
  await transactionDone(transaction);
  return record;
}

export async function deleteWallpaperAsset(indexedDBApi = globalThis.indexedDB) {
  const database = await openChatDatabase(indexedDBApi);
  const transaction = database.transaction(ASSET_STORE_NAME, 'readwrite');
  transaction.objectStore(ASSET_STORE_NAME).delete(WALLPAPER_ASSET_ID);
  await transactionDone(transaction);
}

export async function closeChatDatabase() {
  if (!sharedDatabase) return;
  const database = await sharedDatabase;
  database.close();
  sharedDatabase = undefined;
}
