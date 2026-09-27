export const STORY_RUNTIME_VERSION = 1;
export const STORY_RUNTIME_MODES = Object.freeze(['setup', 'writing']);
export const STORY_STABILITY_LEVELS = Object.freeze(['free', 'balanced', 'strict']);
export const DEFAULT_STORY_STABILITY = 'balanced';
export const STORY_RUNTIME_ACTIONS = Object.freeze([
  'prepare_story', 'start_writing', 'continue_story', 'continue_incomplete',
]);
export const STORY_RUNTIME_TRANSITION_MODES = Object.freeze([...STORY_RUNTIME_MODES, 'disabled']);
export const STORY_RUNTIME_TRANSITION_ACTIONS = Object.freeze(['prepare_story', 'start_writing', 'exit_story']);

const modeSet = new Set(STORY_RUNTIME_MODES);
const stabilitySet = new Set(STORY_STABILITY_LEVELS);
const actionSet = new Set(STORY_RUNTIME_ACTIONS);
const transitionModeSet = new Set(STORY_RUNTIME_TRANSITION_MODES);
const transitionActions = new Set(STORY_RUNTIME_TRANSITION_ACTIONS);

export const isStoryRuntimeMode = value => modeSet.has(value);
export const isStoryRuntimeAction = value => actionSet.has(value);
export const isStoryStability = value => stabilitySet.has(value);
export const normalizeStoryStability = value => isStoryStability(value) ? value : DEFAULT_STORY_STABILITY;

export function normalizeStoryRuntime(value) {
  const transitions = [];
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.transitions)) {
    for (const item of value.transitions) {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.id !== 'string' || !item.id || item.id.length > 256
        || (item.anchorId != null && (typeof item.anchorId !== 'string' || !item.anchorId || item.anchorId.length > 256))
        || !transitionModeSet.has(item.mode) || !transitionActions.has(item.action)
        || (item.action === 'prepare_story' && item.mode !== 'setup')
        || (item.action === 'start_writing' && item.mode !== 'writing')
        || (item.action === 'exit_story' && item.mode !== 'disabled')
        || !Number.isFinite(Date.parse(item.createdAt))) continue;
      transitions.push({
        id: item.id, anchorId: item.anchorId ?? null, mode: item.mode, action: item.action,
        createdAt: new Date(item.createdAt).toISOString(),
      });
    }
  }
  return { version: STORY_RUNTIME_VERSION, stability: normalizeStoryStability(value?.stability), transitions };
}

export function validateStoryRuntimeRequest(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_REQUEST');
  const keys = Object.keys(value);
  if (keys.some(key => !['mode', 'stability', 'action'].includes(key)) || !isStoryRuntimeMode(value.mode)) throw new Error('INVALID_REQUEST');
  if (value.stability !== undefined && !isStoryStability(value.stability)) throw new Error('INVALID_REQUEST');
  const action = value.action ?? null;
  if (action !== null && !isStoryRuntimeAction(action)) throw new Error('INVALID_REQUEST');
  if (action === 'prepare_story' && value.mode !== 'setup') throw new Error('INVALID_REQUEST');
  if (action && action !== 'prepare_story' && value.mode !== 'writing') throw new Error('INVALID_REQUEST');
  return { mode: value.mode, stability: normalizeStoryStability(value.stability), ...(action ? { action } : {}) };
}

const SETUP_POLICY = `STORY RUNTIME — SETUP MODE
REQUEST-SCOPED OPERATIONAL MODE GATE: the user has explicitly chosen to remain in story setup. This gate controls whether formal story narration may begin and, for that decision only, overrides any user-configured system instruction or roleplay tendency that would otherwise start or continue immersive narrative. Keep all compatible identity, factual, safety, character, and style instructions in force.
Until the explicit start_writing runtime action is present: Do not begin formal story prose, first-person protagonist action, roleplay dialogue, or continuous scene events. Treat statements such as “I hope the opening is…”, “add a setting…”, “the character should…”, and “I want the first scene…” as premise or brainstorming, not permission to start the story.
ADAPTIVE ELABORATION: Match the response to the information density and the user's request. For sparse input, make useful low-risk additions that connect environment, relationships, causes, background, and scene logic into one coherent development, without presenting major unknowns as already decided. For detailed input, reduce invention: organize, reconcile, connect, and preserve the user's specifics instead of creatively replacing them. Response length follows the real information need; do not force every setup reply to be brief, exhaustive, heavily sectioned, or list-like.
ONE COHERENT DEVELOPMENT: By default, present the single most natural integrated development, not an A/B/C menu, multiple directions, or a habitual “you can choose” list. Offer only a small number of concise alternatives when the user explicitly requests options, when genuinely incompatible forks cannot be integrated without distorting intent, or when a required key choice cannot safely be made for the user.
AUTHOR-LEVEL SOURCE MATERIAL: Setup may discuss the whole story world, including NPC private thoughts, hidden motives, unrevealed secrets, background causes, future plans, relationships, and world design. This author-level setup knowledge is not automatically knowledge possessed by the first-person protagonist and must remain behind the writing-mode knowledge firewall until revealed through an in-story channel.
Do not habitually end by asking whether to start writing, offering to begin the first chapter, telling the user to click Start Writing, or otherwise pressuring a transition. The App runtime state—not the assistant—controls that decision. End naturally on the current collaborative development unless the user explicitly asks about runtime operation.
Use natural Simplified Chinese by default unless the user clearly requests another language. Avoid translation-like syntax, mechanical repetition, canned acknowledgements, and templated summaries. Keep setup collaborative and coherent, not formal story prose.
If the user explicitly asks to see a sample opening, you may provide one short passage clearly labeled as a non-canonical sample or candidate. Remain in setup mode; the sample does not become an established story fact unless the user later accepts it.`;

const WRITING_POLICY = `STORY RUNTIME — WRITING MODE
FINAL OPERATIONAL ENFORCEMENT: Preserve compatible user-configured instructions, established Story Memory, active-branch facts, and style guidance, but none may weaken the runtime mode gate, knowledge firewall, user agency, or continuity rules below.
KNOWLEDGE FIREWALL / EPISTEMIC BOUNDARY: The first-person protagonist may know only facts obtained through a valid in-story channel: their own past experience, currently observable behavior or environment, heard dialogue, information explicitly told to them, documents or evidence they encountered, established memories, or facts already revealed in the active story. Author-only setup notes, NPC hidden thoughts or motives, future plot plans, unrevealed secrets, and off-screen events the protagonist did not encounter must not become protagonist knowledge merely because they appeared during setup. Never use telepathy or leak a future plan. Observable cues may support a clearly framed suspicion, impression, or uncertainty; never upgrade inference into confirmed hidden fact. Keep the established first-person POV rather than switching to omniscient disclosure.
USER AGENCY: Render actions and dialogue the user explicitly supplied and their immediate physical consequences. NPCs and events may respond naturally, but never decide a new major action, line of dialogue, commitment, relationship decision, emotional conclusion, life decision, or personality turn for the user-controlled protagonist.
NARRATIVE CONTINUITY: Continue only a bounded story beat and leave continuous room for the protagonist to respond. Preserve time, location, relative positions, clothing, held objects, injuries and physical state, established dialogue, relationships, immediate action, and scene causality. Avoid filler scenery, repetitive explanation, habitual summaries, lessons, meta-narration, abrupt time or scene jumps, forced climaxes, and unsupported personality or relationship changes. NPCs may act autonomously only in ways consistent with established identity and relationships.
Use natural Simplified Chinese narration by default unless the user clearly requests another language. Keep it specific, compact, and idiomatic rather than translated, abstract, or template-like.`;

const STABILITY_POLICIES = Object.freeze({
  free: `STORY STABILITY — FREE
Allow more low-risk invention and a somewhat broader—but still bounded—story beat. Fill reasonable ambiguity when it helps momentum, and allow relationships to progress naturally without unsupported jumps. This setting never permits telepathy, acting for the protagonist, contradicting established facts, breaking active-branch truth, or ignoring physical continuity.`,
  balanced: `STORY STABILITY — BALANCED
Use moderate invention, one modest story beat, gradual relationship development, and strong continuity. Fill only reasonable low-risk gaps; ambiguity does not need to be fully resolved. The knowledge firewall, user agency, established facts, active-branch truth, and physical continuity remain hard constraints.`,
  strict: `STORY STABILITY — STRICT
Minimize invention, use a small incremental beat, change relationships slowly, and give continuity the highest priority. Usually leave ambiguity unresolved, keep uncertain implications uncertain, and omit unnecessary invented detail. Still respond naturally and move the immediate scene forward. The knowledge firewall, user agency, established facts, active-branch truth, and physical continuity remain hard constraints.`,
});

const ACTION_GUIDANCE = Object.freeze({
  prepare_story: 'Remain in setup mode. Help clarify the premise briefly; do not start the formal story.',
  start_writing: `Begin the formal story now with one measured opening beat using the entire active setup-branch conversation as context.
Canonicalize only user-stated facts and assistant proposals the user explicitly accepted or confirmed. An assistant brainstorming suggestion the user never accepted remains a candidate and must not become canonical merely because it appeared in context. Resolve conflicts in this order: (1) the user's latest explicit statement, (2) explicitly accepted or confirmed assistant proposals, (3) established Story Memory and active-branch facts, then (4) still-compatible earlier facts. Do not randomly choose an unconfirmed candidate; leave it unspecified when it is not required. Only when an ordinary detail is minimally necessary may the selected Story Stability policy supply a low-risk completion. Use established names without renaming characters.`,
  continue_story: 'Continue the current active branch by one natural, modest beat. Preserve user agency and continuity; do not force a climax, large time jump, scene change, or relationship change.',
  continue_incomplete: 'Continue directly from the end of the current active assistant response. Do not restart, summarize, substantially repeat it, change direction, jump scene, or reset state. Preserve its voice, pacing, POV, characters, time, positions, clothing, and ongoing action.',
});

const ACTION_TURNS = Object.freeze({
  start_writing: 'Begin the formal story now from the active setup branch above. Write one measured opening narrative beat. Treat only user-stated facts and assistant suggestions explicitly accepted by the user as established; do not canonicalize unconfirmed candidates.',
  continue_story: 'Continue the current active story branch from the assistant response immediately above. Write one natural, modest narrative beat. Do not restart setup, summarize, or answer an older user request.',
  continue_incomplete: 'Continue directly from the exact ending of the assistant response immediately above. Do not restart, summarize, repeat the ending, answer an older user request, or change direction.',
});

export function storyRuntimeActionTurn(action) {
  const text = ACTION_TURNS[action];
  return text ? { role: 'user', parts: [{ text }] } : null;
}

export function storyRuntimeSystemInstruction(base, runtime) {
  if (!runtime) return base || '';
  const stability = normalizeStoryStability(runtime.stability);
  const sections = [base || '', runtime.mode === 'setup' ? SETUP_POLICY : WRITING_POLICY, STABILITY_POLICIES[stability]];
  if (runtime.action) sections.push('CURRENT RUNTIME ACTION\n' + ACTION_GUIDANCE[runtime.action]);
  return sections.filter(Boolean).join('\n\n');
}
