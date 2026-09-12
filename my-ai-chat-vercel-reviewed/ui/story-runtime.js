import { normalizeStoryRuntime } from '../shared/story-runtime.js';
import { activeAssistantVariant, createMessage, uniqueId, visibleConversationPath } from './state.js';

export const isRuntimeControlMessage = message => message?.role === 'user' && message.kind === 'runtime-control';

export function storyRuntimeState(chat) {
  const runtime = normalizeStoryRuntime(chat?.storyRuntime);
  const depths = new Map([[null, -1]]);
  visibleConversationPath(chat).forEach((message, index) => {
    depths.set(message.role === 'assistant' ? activeAssistantVariant(message)?.id : message.id, index);
  });
  const transition = runtime.transitions.filter(item => depths.has(item.anchorId))
    .sort((left, right) => depths.get(right.anchorId) - depths.get(left.anchorId)
      || right.createdAt.localeCompare(left.createdAt))[0] || null;
  return transition ? { enabled: true, mode: transition.mode, transition } : { enabled: false, mode: null, transition: null };
}

export function currentRuntimeAnchor(chat) {
  const message = visibleConversationPath(chat).at(-1);
  return message ? (message.role === 'assistant' ? activeAssistantVariant(message)?.id : message.id) : null;
}

export function setStoryRuntimeMode(chat, mode, action, anchorId = currentRuntimeAnchor(chat), now = new Date()) {
  const runtime = normalizeStoryRuntime(chat.storyRuntime);
  runtime.transitions.push({ id: uniqueId(), anchorId: anchorId ?? null, mode, action, createdAt: now.toISOString() });
  chat.storyRuntime = runtime;
  return runtime.transitions.at(-1);
}

export function createRuntimeControl(action, parentVariantId) {
  const message = createMessage('user', '');
  message.kind = 'runtime-control';
  message.runtimeAction = action;
  message.parentVariantId = parentVariantId;
  return message;
}

export function pruneStoryRuntimeTransitions(chat, anchorIds) {
  const runtime = normalizeStoryRuntime(chat.storyRuntime);
  runtime.transitions = runtime.transitions.filter(item => item.anchorId == null || !anchorIds.has(item.anchorId));
  chat.storyRuntime = runtime;
}
