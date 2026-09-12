import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { addAssistantVariant, createChat, createMessage, removeUserDescendants } from '../ui/state.js';
import { applicableStoryMemory, createStoryMemorySnapshot } from '../ui/story-memory.js';
import { storyPanelView } from '../ui/story-panel.js';

const MODEL = 'gemini-3.7-flash';
const memory = (name, location, fact) => ({
  version: 1,
  scene: {
    location, time: 'Evening', presentCharacters: [name, 'Rowan'], relativePositions: ['Across the table'],
    environmentState: ['Rain outside'], importantObjects: ['Sealed letter'],
  },
  characters: [{
    idOrName: name, name, identity: ['Unshown identity'], visualAnchors: ['Silver hairpin'], publicPersona: ['Hidden persona'],
    observedDisposition: ['Visibly tired'], speechFingerprint: [], behavioralTells: [], knownPreferences: ['Secret preference'],
    knownBoundaries: [], currentState: ['Waiting'], currentClothing: ['Dark coat'], relationshipToProtagonist: [],
  }],
  relationship: { summary: 'Trust increased after the meeting.', establishedChanges: ['Agreed to work together'], sharedHistory: ['Met at the station'], unresolvedTension: ['The letter remains unopened'] },
  importantEvents: ['Found the letter'], knownFacts: [fact], unknownOrUnconfirmed: ['Secret motive'], unresolvedThreads: ['Who sent it?'],
});

function branches() {
  const chat = createChat(MODEL);
  const a = createMessage('user', 'A');
  const turn = createMessage('assistant', 'B', MODEL); turn.parentUserId = a.id;
  const b2 = createMessage('assistant', 'B2', MODEL); addAssistantVariant(turn, b2);
  const b = turn.variants[0]; turn.activeVariantId = b.id;
  const c = createMessage('user', 'C'); c.parentVariantId = b.id;
  const d = createMessage('assistant', 'D', MODEL); d.parentUserId = c.id;
  const c2 = createMessage('user', 'C2'); c2.parentVariantId = b2.id;
  const d2 = createMessage('assistant', 'D2', MODEL); d2.parentUserId = c2.id;
  chat.messages.push(a, turn, c, d, c2, d2);
  return { chat, turn, b, b2, c, d, d2 };
}

test('Panel view exposes only established display fields and hides unknown/private inference fields', () => {
  const snapshot = { memory: memory('Mira', 'Library', 'The clock stopped at nine.') };
  const view = storyPanelView(snapshot);
  assert.equal(view.centralCharacter, 'Mira');
  assert.equal(view.location, 'Library');
  assert.deepEqual(view.currentState, ['Waiting', 'Visibly tired']);
  assert.deepEqual(view.appearance, ['Dark coat', 'Silver hairpin']);
  assert.ok(view.importantMemories.includes('The clock stopped at nine.'));
  const visible = JSON.stringify(view);
  assert.ok(!visible.includes('Secret motive'));
  assert.ok(!visible.includes('Hidden persona'));
  assert.ok(!visible.includes('Secret preference'));
  assert.ok(!visible.includes('Unshown identity'));
  assert.equal(storyPanelView(null), null);
});

test('Panel follows active branch, inherits ancestor memory, and never reads sibling memory', () => {
  const { chat, turn, b, b2, d2 } = branches();
  const snapshots = [
    createStoryMemorySnapshot({ chatId: chat.id, anchorId: b.id, memory: memory('Mira', 'Library', 'Branch B'), id: 'ancestor' }),
    createStoryMemorySnapshot({ chatId: chat.id, anchorId: d2.id, memory: memory('Iris', 'Garden', 'Branch B2'), id: 'sibling' }),
  ];
  assert.equal(storyPanelView(applicableStoryMemory(chat, snapshots)).centralCharacter, 'Mira');
  assert.equal(storyPanelView(applicableStoryMemory(chat, snapshots)).location, 'Library');
  turn.activeVariantId = b2.id;
  assert.equal(storyPanelView(applicableStoryMemory(chat, snapshots)).centralCharacter, 'Iris');
  assert.equal(storyPanelView(applicableStoryMemory(chat, snapshots)).location, 'Garden');
});

test('historical edit makes descendant memory unreachable while preserving sibling panel memory', () => {
  const { chat, turn, b2, c, d, d2 } = branches();
  const snapshots = [
    createStoryMemorySnapshot({ chatId: chat.id, anchorId: d.id, memory: memory('Mira', 'Library', 'Pruned'), id: 'pruned' }),
    createStoryMemorySnapshot({ chatId: chat.id, anchorId: d2.id, memory: memory('Iris', 'Garden', 'Sibling'), id: 'kept' }),
  ];
  removeUserDescendants(chat, c.id);
  assert.equal(applicableStoryMemory(chat, snapshots), null);
  turn.activeVariantId = b2.id;
  assert.equal(applicableStoryMemory(chat, snapshots).id, 'kept');
});

test('Story Panel uses existing glass tokens and mobile-safe inline layout', async () => {
  const [css, app] = await Promise.all([
    readFile(new URL('../ui/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../ui/app.js', import.meta.url), 'utf8'),
  ]);
  const panel = css.match(/\.story-panel\s*\{([^}]*)\}/s)?.[1] || '';
  assert.match(panel, /max-width:\s*100%/);
  assert.match(panel, /background:\s*var\(--glass-bg\)/);
  assert.doesNotMatch(panel, /position:\s*(?:fixed|absolute)/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.story-panel-grid\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /\.story-panel-toggle\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/s);
  assert.match(app, /let storyPanelExpanded = !mobile\.matches/);
  assert.match(app, /case 'variant-prev': case 'variant-next':[\s\S]*renderConversation\(\)/);
  assert.match(app, /Could not update story memory\. Your chat was not changed\./);
});
