// Chat requests enable this tool. The model decides whether a prompt needs a search.
export const GOOGLE_SEARCH_TOOLS = Object.freeze([{ googleSearch: Object.freeze({}) }]);

const MAX_SOURCES = 8;
const MAX_TITLE = 180;
const MAX_SUGGESTION_HTML = 20000;
const UNSAFE_SUGGESTION = /<\s*script|javascript\s*:|data\s*:\s*text\/html|on[a-z]+\s*=|<\s*(?:iframe|object|embed|base|meta|link|form|button|input|textarea|img)\b|data-action\s*=|data-story|data-code-copy/i;

export function safeSearchSuggestionHtml(value) {
  if (typeof value !== 'string') return null;
  const html = value.trim();
  if (!html || html.length > MAX_SUGGESTION_HTML || UNSAFE_SUGGESTION.test(html)) return null;
  return html;
}

export function normalizeWebSources(value) {
  if (!Array.isArray(value)) return [];
  const sources = [];
  const seen = new Set();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rawUrl = typeof item.url === 'string' ? item.url : '';
    let url;
    try { url = new URL(rawUrl); } catch { continue; }
    if (url.protocol !== 'https:' || url.username || url.password) continue;
    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const title = typeof item.title === 'string' && item.title.trim()
      ? item.title.trim().slice(0, MAX_TITLE) : url.hostname;
    sources.push({ title, url: url.href });
    if (sources.length >= MAX_SOURCES) break;
  }
  return sources;
}

export function groundingMetadataFromChunk(chunk) {
  const candidate = chunk?.candidates?.[0]?.groundingMetadata;
  if (candidate && typeof candidate === 'object') return candidate;
  if (chunk?.groundingMetadata && typeof chunk.groundingMetadata === 'object') return chunk.groundingMetadata;
  return null;
}

function groundingScore(metadata) {
  const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks.length : 0;
  const queries = Array.isArray(metadata?.webSearchQueries) ? metadata.webSearchQueries.length : 0;
  return chunks + queries + (metadata?.searchEntryPoint?.renderedContent ? 2 : 0);
}

export function preferGroundingMetadata(current, next) {
  if (!next || typeof next !== 'object') return current || null;
  if (!current) return next;
  return groundingScore(next) >= groundingScore(current) ? next : current;
}

export function publicGrounding(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const webSources = normalizeWebSources((Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : []).map(chunk => ({
    title: chunk?.web?.title,
    url: chunk?.web?.uri,
  })));
  const searchSuggestionHtml = safeSearchSuggestionHtml(metadata.searchEntryPoint?.renderedContent);
  if (!webSources.length && !searchSuggestionHtml) return null;
  return {
    ...(webSources.length ? { webSources } : {}),
    ...(searchSuggestionHtml ? { searchSuggestionHtml } : {}),
  };
}

export function storedWebSearchFields(record) {
  const webSources = normalizeWebSources(record?.webSources);
  const searchSuggestionHtml = safeSearchSuggestionHtml(record?.searchSuggestionHtml);
  return {
    ...(webSources.length ? { webSources } : {}),
    ...(searchSuggestionHtml ? { searchSuggestionHtml } : {}),
  };
}

export function webSearchMarkup(record, escapeHtml) {
  const { webSources = [], searchSuggestionHtml = null } = storedWebSearchFields(record);
  const sourceHtml = webSources.length
    ? '<div class="web-sources">' + webSources.map(source =>
      '<a href="' + escapeHtml(source.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(source.title) + '</a>'
    ).join('') + '</div>'
    : '';
  const suggestionHtml = searchSuggestionHtml ? '<div class="search-suggestion">' + searchSuggestionHtml + '</div>' : '';
  return sourceHtml + suggestionHtml;
}
