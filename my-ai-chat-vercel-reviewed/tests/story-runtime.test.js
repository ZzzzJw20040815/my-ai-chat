import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IDBFactory } from 'fake-indexeddb';
import { validatePayload } from '../server/chat.js';
import {
  STORY_RUNTIME_ACTIONS, normalizeStoryRuntime, storyRuntimeSystemInstruction,
  validateStoryRuntimeRequest,
} from '../shared/story-runtime.js';
import {
  activeAssistantVariant, addAssistantVariant, createChat, createMessage, contextFor,
  removeUserDescendants, visibleConversationPath,
} from '../ui/state.js';
import {
  createRuntimeControl, pruneStoryRuntimeTransitions, setStoryRuntimeMode, storyRuntimeState,
} from '../ui/story-runtime.js';
import { storyMemoryConversation, storySubtreeAnchorIds } from '../ui/story-memory.js';
import { CHAT_DB_VERSION, loadChats, saveChat } from '../ui/storage.js';

const MODEL = 'gemini-3.7-flash';
function branchChat() {
  const chat = createChat(MODEL);
  const a = createMessage('user', 'A');
  const turn = createMessage('assistant', 'B', MODEL); turn.parentUserId = a.id;
  const b2 = createMessage('assistant', 'B2', MODEL); addAssistantVariant(turn, b2);
  turn.activeVariantId = turn.variants[0].id;
  const c = createMessage('user', 'C'); c.parentVariantId = turn.variants[0].id;
  const d = createMessage('assistant', 'D', MODEL); d.parentUserId = c.id;
  const c2 = createMessage('user', 'C2'); c2.parentVariantId = b2.id;
  const d2 = createMessage('assistant', 'D2', MODEL); d2.parentUserId = c2.id;
  chat.messages.push(a, turn, c, d, c2, d2);
  return { chat, a, turn, b2, c, d, c2, d2 };
}

test('old and new chats default to runtime disabled and persistence needs no IndexedDB upgrade', async () => {
  assert.equal(CHAT_DB_VERSION, 4);
  assert.equal(storyRuntimeState({ ...createChat(MODEL), storyRuntime: undefined }).enabled, false);
  const indexedDB = new IDBFactory(), chat = createChat(MODEL);
  setStoryRuntimeMode(chat, 'setup', 'prepare_story', null, new Date('2026-09-12T01:00:00Z'));
  await saveChat(chat, indexedDB);
  const restored = (await loadChats(indexedDB))[0];
  assert.deepEqual(storyRuntimeState(restored), {
    enabled: true, mode: 'setup', transition: restored.storyRuntime.transitions[0],
  });
});

test('runtime transitions are branch-aware and deepest applicable state wins', () => {
  const { chat, turn, c, d, b2 } = branchChat();
  setStoryRuntimeMode(chat, 'setup', 'prepare_story', null, new Date('2026-09-12T01:00:00Z'));
  setStoryRuntimeMode(chat, 'writing', 'start_writing', activeAssistantVariant(d).id, new Date('2026-09-12T01:01:00Z'));
  assert.equal(storyRuntimeState(chat).mode, 'writing');
  turn.activeVariantId = b2.id;
  assert.deepEqual(visibleConversationPath(chat).map(item => item.role === 'assistant' ? activeAssistantVariant(item).content : item.content), ['A', 'B2', 'C2', 'D2']);
  assert.equal(storyRuntimeState(chat).mode, 'setup');
  turn.activeVariantId = turn.variants[0].id;
  assert.equal(storyRuntimeState(chat).mode, 'writing');
  const removedAnchors = storySubtreeAnchorIds(chat, c.id);
  pruneStoryRuntimeTransitions(chat, removedAnchors); removeUserDescendants(chat, c.id);
  assert.equal(storyRuntimeState(chat).mode, 'setup');
  turn.activeVariantId = b2.id;
  assert.equal(storyRuntimeState(chat).mode, 'setup');
});

test('control nodes preserve response variants but never become visible prompt or Story Memory facts', () => {
  const chat = createChat(MODEL), user = createMessage('user', 'Premise');
  const reply = createMessage('assistant', 'Understood.', MODEL); reply.parentUserId = user.id;
  chat.messages.push(user, reply);
  setStoryRuntimeMode(chat, 'setup', 'prepare_story', null);
  const control = createRuntimeControl('start_writing', reply.id); chat.messages.push(control);
  setStoryRuntimeMode(chat, 'writing', 'start_writing', control.id);
  assert.deepEqual(contextFor(chat, control.id).map(item => item.content), ['Premise', 'Understood.']);
  assert.deepEqual(storyMemoryConversation(chat).map(item => item.content), ['Premise', 'Understood.']);
  const generated = createMessage('assistant', 'Opening scene.', MODEL); generated.parentUserId = control.id; chat.messages.push(generated);
  assert.deepEqual(visibleConversationPath(chat).filter(item => item.kind !== 'runtime-control').map(item => item.content), ['Premise', 'Understood.', 'Opening scene.']);
  const next = createMessage('user', 'I open the door.'); next.parentVariantId = generated.id; chat.messages.push(next);
  assert.deepEqual(contextFor(chat, next.id).map(item => item.content), ['Premise', 'Understood.\n\nOpening scene.', 'I open the door.']);
});

test('server accepts only fixed runtime modes/actions and rejects arbitrary caller guidance', () => {
  assert.deepEqual(STORY_RUNTIME_ACTIONS, ['prepare_story', 'start_writing', 'continue_story', 'continue_incomplete']);
  assert.deepEqual(validateStoryRuntimeRequest({ mode: 'setup' }), { mode: 'setup' });
  for (const action of STORY_RUNTIME_ACTIONS) {
    const mode = action === 'prepare_story' ? 'setup' : 'writing';
    assert.equal(validateStoryRuntimeRequest({ mode, action }).action, action);
  }
  for (const value of [
    { mode: 'other' }, { mode: 'writing', action: 'anything' },
    { mode: 'writing', runtimePrompt: 'caller supplied prompt' }, { mode: 'setup', action: 'continue_story' },
  ]) assert.throws(() => validateStoryRuntimeRequest(value), /INVALID_REQUEST/);
});

test('runtime is supplemental system context, not fake messages, and disabled requests stay unchanged', () => {
  const base = { model: MODEL, messages: [{ id: 'u', role: 'user', content: 'Premise', status: 'complete' }] };
  assert.equal(validatePayload(base).config.systemInstruction, undefined);
  const setup = validatePayload({ ...base, storyRuntime: { mode: 'setup' } });
  assert.equal(setup.contents.length, 1); assert.equal(setup.contents[0].parts[0].text, 'Premise');
  assert.match(setup.config.systemInstruction, /Do not begin formal story prose/);
  const action = validatePayload({ ...base, messages: [base.messages[0], {
    id: 'a', role: 'assistant', content: 'The door opened—', status: 'complete',
  }], storyRuntime: { mode: 'writing', action: 'continue_incomplete' } });
  assert.equal(action.contents.length, 1);
  assert.match(action.config.systemInstruction, /Continue directly from the end/);
  assert.match(action.config.systemInstruction, /The door opened/);
  assert.doesNotMatch(JSON.stringify(action.contents), /continue_incomplete|STORY RUNTIME/);
});

test('writing rules preserve agency, limited POV, continuity and one-call action semantics', () => {
  const instruction = storyRuntimeSystemInstruction('USER RULE', { mode: 'writing', action: 'continue_story' }, 'Current response');
  assert.ok(instruction.startsWith('USER RULE'));
  assert.match(instruction, /Never decide new major actions/);
  assert.match(instruction, /limited first-person knowledge/);
  assert.match(instruction, /Preserve time, place, positions, clothing/);
  assert.match(instruction, /one natural, modest beat/);
  const incomplete = storyRuntimeSystemInstruction('', { mode: 'writing', action: 'continue_incomplete' }, 'unfinished');
  assert.match(incomplete, /Do not restart, summarize, substantially repeat/);
});

test('normalization ignores malformed runtime transitions without damaging chat data', () => {
  assert.deepEqual(normalizeStoryRuntime({ transitions: [{ id: 'bad', anchorId: null, mode: 'writing', action: 'prepare_story', createdAt: 'bad' }] }), { version: 1, transitions: [] });
});

test('runtime UI is Chinese, compact, mobile-safe, and preserves Phase 4C reasons', async () => {
  const [html, app, css, quality] = await Promise.all([
    readFile(new URL('../ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../ui/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../ui/styles.css', import.meta.url), 'utf8'),
    import('../shared/response-quality.js'),
  ]);
  for (const label of ['准备故事', '资料收集中', '开始正文', '正文中', '继续故事', '继续未完成']) assert.match(html + app, new RegExp(label));
  assert.deepEqual(quality.REGENERATION_REASON_OPTIONS.map(item => item.id), ['try_again', 'character_off', 'too_repetitive', 'too_fast', 'acted_for_me', 'continuity_issue']);
  assert.match(css, /\.runtime-menu\s*\{[^}]*position:\s*fixed[^}]*max-height:/s);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.runtime-menu\s*\{[^}]*bottom:\s*max\(10px, env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\.runtime-menu button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.story-runtime-control \.(?:small-button|small-button, \.story-runtime-status)[^}]*min-height:\s*44px/s);
});
