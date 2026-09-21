import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { DEFAULT_GLOBAL_SETTINGS } from '../shared/settings.js';
import { BACKUP_VERSION, BackupValidationError, createBackup, validateBackup } from '../ui/backup.js';
import {
  activeAssistantVariant,
  activeUserChild,
  addAssistantVariant,
  contextFor,
  createChat,
  createMessage,
  sanitizeUserChildSelections,
  selectUserChild,
  userSiblingTurns,
  visibleConversationPath,
} from '../ui/state.js';
import { applicableStoryMemory } from '../ui/story-memory.js';
import { createRuntimeControl, setStoryRuntimeMode, storyRuntimeState } from '../ui/story-runtime.js';
import { CHAT_DB_VERSION, closeChatDatabase, loadChats, saveChat, storedChat } from '../ui/storage.js';

const MODEL = 'gemini-3.7-flash';
const pathContent = chat => visibleConversationPath(chat).map(message => message.role === 'assistant'
  ? activeAssistantVariant(message).content
  : message.content);

function userBranchChat() {
  const chat = createChat(MODEL);
  const a = createMessage('user', 'A'); a.parentVariantId = null;
  const b = createMessage('assistant', 'B', MODEL); b.parentUserId = a.id;
  const c = createMessage('user', 'C'); c.parentVariantId = b.id;
  const d = createMessage('assistant', 'D', MODEL); d.parentUserId = c.id;
  const c2 = createMessage('user', 'C+'); c2.parentVariantId = b.id;
  const e = createMessage('assistant', 'E', MODEL); e.parentUserId = c2.id;
  chat.messages = [a, b, c, d, c2, e];
  return { chat, a, b, c, d, c2, e };
}

test('legacy linear chats retain the first-child visible path without selection metadata', () => {
  const chat = createChat(MODEL);
  const a = createMessage('user', 'A');
  const b = createMessage('assistant', 'B', MODEL);
  const c = createMessage('user', 'C');
  const d = createMessage('assistant', 'D', MODEL);
  chat.messages = [a, b, c, d];
  assert.deepEqual(pathContent(chat), ['A', 'B', 'C', 'D']);
  assert.equal(chat.activeRootUserId, undefined);
  assert.equal(b.activeChildUserId, undefined);
});

test('explicit active child selection switches complete user subtrees and isolates context', () => {
  const { chat, b, c, d, c2, e } = userBranchChat();
  assert.deepEqual(pathContent(chat), ['A', 'B', 'C', 'D']);
  assert.equal(selectUserChild(chat, c2.id), true);
  assert.equal(b.activeChildUserId, c2.id);
  assert.deepEqual(pathContent(chat), ['A', 'B', 'C+', 'E']);
  assert.deepEqual(contextFor(chat, c2.id).map(message => message.content), ['A', 'B', 'C+']);
  assert.throws(() => contextFor(chat, c.id), /Message not found/);
  assert.equal(chat.messages.includes(c), true);
  assert.equal(chat.messages.includes(d), true);
  assert.equal(chat.messages.includes(e), true);
  assert.equal(selectUserChild(chat, c.id), true);
  assert.deepEqual(pathContent(chat), ['A', 'B', 'C', 'D']);
});

test('root revisions and three siblings use persistent deterministic selection', () => {
  const chat = createChat(MODEL);
  const roots = ['A', 'A+', 'A++'].map(content => {
    const user = createMessage('user', content); user.parentVariantId = null; return user;
  });
  const replies = roots.map((user, index) => {
    const reply = createMessage('assistant', `B${index + 1}`, MODEL); reply.parentUserId = user.id; return reply;
  });
  chat.messages = roots.flatMap((user, index) => [user, replies[index]]);
  assert.deepEqual(pathContent(chat), ['A', 'B1']);
  assert.equal(selectUserChild(chat, roots[2].id), true);
  assert.equal(chat.activeRootUserId, roots[2].id);
  assert.deepEqual(pathContent(chat), ['A++', 'B3']);
  assert.deepEqual(userSiblingTurns(chat, roots[2]).map(user => user.content), ['A', 'A+', 'A++']);
  assert.equal(selectUserChild(chat, replies[0].id), false);
});

test('assistant variant and user child selections remain branch-local', () => {
  const chat = createChat(MODEL);
  const a = createMessage('user', 'A'); a.parentVariantId = null;
  const turn = createMessage('assistant', 'B1', MODEL); turn.parentUserId = a.id;
  const b2 = createMessage('assistant', 'B2', MODEL); addAssistantVariant(turn, b2);
  turn.activeVariantId = turn.variants[0].id;
  const c1 = createMessage('user', 'C1'); c1.parentVariantId = turn.variants[0].id;
  const c1b = createMessage('user', 'C1+'); c1b.parentVariantId = turn.variants[0].id;
  const c2 = createMessage('user', 'C2'); c2.parentVariantId = b2.id;
  chat.messages = [a, turn, c1, c1b, c2];
  selectUserChild(chat, c1b.id);
  assert.deepEqual(pathContent(chat), ['A', 'B1', 'C1+']);
  turn.activeVariantId = b2.id;
  assert.deepEqual(pathContent(chat), ['A', 'B2', 'C2']);
  turn.activeVariantId = turn.variants[0].id;
  assert.deepEqual(pathContent(chat), ['A', 'B1', 'C1+']);
});

test('creating an Assistant sibling variant migrates the legacy child selection to the original variant', () => {
  const { chat, b, c2 } = userBranchChat();
  selectUserChild(chat, c2.id);
  assert.equal(b.activeChildUserId, c2.id);
  const alternate = createMessage('assistant', 'B2', MODEL);
  addAssistantVariant(b, alternate);
  assert.equal(b.activeChildUserId, undefined);
  assert.equal(b.variants[0].activeChildUserId, c2.id);
  assert.equal(b.variants[1].activeChildUserId, undefined);
  b.activeVariantId = b.variants[0].id;
  assert.deepEqual(pathContent(chat), ['A', 'B', 'C+', 'E']);
  b.activeVariantId = alternate.id;
  assert.deepEqual(pathContent(chat), ['A', 'B2']);
});

test('runtime controls route as user children but never appear in ordinary user sibling navigation', () => {
  const chat = createChat(MODEL);
  const a = createMessage('user', 'Premise'); a.parentVariantId = null;
  const b = createMessage('assistant', 'Setup', MODEL); b.parentUserId = a.id;
  const control = createRuntimeControl('start_writing', b.id);
  chat.messages = [a, b, control];
  assert.equal(selectUserChild(chat, control.id), true);
  assert.equal(activeUserChild(chat, b.id), control);
  assert.deepEqual(pathContent(chat), ['Premise', 'Setup', '']);
  assert.deepEqual(userSiblingTurns(chat, control), []);
});

test('selection metadata round-trips through storage without an IndexedDB upgrade', async () => {
  assert.equal(CHAT_DB_VERSION, 4);
  const indexedDB = new IDBFactory();
  const { chat, b, c2 } = userBranchChat();
  selectUserChild(chat, c2.id);
  await saveChat(chat, indexedDB);
  const [restored] = await loadChats(indexedDB);
  assert.equal(restored.messages.find(message => message.id === b.id).activeChildUserId, c2.id);
  assert.deepEqual(pathContent(restored), ['A', 'B', 'C+', 'E']);
  await closeChatDatabase();
});

test('stale local selections are removed and safely fall back to legacy children', () => {
  const { chat, b } = userBranchChat();
  chat.activeRootUserId = 'missing-root';
  b.activeChildUserId = 'missing-child';
  const normalized = storedChat(chat);
  assert.equal(normalized.activeRootUserId, undefined);
  assert.equal(normalized.messages.find(message => message.id === b.id).activeChildUserId, undefined);
  assert.deepEqual(pathContent(normalized), ['A', 'B', 'C', 'D']);
  assert.equal(sanitizeUserChildSelections(normalized), normalized);
});

test('Backup V1 round-trips selections and rejects root and cross-branch references', () => {
  const { chat, b, c2 } = userBranchChat();
  chat.activeRootUserId = chat.messages[0].id;
  selectUserChild(chat, c2.id);
  const backup = createBackup({ chats: [chat], settings: DEFAULT_GLOBAL_SETTINGS, activeChatId: chat.id });
  assert.equal(backup.version, BACKUP_VERSION);
  const [restored] = validateBackup(structuredClone(backup)).chats;
  assert.equal(restored.activeRootUserId, chat.messages[0].id);
  assert.equal(restored.messages.find(message => message.id === b.id).activeChildUserId, c2.id);
  assert.deepEqual(pathContent(restored), ['A', 'B', 'C+', 'E']);

  const badRoot = structuredClone(backup);
  badRoot.chats[0].activeRootUserId = c2.id;
  assert.throws(() => validateBackup(badRoot), BackupValidationError);
  const badChild = structuredClone(backup);
  badChild.chats[0].messages.find(message => message.id === b.id).activeChildUserId = chat.messages[0].id;
  assert.throws(() => validateBackup(badChild), BackupValidationError);

  const legacy = structuredClone(backup);
  delete legacy.chats[0].activeRootUserId;
  delete legacy.chats[0].messages.find(message => message.id === b.id).activeChildUserId;
  assert.deepEqual(pathContent(validateBackup(legacy).chats[0]), ['A', 'B', 'C', 'D']);
});

test('Story Memory and Runtime keep sibling data while applicability follows the selected user branch', () => {
  const { chat, b, c, d, c2, e } = userBranchChat();
  const snapshots = [
    { id: 'ancestor', chatId: chat.id, anchorId: b.id, updatedAt: '2026-09-21T00:00:00Z' },
    { id: 'old-branch', chatId: chat.id, anchorId: d.id, updatedAt: '2026-09-21T00:01:00Z' },
    { id: 'new-branch', chatId: chat.id, anchorId: e.id, updatedAt: '2026-09-21T00:02:00Z' },
  ];
  setStoryRuntimeMode(chat, 'setup', 'prepare_story', b.id, new Date('2026-09-21T00:00:00Z'));
  setStoryRuntimeMode(chat, 'writing', 'start_writing', d.id, new Date('2026-09-21T00:01:00Z'));
  assert.equal(applicableStoryMemory(chat, snapshots).id, 'old-branch');
  assert.equal(storyRuntimeState(chat).mode, 'writing');
  assert.equal(selectUserChild(chat, c2.id), true);
  assert.equal(applicableStoryMemory(chat, snapshots).id, 'new-branch');
  assert.equal(storyRuntimeState(chat).mode, 'setup');
  assert.equal(chat.storyRuntime.transitions.length, 2);
  assert.equal(snapshots.length, 3);
  assert.equal(selectUserChild(chat, c.id), true);
  assert.equal(applicableStoryMemory(chat, snapshots).id, 'old-branch');
  assert.equal(storyRuntimeState(chat).mode, 'writing');
});

test('failed revision generation remains retryable without damaging the original user branch', () => {
  const { chat, b, c, d } = userBranchChat();
  const failed = createMessage('user', 'C failed revision'); failed.parentVariantId = b.id;
  const errorReply = createMessage('assistant', '', MODEL); errorReply.parentUserId = failed.id;
  errorReply.status = 'error'; errorReply.error = 'safe failure';
  chat.messages.push(failed, errorReply);
  selectUserChild(chat, failed.id);
  assert.deepEqual(pathContent(chat), ['A', 'B', 'C failed revision', '']);
  assert.equal(errorReply.status, 'error');
  assert.equal(chat.messages.includes(c), true);
  assert.equal(chat.messages.includes(d), true);
  selectUserChild(chat, c.id);
  assert.deepEqual(pathContent(chat), ['A', 'B', 'C', 'D']);
});
