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
export function createChat(model = DEFAULT_MODEL) {
  const createdAt = new Date().toISOString();
  return { id: uniqueId(), title: 'New conversation', model, folderId: null, createdAt, updatedAt: createdAt,
    group: 'Today', messages: [], draft: '', scrollTop: 0, demo: false };
}
// Include complete turns only. Failed/stopped partial responses never masquerade as valid context.
export function contextFor(chat, userId) {
  const end = chat.messages.findIndex(message => message.id === userId && message.role === 'user');
  if (end < 0) throw new Error('Message not found');
  const result = [];
  for (let index = 0; index <= end; index++) {
    const user = chat.messages[index];
    if (user.role !== 'user' || user.status !== 'complete') continue;
    if (index === end) { result.push(user); break; }
    const assistant = chat.messages[index + 1];
    if (assistant?.role === 'assistant' && assistant.status === 'complete' && assistant.content.trim()) {
      result.push(user, assistant);
      index++;
    }
  }
  return result.map(({ id, role, content, status }) => ({ id, role, content, status }));
}
