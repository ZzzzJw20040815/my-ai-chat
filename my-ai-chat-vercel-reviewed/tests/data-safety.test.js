import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IDBFactory } from 'fake-indexeddb';
import { DEFAULT_GLOBAL_SETTINGS, GLOBAL_SETTINGS_STORAGE_KEY } from '../shared/settings.js';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  BackupValidationError,
  backupFilename,
  backupJson,
  createBackup,
  downloadBackup,
  importBackup,
  parseBackupText,
  planBackupMerge,
  validateBackup,
} from '../ui/backup.js';
import { contextFor, createChat, createMessage, visibleConversationPath } from '../ui/state.js';
import { loadChats, loadWallpaperAsset, saveChat, saveWallpaperAsset } from '../ui/storage.js';
import { requestStoragePersistence, storagePersistenceStatus } from '../ui/storage-persistence.js';

class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
}

function variant(id, content, createdAt, status = 'complete') {
  return { id, content, createdAt, status, model: 'gemini-3.7-flash', feedback: null };
}

function branchedChat(id = 'chat-branch', updatedAt = '2026-09-11T10:10:00.000Z') {
  const chat = createChat('gemini-3.7-flash');
  Object.assign(chat, { id, title: 'Branch archive', createdAt: '2026-09-11T10:00:00.000Z', updatedAt, titleInitialized: true });
  const userA = { ...createMessage('user', 'A'), id: `${id}-u1`, createdAt: '2026-09-11T10:00:00.000Z', parentVariantId: null };
  const assistant = {
    ...createMessage('assistant', '', 'gemini-3.7-flash'), id: `${id}-turn1`, createdAt: '2026-09-11T10:01:00.000Z', parentUserId: userA.id,
    variants: [
      variant(`${id}-b1`, 'B', '2026-09-11T10:01:00.000Z'),
      variant(`${id}-b2`, 'B2', '2026-09-11T10:02:00.000Z'),
    ],
    activeVariantId: `${id}-b2`,
  };
  const userC = { ...createMessage('user', 'C2'), id: `${id}-u2`, createdAt: '2026-09-11T10:03:00.000Z', parentVariantId: `${id}-b2` };
  const answerD = {
    ...createMessage('assistant', 'D2', 'gemini-3.7-flash'), id: `${id}-turn2`, createdAt: '2026-09-11T10:04:00.000Z', parentUserId: userC.id,
  };
  chat.messages = [userA, assistant, userC, answerD];
  return chat;
}

function settings() {
  return {
    ...DEFAULT_GLOBAL_SETTINGS,
    defaultModel: 'gemini-3.7-flash',
    systemInstruction: 'Answer as an editor.',
    contextLimit: '20',
    maxOutputTokens: 2048,
    thinkingLevel: 'low',
    samplingOverrides: { enabled: true, temperature: 0.7, topP: 0.8, topK: 32 },
    safetySettings: { ...DEFAULT_GLOBAL_SETTINGS.safetySettings, mode: 'custom', harassment: 'BLOCK_ONLY_HIGH' },
  };
}

test('Export creates readable version 1 JSON with chats, branches, variants, settings and preferences', () => {
  const chat = branchedChat();
  const backup = createBackup({ chats: [chat], settings: settings(), activeChatId: chat.id, theme: 'light', now: new Date('2026-09-11T23:15:00.000Z') });
  const parsed = JSON.parse(backupJson(backup));
  assert.equal(parsed.format, BACKUP_FORMAT);
  assert.equal(parsed.version, BACKUP_VERSION);
  assert.equal(parsed.exportedAt, '2026-09-11T23:15:00.000Z');
  assert.equal(parsed.chats.length, 1);
  assert.equal(parsed.chats[0].messages[1].variants.length, 2);
  assert.equal(parsed.chats[0].messages[1].activeVariantId, 'chat-branch-b2');
  assert.equal(parsed.chats[0].messages[2].parentVariantId, 'chat-branch-b2');
  assert.equal(parsed.chats[0].messages[1].parentUserId, 'chat-branch-u1');
  assert.deepEqual(parsed.settings, settings());
  assert.equal(parsed.activeChatId, chat.id);
  assert.equal(parsed.app.theme, 'light');
  assert.match(backupJson(backup), /\n  "format"/);
});

test('Backup excludes secrets and wallpaper data, and uses a local-time filename', () => {
  const backup = createBackup({ chats: [branchedChat()], settings: settings(), now: new Date(2026, 8, 11, 23, 15) });
  const json = backupJson(backup);
  assert.doesNotMatch(json, /GEMINI_API_KEY|VITE_|cookie|credential|chat-wallpaper|image\/jpeg/i);
  assert.equal(backupFilename(new Date(2026, 8, 11, 23, 15)), 'my-ai-chat-backup-2026-09-11-2315.json');
});

test('standard Blob and anchor download path works without File System Access API', async () => {
  let clicked = false, revoked = '';
  const anchor = { hidden: false, click() { clicked = true; }, remove() {} };
  const documentApi = { createElement: tag => (assert.equal(tag, 'a'), anchor), body: { append() {} } };
  const urlApi = { createObjectURL: () => 'blob:backup', revokeObjectURL: value => { revoked = value; } };
  const result = downloadBackup(createBackup({ chats: [], settings: settings(), now: new Date(2026, 8, 11, 23, 15) }), {
    documentApi, urlApi, schedule: callback => callback(),
  });
  assert.equal(clicked, true);
  assert.equal(result.blob.type, 'application/json;charset=utf-8');
  assert.equal(result.filename, 'my-ai-chat-backup-2026-09-11-2315.json');
  assert.equal(revoked, 'blob:backup');
});

test('Export to empty database and Import restores active branch and Gemini context', async () => {
  const indexedDB = new IDBFactory(), storage = new MemoryStorage();
  const original = branchedChat();
  const backup = createBackup({ chats: [original], settings: settings(), activeChatId: original.id });
  const result = await importBackup(backup, { indexedDBApi: indexedDB, storage });
  const [restored] = await loadChats(indexedDB);
  assert.equal(result.added, 1);
  assert.equal(result.activeChatId, original.id);
  assert.deepEqual(visibleConversationPath(restored).map(message => message.role === 'assistant' ? message.activeVariantId || message.content : message.content), ['A', 'chat-branch-b2', 'C2', 'D2']);
  assert.deepEqual(contextFor(restored, 'chat-branch-u2').map(message => message.content), ['A', 'B2', 'C2']);
  assert.equal(restored.messages[1].variants.length, 2);
  assert.equal(restored.messages[2].parentVariantId, 'chat-branch-b2');
});

test('MERGE adds missing chats, replaces only newer backups, and never duplicates IDs', async () => {
  const localNewer = branchedChat('same', '2026-09-12T10:00:00.000Z');
  localNewer.title = 'Keep local';
  const backupOlder = branchedChat('same', '2026-09-11T10:00:00.000Z');
  backupOlder.title = 'Old backup';
  const added = branchedChat('added', '2026-09-11T11:00:00.000Z');
  let plan = planBackupMerge([localNewer], [backupOlder, added]);
  assert.deepEqual({ added: plan.added, updated: plan.updated, kept: plan.kept }, { added: 1, updated: 0, kept: 1 });
  assert.equal(plan.chats.find(chat => chat.id === 'same').title, 'Keep local');
  assert.equal(plan.chats.filter(chat => chat.id === 'same').length, 1);

  const backupNewer = branchedChat('same', '2026-09-13T10:00:00.000Z');
  backupNewer.title = 'Use backup';
  plan = planBackupMerge([localNewer], [backupNewer]);
  assert.equal(plan.updated, 1);
  assert.equal(plan.chats[0].title, 'Use backup');
});

test('unreliable updatedAt comparison preserves local data', () => {
  const local = branchedChat('same'); local.updatedAt = 'invalid';
  const incoming = branchedChat('same', '2026-09-13T10:00:00.000Z');
  const plan = planBackupMerge([local], [incoming]);
  assert.equal(plan.updated, 0);
  assert.equal(plan.kept, 1);
});

test('Import restores normalized settings and leaves wallpaper asset untouched', async () => {
  const indexedDB = new IDBFactory(), storage = new MemoryStorage();
  await saveWallpaperAsset(Object.assign(new Blob(['wall'], { type: 'image/jpeg' }), { name: 'private-wall.jpg' }), indexedDB);
  const backup = createBackup({ chats: [branchedChat()], settings: settings() });
  await importBackup(backup, { indexedDBApi: indexedDB, storage });
  assert.deepEqual(JSON.parse(storage.getItem(GLOBAL_SETTINGS_STORAGE_KEY)), settings());
  assert.equal((await loadWallpaperAsset(indexedDB)).name, 'private-wall.jpg');
});

test('Malformed, wrong-format, unsupported and invalid-message backups are rejected before writes', async () => {
  const indexedDB = new IDBFactory();
  const local = branchedChat('local');
  await saveChat(local, indexedDB);
  assert.throws(() => parseBackupText('{broken'), BackupValidationError);
  const valid = createBackup({ chats: [branchedChat('incoming')], settings: settings() });
  assert.throws(() => validateBackup({ ...valid, format: 'other-app' }), BackupValidationError);
  assert.throws(() => validateBackup({ ...valid, version: 2 }), /not supported/);
  const invalidMessage = structuredClone(valid);
  invalidMessage.chats[0].messages[0].role = 'system';
  assert.throws(() => validateBackup(invalidMessage), BackupValidationError);
  assert.deepEqual((await loadChats(indexedDB)).map(chat => chat.id), ['local']);
});

test('unknown settings are ignored and invalid activeChatId safely falls back to null', () => {
  const backup = createBackup({ chats: [branchedChat()], settings: settings() });
  const normalized = validateBackup({ ...backup, settings: { ...settings(), injected: 'ignored' }, activeChatId: 'missing' });
  assert.equal(normalized.settings.injected, undefined);
  assert.equal(normalized.activeChatId, null);
});

test('in-progress generations become safely interrupted in exported data', () => {
  const chat = branchedChat();
  chat.messages[1].variants[1].status = 'generating';
  const backup = createBackup({ chats: [chat], settings: settings() });
  assert.equal(backup.chats[0].messages[1].variants[1].status, 'interrupted');
});

test('persistent storage feature detection reports unsupported, best effort, granted and denied states', async () => {
  assert.deepEqual(await storagePersistenceStatus(undefined), { state: 'unsupported', supported: false });
  assert.deepEqual(await storagePersistenceStatus({ persisted: async () => false, persist: async () => false }), { state: 'best-effort', supported: true });
  assert.deepEqual(await storagePersistenceStatus({ persisted: async () => true, persist: async () => false }), { state: 'persistent', supported: true });
  assert.deepEqual(await requestStoragePersistence({ persisted: async () => false, persist: async () => true }), { state: 'persistent', supported: true });
  assert.deepEqual(await requestStoragePersistence({ persisted: async () => false, persist: async () => false }), { state: 'denied', supported: true });
});

test('Settings UI provides mobile-safe local backup controls without a second scroll owner', async () => {
  const [html, css, app] = await Promise.all([
    readFile(new URL('../ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../ui/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../ui/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="backupInput"[^>]*accept="\.json,application\/json"/);
  assert.match(html, /Backup files contain your full chat history\. Keep them somewhere private\./);
  assert.match(html, /id="requestStoragePersistence"/);
  assert.match(css, /@media \(max-width:\s*520px\)[\s\S]*\.local-data-actions\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
  assert.match(css, /\.settings-card\s*\{[^}]*overflow-y:\s*auto/);
  assert.doesNotMatch(css.match(/\.settings-dialog\s*\{([^}]*)\}/s)?.[1] || '', /overflow-y:\s*(?:auto|scroll)/);
  assert.match(app, /window\.confirm\([\s\S]*Existing newer chats will be kept\./);
  assert.doesNotMatch(app, /showSaveFilePicker|showOpenFilePicker/);
});
