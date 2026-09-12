import { validateStoryMemory, STORY_MEMORY_SCHEMA_VERSION } from '../shared/story-memory.js';
import { activeAssistantVariant, assistantVariants, ensureBranchLineage, uniqueId, visibleConversationPath } from './state.js';

export function visibleStoryAnchors(chat) {
  return visibleConversationPath(chat).map(message => message.role === 'assistant'
    ? activeAssistantVariant(message)?.id
    : message.id).filter(Boolean);
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

export function storyMemoryConversation(chat) {
  return visibleConversationPath(chat).map(message => {
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
