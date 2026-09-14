export const STORY_MEMORY_MAX_BODY_BYTES = 256 * 1024;
export const STORY_MEMORY_MAX_MESSAGES = 100;
export const STORY_MEMORY_MAX_MESSAGE_CHARACTERS = 50000;
export const STORY_MEMORY_MAX_TOTAL_CHARACTERS = 180000;

// Client requests deliberately stay below every server ceiling. The byte check uses
// the actual UTF-8 JSON body and reserves room for a maximum-sized intermediate memory.
export const STORY_MEMORY_SAFE_BODY_BYTES = 200 * 1024;
export const STORY_MEMORY_SAFE_MESSAGES = 80;
export const STORY_MEMORY_SAFE_TOTAL_CHARACTERS = 150000;
export const STORY_MEMORY_MAX_CHUNKS = 12;
