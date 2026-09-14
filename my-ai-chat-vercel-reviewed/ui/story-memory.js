import { validateStoryMemory, STORY_MEMORY_MAX_BYTES, STORY_MEMORY_SCHEMA_VERSION } from '../shared/story-memory.js';
import {
  STORY_MEMORY_MAX_CHUNKS, STORY_MEMORY_MAX_MESSAGE_CHARACTERS, STORY_MEMORY_SAFE_BODY_BYTES,
  STORY_MEMORY_SAFE_MESSAGES, STORY_MEMORY_SAFE_TOTAL_CHARACTERS,
} from '../shared/story-memory-transport.js';
import { activeAssistantVariant, assistantVariants, ensureBranchLineage, uniqueId, visibleConversationPath } from './state.js';

export function visibleStoryAnchors(chat) {
  return visibleConversationPath(chat).filter(message => message.kind !== 'runtime-control').map(message => message.role === 'assistant'
    ? activeAssistantVariant(message)?.id
    : message.id).filter(Boolean);
}

export const STORY_MEMORY_UPDATE_ERROR_CODES = Object.freeze([
  'CONTEXT_LIMIT', 'TIMEOUT', 'RATE_LIMIT', 'NETWORK_ERROR', 'MODEL_UNAVAILABLE', 'KEY_MISSING',
  'MEMORY_INVALID_ANCHOR', 'MEMORY_INVALID_JSON', 'MEMORY_STORAGE_FAILED', 'SERVER_ERROR',
]);

export const STORY_MEMORY_ERROR_MESSAGES = Object.freeze({
  CONTEXT_LIMIT: '当前故事内容过长，无法在安全的更新预算内整理记忆。',
  TIMEOUT: '故事记忆生成超时，请稍后重试。',
  RATE_LIMIT: 'Gemini 暂时繁忙，请稍后再试。',
  NETWORK_ERROR: '无法连接 Gemini，请检查网络后重试。',
  MODEL_UNAVAILABLE: '当前模型暂不可用于故事记忆。',
  KEY_MISSING: '故事记忆服务尚未配置，请联系站点管理员。',
  MEMORY_INVALID_JSON: 'Gemini 返回的故事记忆格式无效，原记忆已保留。',
  MEMORY_STORAGE_FAILED: '故事记忆已生成，但无法保存到此设备。',
  MEMORY_INVALID_ANCHOR: '当前故事分支状态异常，无法建立记忆锚点。',
  SERVER_ERROR: '故事记忆暂时无法更新，请稍后重试。',
});

export class StoryMemoryUpdateError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'StoryMemoryUpdateError';
    this.code = STORY_MEMORY_UPDATE_ERROR_CODES.includes(code) ? code : 'SERVER_ERROR';
    this.details = details;
  }
}

export function classifyStoryMemoryUpdateError(error, stage = 'extraction') {
  if (error instanceof StoryMemoryUpdateError) return error.code;
  if (stage === 'anchor') return 'MEMORY_INVALID_ANCHOR';
  if (stage === 'validation') return 'MEMORY_INVALID_JSON';
  if (stage === 'storage') return 'MEMORY_STORAGE_FAILED';
  return 'SERVER_ERROR';
}

export function storyMemoryErrorMessage(code) {
  return STORY_MEMORY_ERROR_MESSAGES[code] || STORY_MEMORY_ERROR_MESSAGES.SERVER_ERROR;
}

export function currentStoryAnchor(chat) {
  return visibleStoryAnchors(chat).at(-1) || null;
}

export function allStoryAnchors(chat) {
  ensureBranchLineage(chat);
  return new Set(chat.messages.flatMap(message => message.role === 'assistant'
    ? assistantVariants(message).map(variant => variant.id)
    : [message.id]));
}

export function applicableStoryMemory(chat, snapshots = []) {
  const depths = new Map(visibleStoryAnchors(chat).map((id, index) => [id, index]));
  return snapshots.filter(snapshot => snapshot?.chatId === chat.id && depths.has(snapshot.anchorId))
    .sort((left, right) => depths.get(right.anchorId) - depths.get(left.anchorId)
      || String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] || null;
}

function storyMemoryMessagesFromPath(path) {
  return path.filter(message => message.kind !== 'runtime-control').map(message => {
    const source = message.role === 'assistant' ? activeAssistantVariant(message) : message;
    return {
      id: source.id,
      role: message.role,
      content: typeof source.content === 'string' ? source.content : '',
      status: typeof source.status === 'string' ? source.status : 'complete',
      createdAt: source.createdAt || message.createdAt,
    };
  });
}

export function storyMemoryConversation(chat) {
  return storyMemoryMessagesFromPath(visibleConversationPath(chat));
}

export function storyMemoryMessagesAfterAnchor(path, anchorId) {
  const messages = storyMemoryMessagesFromPath(path);
  const anchorIndex = messages.findIndex(message => message.id === anchorId);
  if (anchorIndex < 0) throw new StoryMemoryUpdateError('MEMORY_INVALID_ANCHOR');
  return messages.slice(anchorIndex + 1);
}

export function storyMemoryUpdatePlan(chat, snapshots = []) {
  const anchorId = currentStoryAnchor(chat);
  if (!anchorId) throw new StoryMemoryUpdateError('MEMORY_INVALID_ANCHOR');
  const path = visibleConversationPath(chat);
  const messages = storyMemoryMessagesFromPath(path);
  if (!messages.some(message => message.id === anchorId)) throw new StoryMemoryUpdateError('MEMORY_INVALID_ANCHOR');
  const applicable = applicableStoryMemory(chat, snapshots);
  const pendingMessages = applicable
    ? storyMemoryMessagesAfterAnchor(path, applicable.anchorId)
    : messages;
  return { anchorId, applicable, pendingMessages, upToDate: !!applicable && pendingMessages.length === 0 };
}

const utf8Bytes = value => new TextEncoder().encode(value).byteLength;
export function storyMemoryRequestByteLength(payload) {
  return utf8Bytes(JSON.stringify(payload));
}

function reservedRequestBytes(payload) {
  const memoryBytes = payload.existingMemory == null ? utf8Bytes('null') : utf8Bytes(JSON.stringify(payload.existingMemory));
  return storyMemoryRequestByteLength(payload) + Math.max(0, STORY_MEMORY_MAX_BYTES - memoryBytes);
}

export function chunkStoryMemoryMessages({ model, chatId, messages, existingMemory = null }) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const chunks = [];
  let chunk = [];
  const fits = candidate => {
    const totalCharacters = candidate.reduce((sum, message) => sum + message.content.length, 0);
    if (candidate.length > STORY_MEMORY_SAFE_MESSAGES || totalCharacters > STORY_MEMORY_SAFE_TOTAL_CHARACTERS) return false;
    const payload = { model, chatId, anchorId: candidate.at(-1).id, messages: candidate, existingMemory };
    return reservedRequestBytes(payload) <= STORY_MEMORY_SAFE_BODY_BYTES;
  };
  for (const message of messages) {
    if (typeof message?.content !== 'string' || message.content.length > STORY_MEMORY_MAX_MESSAGE_CHARACTERS) {
      throw new StoryMemoryUpdateError('CONTEXT_LIMIT', { reason: 'message_limit' });
    }
    const candidate = chunk.concat(message);
    if (fits(candidate)) {
      chunk = candidate;
      continue;
    }
    if (!chunk.length) throw new StoryMemoryUpdateError('CONTEXT_LIMIT', { reason: 'single_message_budget' });
    chunks.push(chunk);
    if (chunks.length >= STORY_MEMORY_MAX_CHUNKS) throw new StoryMemoryUpdateError('CONTEXT_LIMIT', { reason: 'chunk_limit' });
    chunk = [message];
    if (!fits(chunk)) throw new StoryMemoryUpdateError('CONTEXT_LIMIT', { reason: 'single_message_budget' });
  }
  if (chunk.length) chunks.push(chunk);
  if (chunks.length > STORY_MEMORY_MAX_CHUNKS) throw new StoryMemoryUpdateError('CONTEXT_LIMIT', { reason: 'chunk_limit' });
  return chunks;
}

const SERVER_ERROR_CODES = Object.freeze({
  CONTEXT_LIMIT: 'CONTEXT_LIMIT', TIMEOUT: 'TIMEOUT', RATE_LIMIT: 'RATE_LIMIT',
  NETWORK_ERROR: 'NETWORK_ERROR', MODEL_UNAVAILABLE: 'MODEL_UNAVAILABLE', KEY_MISSING: 'KEY_MISSING',
  MEMORY_INVALID: 'MEMORY_INVALID_JSON', SERVER_ERROR: 'SERVER_ERROR',
});

async function requestStoryMemoryChunk(payload, fetchImpl) {
  let response;
  try {
    response = await fetchImpl('/api/story-memory', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  } catch {
    throw new StoryMemoryUpdateError('NETWORK_ERROR');
  }
  let body;
  try { body = await response.json(); }
  catch { throw new StoryMemoryUpdateError(response.ok ? 'MEMORY_INVALID_JSON' : 'SERVER_ERROR', { status: response.status }); }
  if (!response.ok) {
    const serverCode = typeof body?.error?.code === 'string' ? body.error.code : null;
    throw new StoryMemoryUpdateError(SERVER_ERROR_CODES[serverCode] || 'SERVER_ERROR', { serverCode, status: response.status });
  }
  try { return validateStoryMemory(body?.memory); }
  catch { throw new StoryMemoryUpdateError('MEMORY_INVALID_JSON'); }
}

export async function runStoryMemoryUpdate({ chat, snapshots = [], fetchImpl = fetch, save, onProgress = () => {} }) {
  const plan = storyMemoryUpdatePlan(chat, snapshots);
  if (plan.upToDate) return { ...plan, updated: false, calls: 0, chunks: 0, snapshots };
  const activePathRevision = JSON.stringify(storyMemoryConversation(chat));
  const chunks = chunkStoryMemoryMessages({
    model: chat.model, chatId: chat.id, messages: plan.pendingMessages, existingMemory: plan.applicable?.memory || null,
  });
  let nextMemory = plan.applicable?.memory || null;
  for (let index = 0; index < chunks.length; index++) {
    onProgress({ index: index + 1, total: chunks.length });
    const messages = chunks[index];
    nextMemory = await requestStoryMemoryChunk({
      model: chat.model, chatId: chat.id, anchorId: messages.at(-1).id, messages, existingMemory: nextMemory,
    }, fetchImpl);
  }
  if (currentStoryAnchor(chat) !== plan.anchorId || JSON.stringify(storyMemoryConversation(chat)) !== activePathRevision) {
    throw new StoryMemoryUpdateError('MEMORY_INVALID_ANCHOR');
  }
  let snapshot;
  try { snapshot = createStoryMemorySnapshot({ chatId: chat.id, anchorId: plan.anchorId, memory: nextMemory }); }
  catch { throw new StoryMemoryUpdateError('MEMORY_INVALID_JSON'); }
  let nextSnapshots;
  try { nextSnapshots = await commitStoryMemoryUpdate(snapshots, snapshot, save); }
  catch { throw new StoryMemoryUpdateError('MEMORY_STORAGE_FAILED'); }
  return { ...plan, updated: true, calls: chunks.length, chunks: chunks.length, snapshot, snapshots: nextSnapshots };
}

export function storySubtreeAnchorIds(chat, userId) {
  ensureBranchLineage(chat);
  const anchors = new Set([userId]);
  const users = [userId];
  for (let cursor = 0; cursor < users.length; cursor++) {
    const turns = chat.messages.filter(message => message.role === 'assistant' && message.parentUserId === users[cursor]);
    for (const turn of turns) {
      const variantIds = assistantVariants(turn).map(variant => variant.id);
      for (const id of variantIds) anchors.add(id);
      for (const child of chat.messages) {
        if (child.role === 'user' && variantIds.includes(child.parentVariantId) && !anchors.has(child.id)) {
          anchors.add(child.id);
          users.push(child.id);
        }
      }
    }
  }
  return anchors;
}

export function createStoryMemorySnapshot({ chatId, anchorId, memory, now = new Date(), id = uniqueId() }) {
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  if (typeof chatId !== 'string' || !chatId || typeof anchorId !== 'string' || !anchorId) throw new Error('Invalid story memory anchor');
  return {
    id, chatId, anchorId, schemaVersion: STORY_MEMORY_SCHEMA_VERSION,
    createdAt: timestamp, updatedAt: timestamp, memory: validateStoryMemory(memory),
  };
}

export async function commitStoryMemoryUpdate(snapshots, snapshot, save) {
  await save(snapshot);
  return snapshots.filter(item => item.chatId !== snapshot.chatId || item.anchorId !== snapshot.anchorId).concat(snapshot);
}

export function memoryStatusText(snapshot, now = Date.now()) {
  if (!snapshot) return 'Memory: Not created';
  const elapsed = Math.max(0, now - Date.parse(snapshot.updatedAt));
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return 'Memory updated just now';
  if (minutes < 60) return `Memory updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Memory updated ${hours} hr ago`;
  return 'Memory updated ' + new Date(snapshot.updatedAt).toLocaleDateString();
}
