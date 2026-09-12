const strings = value => Array.isArray(value)
  ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
  : [];
const unique = values => [...new Set(values)];
const nameOf = character => [character?.name, character?.idOrName]
  .find(value => typeof value === 'string' && value.trim())?.trim() || '';
const sameName = (left, right) => left && right && left.toLocaleLowerCase() === right.toLocaleLowerCase();

export function storyPanelView(snapshot) {
  const memory = snapshot?.memory;
  if (!memory) return null;
  const scene = memory.scene || {}, relationship = memory.relationship || {};
  const presentCharacters = strings(scene.presentCharacters);
  const characters = Array.isArray(memory.characters) ? memory.characters : [];
  const central = characters.find(character => presentCharacters.some(name =>
    sameName(name, character?.name) || sameName(name, character?.idOrName))) || characters[0] || null;
  const centralName = nameOf(central) || presentCharacters[0] || '';
  return {
    centralCharacter: centralName,
    otherCharacters: unique(presentCharacters.filter(name => !sameName(name, centralName))),
    location: typeof scene.location === 'string' ? scene.location : '',
    time: typeof scene.time === 'string' ? scene.time : '',
    sceneState: unique([
      ...strings(scene.relativePositions), ...strings(scene.environmentState), ...strings(scene.importantObjects),
    ]),
    relationshipSummary: typeof relationship.summary === 'string' ? relationship.summary.trim() : '',
    relationshipChanges: strings(relationship.establishedChanges),
    currentState: unique([
      ...strings(central?.currentState), ...strings(central?.observedDisposition),
    ]),
    appearance: unique([
      ...strings(central?.currentClothing), ...strings(central?.visualAnchors),
    ]),
    importantMemories: unique([
      ...strings(memory.importantEvents), ...strings(memory.knownFacts), ...strings(relationship.sharedHistory),
    ]),
    unresolvedThreads: unique([
      ...strings(memory.unresolvedThreads), ...strings(relationship.unresolvedTension),
    ]),
  };
}
