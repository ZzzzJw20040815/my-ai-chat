import { DEFAULT_MODEL } from '../shared/models.js';
export function uniqueId(source = crypto) {
  if (typeof source.randomUUID === 'function') return source.randomUUID();
  // getRandomValues also works in the HTTP development preview.
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
/** Message: stable UUID, role, Markdown content, ISO createdAt, status, model, feedback.
 * Chat: stable UUID, title, model, createdAt/updatedAt, folderId and messages. */
export function createMessage(role, content = '', model = null) {
  return { id: uniqueId(), role, content, createdAt: new Date().toISOString(),
    status: 'complete', model: role === 'assistant' ? model : null, feedback: null };
}
function responseVariant(message) {
  return {
    id: message.id,
    content: message.content,
    createdAt: message.createdAt,
    status: message.status,
    model: message.model,
    feedback: message.feedback ?? null,
    ...(message.updatedAt ? { updatedAt: message.updatedAt } : {}),
    ...(typeof message.error === 'string' ? { error: message.error } : {}),
    ...(typeof message.notice === 'string' ? { notice: message.notice } : {}),
  };
}
export function activeAssistantVariant(message) {
  if (message?.role !== 'assistant' || !Array.isArray(message.variants) || !message.variants.length) return message;
  return message.variants.find(variant => variant.id === message.activeVariantId) || message.variants[0];
}
export function ensureAssistantVariants(message) {
  if (message?.role !== 'assistant') throw new Error('Assistant message required');
  if (!Array.isArray(message.variants) || !message.variants.length) {
    const legacyVariant = responseVariant(message);
    message.variants = [legacyVariant];
    message.activeVariantId = legacyVariant.id;
  } else if (!message.variants.some(variant => variant.id === message.activeVariantId)) {
    message.activeVariantId = message.variants[0].id;
  }
  return message.variants;
}
export function addAssistantVariant(message, variantMessage) {
  const variants = ensureAssistantVariants(message);
  const variant = responseVariant(variantMessage);
  variants.push(variant);
  message.activeVariantId = variant.id;
  return variant;
}
export function assistantVariantById(message, variantId) {
  if (!Array.isArray(message?.variants) || !message.variants.length) return message?.id === variantId ? message : null;
  return message.variants.find(variant => variant.id === variantId) || null;
}
export function assistantVariants(message) {
  if (message?.role !== 'assistant') return [];
  return Array.isArray(message.variants) && message.variants.length ? message.variants : [message];
}
// Older chats are linear. Missing lineage is inferred from the immediately preceding
// user/assistant sequence; explicit lineage on branched chats is never overwritten.
export function ensureBranchLineage(chat) {
  let precedingUser = null;
  let precedingVariantId = null;
  for (const message of chat.messages) {
    if (message.role === 'user') {
      if (!Object.hasOwn(message, 'parentVariantId')) message.parentVariantId = precedingVariantId;
      precedingUser = message;
      precedingVariantId = null;
      continue;
    }
    if (!Object.hasOwn(message, 'parentUserId')) message.parentUserId = precedingUser?.id || null;
    precedingVariantId = activeAssistantVariant(message)?.id || null;
  }
  return chat;
}
export function visibleConversationPath(chat) {
  ensureBranchLineage(chat);
  const path = [];
  let user = chat.messages.find(message => message.role === 'user' && message.parentVariantId == null);
  const visited = new Set();
  while (user && !visited.has(user.id)) {
    visited.add(user.id);
    path.push(user);
    const assistant = chat.messages.find(message => message.role === 'assistant' && message.parentUserId === user.id);
    if (!assistant) break;
    path.push(assistant);
    const variantId = activeAssistantVariant(assistant)?.id;
    user = chat.messages.find(message => message.role === 'user' && message.parentVariantId === variantId);
  }
  return path;
}
export function removeUserDescendants(chat, userId) {
  ensureBranchLineage(chat);
  const removed = new Set();
  const pendingUsers = [userId];
  for (let cursor = 0; cursor < pendingUsers.length; cursor++) {
    const parentUserId = pendingUsers[cursor];
    const turns = chat.messages.filter(message => message.role === 'assistant' && message.parentUserId === parentUserId);
    for (const turn of turns) {
      removed.add(turn.id);
      const variantIds = new Set(assistantVariants(turn).map(variant => variant.id));
      for (const child of chat.messages) {
        if (child.role === 'user' && variantIds.has(child.parentVariantId) && !removed.has(child.id)) {
          removed.add(child.id);
          pendingUsers.push(child.id);
        }
      }
    }
  }
  chat.messages = chat.messages.filter(message => !removed.has(message.id));
  return removed;
}
export function formatLocalChatTitle(createdAt) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return 'New conversation';
  const part = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}`;
}
export function createChat(model = DEFAULT_MODEL) {
  const createdAt = new Date().toISOString();
  return { id: uniqueId(), title: 'New conversation', model, folderId: null, createdAt, updatedAt: createdAt,
    group: 'Today', messages: [], draft: '', scrollTop: 0, demo: false, titleInitialized: false };
}
// Include complete turns only. Failed/stopped partial responses never masquerade as valid context.
export function contextFor(chat, userId, contextLimit = 'all') {
  const visibleMessages = visibleConversationPath(chat);
  const end = visibleMessages.findIndex(message => message.id === userId && message.role === 'user');
  if (end < 0) throw new Error('Message not found');
  const result = [];
  for (let index = 0; index <= end; index++) {
    const user = visibleMessages[index];
    if (user.role !== 'user' || user.status !== 'complete') continue;
    if (index === end) { result.push(user); break; }
    const assistant = visibleMessages[index + 1];
    const activeVariant = activeAssistantVariant(assistant);
    if (assistant?.role === 'assistant' && activeVariant?.status === 'complete' && activeVariant.content.trim()) {
      result.push(user, { ...activeVariant, role: 'assistant' });
      index++;
    }
  }
  let limited = result;
  if (contextLimit !== 'all') {
    const limit = Number(contextLimit);
    if ([10, 20, 50].includes(limit) && result.length > limit) {
      limited = result.slice(-limit);
      if (limited[0]?.role === 'assistant') limited = limited.slice(1);
    }
  }
  return limited.map(({ id, role, content, status }) => ({ id, role, content, status }));
}
