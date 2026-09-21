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
  continuationAvailability, createRuntimeControl, isVisibleRuntimeControlMessage, pruneStoryRuntimeTransitions,
  regenerationRuntimeAction, runtimeControlLabel, setStoryRuntimeMode, storyRuntimeState,
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

test('exit_story disables only the active branch and survives persistence', async () => {
  const { chat, turn, b2, d } = branchChat();
  setStoryRuntimeMode(chat, 'setup', 'prepare_story', null, new Date('2026-09-12T01:00:00Z'));
  setStoryRuntimeMode(chat, 'writing', 'start_writing', activeAssistantVariant(d).id, new Date('2026-09-12T01:01:00Z'));
  setStoryRuntimeMode(chat, 'disabled', 'exit_story', activeAssistantVariant(d).id, new Date('2026-09-12T01:02:00Z'));
  assert.equal(storyRuntimeState(chat).enabled, false);
  assert.equal(storyRuntimeState(chat).transition.action, 'exit_story');
  turn.activeVariantId = b2.id;
  assert.equal(storyRuntimeState(chat).mode, 'setup');
  turn.activeVariantId = turn.variants[0].id;
  const indexedDB = new IDBFactory();
  await saveChat(chat, indexedDB);
  const restored = (await loadChats(indexedDB))[0];
  assert.equal(storyRuntimeState(restored).enabled, false);
  assert.equal(storyRuntimeState(restored).transition.action, 'exit_story');
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
  assert.match(setup.config.systemInstruction, /explicit start_writing runtime action/);
  assert.match(setup.config.systemInstruction, /“I hope the opening is…”/);
  assert.match(setup.config.systemInstruction, /Respond briefly/);
  const action = validatePayload({ ...base, messages: [base.messages[0], {
    id: 'a', role: 'assistant', content: 'The door opened—', status: 'complete',
  }], storyRuntime: { mode: 'writing', action: 'continue_incomplete' } });
  assert.deepEqual(action.contents.map(item => item.role), ['user', 'model', 'user']);
  assert.equal(action.contents[1].parts[0].text, 'The door opened—');
  assert.match(action.contents.at(-1).parts[0].text, /exact ending.*immediately above/i);
  assert.match(action.config.systemInstruction, /Continue directly from the end/);
  assert.doesNotMatch(action.config.systemInstruction, /The door opened/);
  assert.doesNotMatch(JSON.stringify(action.contents), /continue_incomplete|STORY RUNTIME/);
});

test('structured completion reason persists without an IndexedDB or backup schema upgrade', async () => {
  const indexedDB = new IDBFactory(), chat = createChat(MODEL);
  const user = createMessage('user', 'A');
  const assistant = createMessage('assistant', 'partial', MODEL);
  assistant.parentUserId = user.id; assistant.completionReason = 'max_tokens';
  chat.messages.push(user, assistant);
  await saveChat(chat, indexedDB);
  const restored = (await loadChats(indexedDB))[0];
  assert.equal(restored.messages[1].completionReason, 'max_tokens');
  assert.equal(CHAT_DB_VERSION, 4);
});

test('only generation runtime controls expose user-side Chinese operation labels', () => {
  for (const [action, label] of [
    ['start_writing', '开始正文'], ['continue_story', '继续故事'], ['continue_incomplete', '继续未完成'],
  ]) {
    const control = createRuntimeControl(action, 'variant');
    assert.equal(isVisibleRuntimeControlMessage(control), true);
    assert.equal(runtimeControlLabel(control), label);
    assert.equal(regenerationRuntimeAction(control), action);
    assert.equal(control.kind, 'runtime-control');
    assert.equal(control.content, '');
  }
  for (const action of ['prepare_story', 'exit_story', 'update_memory', 'view_story_state']) {
    const control = createRuntimeControl(action, 'variant');
    assert.equal(isVisibleRuntimeControlMessage(control), false);
    assert.equal(runtimeControlLabel(control), null);
    assert.equal(regenerationRuntimeAction(control), null);
  }
});

test('continuation availability is deterministic for complete, partial, truncated, empty and active generation states', () => {
  const chat = createChat(MODEL), user = createMessage('user', 'A');
  const assistant = createMessage('assistant', 'B', MODEL); assistant.parentUserId = user.id;
  chat.messages.push(user, assistant);
  assert.equal(continuationAvailability(chat).action, 'continue_story');
  for (const status of ['stopped', 'interrupted', 'error']) {
    assistant.status = status;
    assert.equal(continuationAvailability(chat).action, 'continue_incomplete');
  }
  assistant.status = 'complete'; assistant.completionReason = 'max_tokens';
  assert.equal(continuationAvailability(chat).action, 'continue_incomplete');
  delete assistant.completionReason; assistant.status = 'error'; assistant.content = '';
  assert.equal(continuationAvailability(chat).action, null);
  assistant.content = 'partial';
  assert.equal(continuationAvailability(chat, true).action, null);
});

test('continue_incomplete promotes only the immediate partial and folds successful continuation for later context', () => {
  const chat = createChat(MODEL), userA = createMessage('user', 'A');
  const partialB = createMessage('assistant', 'B partial—', MODEL);
  partialB.parentUserId = userA.id; partialB.status = 'stopped';
  chat.messages.push(userA, partialB);

  const ordinary = createMessage('user', 'ordinary'); ordinary.parentVariantId = partialB.id;
  chat.messages.push(ordinary);
  assert.deepEqual(contextFor(chat, ordinary.id).map(item => item.content), ['ordinary']);
  chat.messages.pop();

  const control = createRuntimeControl('continue_incomplete', partialB.id); chat.messages.push(control);
  assert.deepEqual(contextFor(chat, control.id).map(item => item.content), ['A', 'B partial—']);
  const continuation = createMessage('assistant', 'and then completed.', MODEL);
  continuation.parentUserId = control.id; chat.messages.push(continuation);
  const userD = createMessage('user', 'D'); userD.parentVariantId = continuation.id; chat.messages.push(userD);
  const future = contextFor(chat, userD.id);
  assert.deepEqual(future.map(item => item.role), ['user', 'assistant', 'user']);
  assert.deepEqual(future.map(item => item.content), ['A', 'B partial—\n\nand then completed.', 'D']);
  assert.doesNotMatch(JSON.stringify(future), /继续未完成|continue_incomplete/);
});

test('a second explicit incomplete continuation retains both earlier partial segments', () => {
  const chat = createChat(MODEL), user = createMessage('user', 'A');
  const first = createMessage('assistant', 'B—', MODEL); first.parentUserId = user.id; first.status = 'stopped';
  const controlOne = createRuntimeControl('continue_incomplete', first.id);
  const second = createMessage('assistant', 'C—', MODEL); second.parentUserId = controlOne.id; second.status = 'error';
  const controlTwo = createRuntimeControl('continue_incomplete', second.id);
  chat.messages.push(user, first, controlOne, second, controlTwo);
  assert.deepEqual(contextFor(chat, controlTwo.id).map(item => item.content), ['A', 'B—\n\nC—']);
});

test('continue actions keep the active assistant and append a request-only operational user turn', () => {
  const setupPrompt = '请帮我准备一个适合测试 Story Memory 的故事设定。';
  const setupReply = '已经为你准备好了一段测试设定。';
  const messages = [
    { id: 'u', role: 'user', content: setupPrompt, status: 'complete' },
    { id: 'a', role: 'assistant', content: setupReply, status: 'complete' },
  ];
  for (const action of ['continue_story', 'continue_incomplete']) {
    const result = validatePayload({ model: MODEL, messages, storyRuntime: { mode: 'writing', action } });
    assert.deepEqual(result.contents.map(item => item.role), ['user', 'model', 'user']);
    assert.equal(result.contents[0].parts[0].text, setupPrompt);
    assert.equal(result.contents[1].parts[0].text, setupReply);
    assert.match(result.contents[2].parts[0].text, /immediately above/);
    assert.doesNotMatch(result.contents[2].parts[0].text, /准备.*设定/);
    assert.notEqual(result.contents.at(-1).parts[0].text, setupPrompt);
  }
});

test('regenerating runtime-generated Assistants reuses the original request-scoped action semantics', () => {
  const cases = [
    { action: 'start_writing', status: 'complete', prior: 'Setup answer', instruction: /Begin the formal story now/ },
    { action: 'continue_story', status: 'complete', prior: 'Complete scene.', instruction: /one natural, modest beat/ },
    { action: 'continue_incomplete', status: 'stopped', prior: 'Partial scene—', instruction: /Continue directly from the end/ },
  ];
  for (const item of cases) {
    const chat = createChat(MODEL);
    const user = createMessage('user', 'Premise');
    const prior = createMessage('assistant', item.prior, MODEL);
    prior.parentUserId = user.id; prior.status = item.status;
    const control = createRuntimeControl(item.action, prior.id);
    const generated = createMessage('assistant', 'Generated result', MODEL); generated.parentUserId = control.id;
    chat.messages.push(user, prior, control, generated);
    const parent = chat.messages.find(message => message.id === generated.parentUserId);
    const runtimeAction = regenerationRuntimeAction(parent);
    assert.equal(runtimeAction, item.action);
    const context = contextFor(chat, parent.id, 'all');
    const result = validatePayload({
      model: MODEL, messages: context, storyRuntime: { mode: 'writing', action: runtimeAction },
    });
    assert.equal(result.contents.at(-1).role, 'user');
    if (item.action === 'continue_incomplete') assert.equal(context.at(-1).content, item.prior);
    assert.match(result.config.systemInstruction, item.instruction);
    assert.doesNotMatch(JSON.stringify(result.contents), /开始正文|继续故事|继续未完成/);
  }
});

test('start_writing appends its operational turn while normal sends remain unchanged', () => {
  const messages = [
    { id: 'u', role: 'user', content: '故事发生在雨夜图书馆。', status: 'complete' },
    { id: 'a', role: 'assistant', content: '候选人物可以是图书管理员。', status: 'complete' },
  ];
  const start = validatePayload({ model: MODEL, messages, storyRuntime: { mode: 'writing', action: 'start_writing' } });
  assert.deepEqual(start.contents.map(item => item.role), ['user', 'model', 'user']);
  assert.match(start.contents.at(-1).parts[0].text, /Begin the formal story now/);
  assert.match(start.contents.at(-1).parts[0].text, /do not canonicalize unconfirmed candidates/i);
  assert.equal(start.contents[1].parts[0].text, messages[1].content);

  const normal = validatePayload({ model: MODEL, messages: [messages[0]], storyRuntime: { mode: 'writing' } });
  assert.deepEqual(normal.contents, [{ role: 'user', parts: [{ text: messages[0].content }] }]);
});

test('setup is a request-scoped gate that roleplay instructions and style cannot bypass', () => {
  const result = validatePayload({
    model: MODEL,
    messages: [{ id: 'u', role: 'user', content: '我希望开头是家庭晚餐，再补充人物关系。', status: 'complete' }],
    settings: { systemInstruction: 'Always roleplay in first person and immediately continue the scene.' },
    styleReferences: [{ id: 'style', content: 'I walked into the room and began the scene.' }],
    storyRuntime: { mode: 'setup' },
  });
  const instruction = result.config.systemInstruction;
  assert.match(instruction, /REQUEST-SCOPED OPERATIONAL MODE GATE/);
  assert.match(instruction, /overrides any user-configured system instruction or roleplay tendency/);
  assert.match(instruction, /premise or brainstorming, not permission to start the story/);
  assert.ok(instruction.indexOf('STYLE REFERENCE POLICY') < instruction.indexOf('REQUEST-SCOPED OPERATIONAL MODE GATE'));
  assert.equal(result.contents.at(-1).parts[0].text, '我希望开头是家庭晚餐，再补充人物关系。');
});

test('start_writing may use a valid premise after a stopped setup reply without Story Memory', () => {
  const chat = createChat(MODEL);
  const user = createMessage('user', '补充设定：第一幕发生在家庭晚餐。');
  const stopped = createMessage('assistant', '未完成的候选', MODEL);
  stopped.status = 'stopped'; stopped.parentUserId = user.id;
  chat.messages.push(user, stopped);
  const control = createRuntimeControl('start_writing', stopped.id); chat.messages.push(control);
  const context = contextFor(chat, control.id, 'all');
  assert.deepEqual(context.map(item => item.content), [user.content]);
  const result = validatePayload({ model: MODEL, messages: context, storyRuntime: { mode: 'writing', action: 'start_writing' } });
  assert.equal(result.contents.at(-1).role, 'user');
  assert.equal(result.contents[0].parts[0].text, user.content);
  assert.match(result.contents[0].parts[1].text, /Begin the formal story now/);
  assert.match(result.config.systemInstruction, /Begin the formal story now/);

  const opening = createMessage('assistant', '正式开场。', MODEL);
  opening.parentUserId = control.id; chat.messages.push(opening);
  const next = createMessage('user', '我推开门。'); next.parentVariantId = opening.id; chat.messages.push(next);
  assert.deepEqual(contextFor(chat, next.id, 'all').map(item => item.content), [user.content, opening.content, next.content]);
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

test('start_writing uses the full active setup branch but does not canonize unconfirmed brainstorming', async () => {
  const chat = createChat(MODEL);
  let parentVariantId = null;
  const expected = [];
  for (let index = 1; index <= 6; index++) {
    const user = createMessage('user', index === 6 ? '我确认选择海边，时间改为清晨。' : `用户设定 ${index}`);
    user.parentVariantId = parentVariantId;
    const assistant = createMessage('assistant', index === 5 ? '候选方案：月球基地或海边小镇。' : `助手讨论 ${index}`, MODEL);
    assistant.parentUserId = user.id;
    chat.messages.push(user, assistant); parentVariantId = assistant.id;
    expected.push(user.content, assistant.content);
  }
  const control = createRuntimeControl('start_writing', parentVariantId); chat.messages.push(control);
  assert.deepEqual(contextFor(chat, control.id, 'all').map(item => item.content), expected);
  assert.ok(contextFor(chat, control.id, 10).length < expected.length);

  const instruction = storyRuntimeSystemInstruction('', { mode: 'writing', action: 'start_writing' }, expected.at(-1));
  assert.match(instruction, /entire active setup-branch conversation/);
  assert.match(instruction, /explicitly accepted or confirmed/);
  assert.match(instruction, /never accepted remains only a candidate/);
  assert.match(instruction, /must not become canonical/);
  assert.match(instruction, /user's latest explicit statement/);

  const app = await readFile(new URL('../ui/app.js', import.meta.url), 'utf8');
  assert.match(app, /runtimeAction === 'start_writing' \? 'all' : globalSettings\.contextLimit/);
});

test('normalization ignores malformed runtime transitions without damaging chat data', () => {
  assert.deepEqual(normalizeStoryRuntime({ transitions: [{ id: 'bad', anchorId: null, mode: 'writing', action: 'prepare_story', createdAt: 'bad' }] }), { version: 1, transitions: [] });
  const exited = normalizeStoryRuntime({ transitions: [{ id: 'exit', anchorId: 'branch', mode: 'disabled', action: 'exit_story', createdAt: '2026-09-12T01:00:00Z' }] });
  assert.equal(exited.transitions[0].action, 'exit_story');
});

test('runtime UI is Chinese, compact, mobile-safe, and preserves Phase 4C reasons', async () => {
  const [html, app, css, quality] = await Promise.all([
    readFile(new URL('../ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../ui/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../ui/styles.css', import.meta.url), 'utf8'),
    import('../shared/response-quality.js'),
  ]);
  for (const label of ['故事', '开始构思', '构思中', '开始正文', '正文中', '继续故事', '继续未完成', '退出故事模式']) assert.match(html + app, new RegExp(label));
  assert.deepEqual(quality.REGENERATION_REASON_OPTIONS.map(item => item.id), ['try_again', 'character_off', 'too_repetitive', 'too_fast', 'acted_for_me', 'continuity_issue']);
  assert.match(css, /\.surface-menu\s*\{[^}]*position:\s*fixed[^}]*max-height|\.runtime-menu\s*\{[^}]*max-height:/s);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.surface-menu\s*\{[^}]*env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.runtime-menu button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.story-runtime-control \.(?:small-button|small-button, \.story-runtime-status)[^}]*min-height:\s*44px/s);
});
