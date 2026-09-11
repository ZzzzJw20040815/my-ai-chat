import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { createChat, createMessage } from '../ui/state.js';
import {
  ASSET_STORE_NAME,
  CHAT_DB_NAME,
  CHAT_DB_VERSION,
  CHAT_STORE_NAME,
  deleteWallpaperAsset,
  loadChats,
  loadWallpaperAsset,
  openChatDatabase,
  saveWallpaperAsset,
} from '../ui/storage.js';
import {
  MAX_WALLPAPER_BYTES,
  createWallpaperPresenter,
  decodeWallpaperImage,
  validateWallpaperFile,
} from '../ui/wallpaper.js';

function namedBlob(name, type, content = 'image data') {
  const blob = new Blob([content], { type });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

function createLegacyDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CHAT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(CHAT_STORE_NAME, { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt');
      store.createIndex('demo', 'demo');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

test('JPEG, PNG and WebP pass validation and decode; invalid and oversized files are rejected', async () => {
  const revoked = [];
  const urlApi = {
    createObjectURL: file => `blob:test-${file.type}`,
    revokeObjectURL: url => revoked.push(url),
  };
  class DecodableImage {
    naturalWidth = 2400;
    naturalHeight = 1600;
    set src(_) { queueMicrotask(() => this.onload()); }
  }
  for (const [name, type] of [['wall.jpg', 'image/jpeg'], ['wall.png', 'image/png'], ['wall.webp', 'image/webp']]) {
    const file = namedBlob(name, type);
    assert.equal(validateWallpaperFile(file), file);
    await decodeWallpaperImage(file, { urlApi, ImageConstructor: DecodableImage });
  }
  assert.equal(revoked.length, 3);
  assert.throws(() => validateWallpaperFile(namedBlob('notes.txt', 'text/plain')), /JPEG, PNG, or WebP/);
  assert.throws(() => validateWallpaperFile({ type: 'image/jpeg', size: MAX_WALLPAPER_BYTES + 1 }), /25 MB/);

  class BrokenImage {
    naturalWidth = 0;
    naturalHeight = 0;
    set src(_) { queueMicrotask(() => this.onerror()); }
  }
  await assert.rejects(decodeWallpaperImage(namedBlob('broken.jpg', 'image/jpeg'), { urlApi, ImageConstructor: BrokenImage }), /could not be decoded/);
});

test('IndexedDB v2 adds assets without rebuilding or losing the existing chats store', async () => {
  const indexedDB = new IDBFactory();
  const databaseV1 = await createLegacyDatabase(indexedDB);
  const chat = createChat('gemini-3.7-flash');
  chat.title = 'Keep this chat';
  chat.messages.push(createMessage('user', 'Persistent history'));
  await new Promise((resolve, reject) => {
    const transaction = databaseV1.transaction(CHAT_STORE_NAME, 'readwrite');
    transaction.objectStore(CHAT_STORE_NAME).put(chat);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  databaseV1.close();

  const upgraded = await openChatDatabase(indexedDB);
  assert.equal(upgraded.version, CHAT_DB_VERSION);
  assert.ok(upgraded.objectStoreNames.contains(CHAT_STORE_NAME));
  assert.ok(upgraded.objectStoreNames.contains(ASSET_STORE_NAME));
  const restored = await loadChats(indexedDB);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].title, 'Keep this chat');
  assert.equal(restored[0].messages[0].content, 'Persistent history');
});

test('wallpaper Blob survives reload, replacement and removal', async () => {
  const indexedDB = new IDBFactory();
  await saveWallpaperAsset(namedBlob('first.jpg', 'image/jpeg'), indexedDB);
  let restored = await loadWallpaperAsset(indexedDB);
  assert.equal(restored.name, 'first.jpg');
  assert.equal(restored.blob.type, 'image/jpeg');

  await saveWallpaperAsset(namedBlob('replacement.png', 'image/png'), indexedDB);
  restored = await loadWallpaperAsset(indexedDB);
  assert.equal(restored.name, 'replacement.png');
  assert.equal(restored.blob.type, 'image/png');
  assert.equal((await loadWallpaperAsset(indexedDB)).name, 'replacement.png');

  await deleteWallpaperAsset(indexedDB);
  assert.equal(await loadWallpaperAsset(indexedDB), null);
  assert.equal(await loadWallpaperAsset(indexedDB), null);
});

test('presenter targets chat main panel and Conversation without leaking to body', async () => {
  const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html);
  const conversation = dom.window.document.querySelector('#conversation');
  const mainPanel = dom.window.document.querySelector('.main-panel');
  const preview = dom.window.document.querySelector('#wallpaperPreview');
  const revoked = [];
  let sequence = 0;
  const presenter = createWallpaperPresenter({
    conversation,
    preview,
    urlApi: {
      createObjectURL: () => `blob:wallpaper-${++sequence}`,
      revokeObjectURL: url => revoked.push(url),
    },
  });

  presenter.show({ blob: namedBlob('first.jpg', 'image/jpeg') });
  assert.equal(conversation.classList.contains('has-wallpaper'), true);
  assert.equal(mainPanel.classList.contains('has-wallpaper'), true);
  assert.match(conversation.style.getPropertyValue('--chat-wallpaper-image'), /blob:wallpaper-1/);
  assert.match(mainPanel.style.getPropertyValue('--chat-wallpaper-image'), /blob:wallpaper-1/);
  assert.equal(dom.window.document.body.style.backgroundImage, '');
  presenter.show({ blob: namedBlob('second.webp', 'image/webp') });
  assert.deepEqual(revoked, ['blob:wallpaper-1']);
  presenter.clear();
  assert.equal(conversation.classList.contains('has-wallpaper'), false);
  assert.equal(mainPanel.classList.contains('has-wallpaper'), false);
  assert.equal(mainPanel.style.getPropertyValue('--chat-wallpaper-image'), '');
  assert.equal(preview.hasAttribute('src'), false);
  assert.deepEqual(revoked, ['blob:wallpaper-1', 'blob:wallpaper-2']);
  dom.window.close();
});

test('Wallpaper UI remains compact and responsive with fixed readability treatment', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../ui/styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="wallpaperInput"[^>]*accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(css, /\.main-panel\.has-wallpaper\s*\{[^}]*background-size:\s*cover;[^}]*background-position:\s*center;[^}]*background-repeat:\s*no-repeat;/s);
  assert.match(css, /\.main-panel\.has-wallpaper \.conversation\s*\{[^}]*background-image:\s*none/);
  assert.match(css, /html\[data-theme="light"\][^{]*\{[^}]*--wallpaper-tint:/s);
  assert.match(css, /@media \(max-width:\s*520px\)[\s\S]*\.wallpaper-controls\s*\{[^}]*width:\s*100%/);
  assert.doesNotMatch(css, /body[^{}]*\{[^}]*chat-wallpaper-image/s);
});
