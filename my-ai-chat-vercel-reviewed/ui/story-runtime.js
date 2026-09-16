import { normalizeStoryRuntime } from '../shared/story-runtime.js';
import { activeAssistantVariant, createMessage, uniqueId, visibleConversationPath } from './state.js';

export const isRuntimeControlMessage = message => message?.role === 'user' && message.kind === 'runtime-control';

export const RUNTIME_CONTROL_LABELS = Object.freeze({
  start_writing: '开始正文',
  continue_story: '继续故事',
  continue_incomplete: '继续未完成',
});

export const runtimeControlLabel = message => isRuntimeControlMessage(message)
  ? RUNTIME_CONTROL_LABELS[message.runtimeAction] || null
  : null;

export const isVisibleRuntimeControlMessage = message => runtimeControlLabel(message) !== null;

function hasVisibleContent(variant) {
  return typeof variant?.content === 'string' && variant.content.trim().length > 0;
}

function isTruncatedVariant(variant) {
  if (variant?.completionReason === 'max_tokens') return true;
  // Chats saved before completionReason existed only retain this stable notice.
  return variant?.notice === '回复达到输出长度限制，可继续提问。';
}

export function continuationAvailability(chat, generationActive = false) {
  if (generationActive) return { action: null, variant: null, reason: 'generation-active' };
  const assistant = visibleConversationPath(chat).filter(message => message.role === 'assistant').at(-1);
  const variant = activeAssistantVariant(assistant);
  if (!assistant || !variant || !hasVisibleContent(variant)) {
    return { action: null, variant: variant || null, reason: 'no-visible-content' };
  }
  if (isTruncatedVariant(variant) || ['stopped', 'interrupted', 'error'].includes(variant.status)) {
    return { action: 'continue_incomplete', variant, reason: 'incomplete' };
  }
  if (variant.status === 'complete') return { action: 'continue_story', variant, reason: 'complete' };
  return { action: null, variant, reason: 'unavailable' };
}

export function storyRuntimeState(chat) {
  const runtime = normalizeStoryRuntime(chat?.storyRuntime);
  const depths = new Map([[null, -1]]);
  visibleConversationPath(chat).forEach((message, index) => {
    depths.set(message.role === 'assistant' ? activeAssistantVariant(message)?.id : message.id, index);
  });
  const transition = runtime.transitions.filter(item => depths.has(item.anchorId))
    .sort((left, right) => depths.get(right.anchorId) - depths.get(left.anchorId)
      || right.createdAt.localeCompare(left.createdAt))[0] || null;
  if (!transition) return { enabled: false, mode: null, transition: null };
  return transition.mode === 'disabled'
    ? { enabled: false, mode: null, transition }
    : { enabled: true, mode: transition.mode, transition };
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
