import { isAllowedModel } from '../shared/models.js';
import { normalizeGlobalSettings } from '../shared/settings.js';
import { loadChats, saveChats, storedChat } from './storage.js';
import { saveGlobalSettings } from './settings.js';

export const BACKUP_FORMAT = 'my-ai-chat-backup';
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;

const MESSAGE_STATUSES = new Set(['complete', 'sending', 'generating', 'stopped', 'interrupted', 'error']);
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isValidDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;

export class BackupValidationError extends Error {}

function invalid(message = 'This backup file could not be imported.') {
  throw new BackupValidationError(message);
}

function validateVariant(variant, variantIds) {
  if (!isRecord(variant) || !validId(variant.id) || variantIds.has(variant.id)) invalid();
  if (typeof variant.content !== 'string' || !isValidDate(variant.createdAt)) invalid();
  if (!MESSAGE_STATUSES.has(variant.status) || (variant.model != null && !isAllowedModel(variant.model))) invalid();
  variantIds.add(variant.id);
}

function validateMessage(message, messageIds, userIds, variantIds) {
  if (!isRecord(message) || !validId(message.id) || messageIds.has(message.id)) invalid();
  if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') invalid();
  if (!isValidDate(message.createdAt) || !MESSAGE_STATUSES.has(message.status)) invalid();
  if (message.role === 'assistant' && message.model != null && !isAllowedModel(message.model)) invalid();
  messageIds.add(message.id);
  if (message.role === 'user') {
    userIds.add(message.id);
    if (Object.hasOwn(message, 'parentVariantId') && message.parentVariantId != null && !validId(message.parentVariantId)) invalid();
    return;
  }
  if (Object.hasOwn(message, 'parentUserId') && message.parentUserId != null && !validId(message.parentUserId)) invalid();
  if (Object.hasOwn(message, 'variants')) {
    if (!Array.isArray(message.variants) || !message.variants.length) invalid();
    for (const variant of message.variants) validateVariant(variant, variantIds);
    if (!validId(message.activeVariantId) || !message.variants.some(variant => variant.id === message.activeVariantId)) invalid();
  } else {
    if (variantIds.has(message.id)) invalid();
    variantIds.add(message.id);
  }
}

function validateChat(chat, chatIds) {
  if (!isRecord(chat) || !validId(chat.id) || chatIds.has(chat.id)) invalid();
  if (typeof chat.title !== 'string' || !chat.title || !isValidDate(chat.createdAt) || !isValidDate(chat.updatedAt)) invalid();
  if (!isAllowedModel(chat.model) || !Array.isArray(chat.messages)) invalid();
  if (chat.folderId != null && !validId(chat.folderId)) invalid();
  chatIds.add(chat.id);
  const messageIds = new Set(), userIds = new Set(), variantIds = new Set();
  for (const message of chat.messages) validateMessage(message, messageIds, userIds, variantIds);
  for (const message of chat.messages) {
    if (message.role === 'user' && message.parentVariantId != null && !variantIds.has(message.parentVariantId)) invalid();
    if (message.role === 'assistant' && message.parentUserId != null && !userIds.has(message.parentUserId)) invalid();
  }
}

function interruptedCopy(chat) {
  const copy = storedChat(chat);
  for (const message of copy.messages) {
    const replies = message.role === 'assistant' && Array.isArray(message.variants) ? message.variants : [message];
    for (const reply of replies) {
      if (reply.role === 'user') continue;
      if (['sending', 'generating'].includes(reply.status)) {
        reply.status = 'interrupted';
        reply.notice = reply.notice || 'Generation was in progress when this backup was created.';
      }
    }
  }
  return copy;
}

export function createBackup({ chats, settings, activeChatId = null, theme = 'dark', now = new Date() }) {
  const exportedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const normalizedChats = Array.isArray(chats) ? chats.map(interruptedCopy) : [];
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    app: { name: 'My AI Chat', theme: theme === 'light' ? 'light' : 'dark' },
    chats: normalizedChats,
    settings: normalizeGlobalSettings(settings),
    activeChatId: validId(activeChatId) && normalizedChats.some(chat => chat.id === activeChatId) ? activeChatId : null,
  };
}

export function validateBackup(value) {
  if (!isRecord(value) || value.format !== BACKUP_FORMAT) invalid();
  if (value.version !== BACKUP_VERSION) invalid('This backup version is not supported.');
  if (!isValidDate(value.exportedAt) || !Array.isArray(value.chats) || !isRecord(value.settings)) invalid();
  const chatIds = new Set();
  for (const chat of value.chats) validateChat(chat, chatIds);
  const chats = value.chats.map(interruptedCopy);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date(value.exportedAt).toISOString(),
    app: {
      name: 'My AI Chat',
      theme: ['dark', 'light'].includes(value.app?.theme) ? value.app.theme : null,
    },
    chats,
    settings: normalizeGlobalSettings(value.settings),
    activeChatId: validId(value.activeChatId) && chats.some(chat => chat.id === value.activeChatId) ? value.activeChatId : null,
  };
}

export function parseBackupText(text) {
  if (typeof text !== 'string') invalid();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { invalid(); }
  return validateBackup(parsed);
}

export function backupJson(backup) {
  return JSON.stringify(validateBackup(backup), null, 2) + '\n';
}

export function backupFilename(date = new Date()) {
  const part = value => String(value).padStart(2, '0');
  return `my-ai-chat-backup-${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}.json`;
}

export function downloadBackup(backup, dependencies = {}) {
  const documentApi = dependencies.documentApi || document;
  const urlApi = dependencies.urlApi || URL;
  const BlobApi = dependencies.BlobApi || Blob;
  const schedule = dependencies.schedule || setTimeout;
  const blob = new BlobApi([backupJson(backup)], { type: 'application/json;charset=utf-8' });
  const url = urlApi.createObjectURL(blob);
  const anchor = documentApi.createElement('a');
  anchor.href = url;
  anchor.download = backupFilename(new Date(backup.exportedAt));
  anchor.hidden = true;
  documentApi.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Safari may still be handing the Blob URL to its download UI after click().
  schedule(() => urlApi.revokeObjectURL(url), 1000);
  return { filename: anchor.download, blob };
}

function incomingIsNewer(incoming, local) {
  const incomingTime = Date.parse(incoming.updatedAt), localTime = Date.parse(local.updatedAt);
  return Number.isFinite(incomingTime) && Number.isFinite(localTime) && incomingTime > localTime;
}

export function planBackupMerge(localChats, incomingChats) {
  const localById = new Map(localChats.map(chat => [chat.id, chat]));
  const writes = [];
  let added = 0, updated = 0, kept = 0;
  for (const incoming of incomingChats) {
    const local = localById.get(incoming.id);
    if (!local) { writes.push(incoming); localById.set(incoming.id, incoming); added++; }
    else if (incomingIsNewer(incoming, local)) { writes.push(incoming); localById.set(incoming.id, incoming); updated++; }
    else kept++;
  }
  return { writes, chats: [...localById.values()], added, updated, kept };
}

export async function importBackup(backup, dependencies = {}) {
  const indexedDBApi = dependencies.indexedDBApi || globalThis.indexedDB;
  const storage = dependencies.storage || localStorage;
  const normalized = validateBackup(backup);
  const localChats = await loadChats(indexedDBApi);
  const plan = planBackupMerge(localChats, normalized.chats);
  if (plan.writes.length) await saveChats(plan.writes, indexedDBApi);
  const settings = saveGlobalSettings(normalized.settings, storage);
  return {
    ...plan,
    chats: await loadChats(indexedDBApi),
    settings,
    activeChatId: normalized.activeChatId,
    theme: normalized.app.theme,
    exportedAt: normalized.exportedAt,
  };
}
