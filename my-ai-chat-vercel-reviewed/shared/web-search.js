import createDOMPurify from 'dompurify';

// Chat requests enable this tool only when the caller asks for search.
export const GOOGLE_SEARCH_TOOLS = Object.freeze([{ googleSearch: Object.freeze({}) }]);

const MAX_SOURCES = 8;
const MAX_TITLE = 180;
const MAX_SUGGESTION_HTML = 20000;
const SUGGESTION_TAGS = Object.freeze(['style', 'div', 'span', 'a', 'svg', 'path', 'g', 'title', 'circle', 'rect']);
const SUGGESTION_ATTRS = Object.freeze([
  'href', 'class', 'style', 'target', 'rel', 'xmlns', 'viewBox', 'd', 'fill', 'width', 'height', 'aria-hidden', 'role',
]);

export function sanitizeSearchSuggestionHtml(value, win = globalThis.window) {
  if (typeof value !== 'string') return null;
  const html = value.trim();
  if (!html || html.length > MAX_SUGGESTION_HTML || !win?.document) return null;
  const purify = createDOMPurify(win);
  const clean = purify.sanitize(html, {
    ALLOWED_TAGS: [...SUGGESTION_TAGS],
    ALLOWED_ATTR: [...SUGGESTION_ATTRS],
    ALLOW_DATA_ATTR: false,
    ADD_TAGS: ['style'],
    FORCE_BODY: true,
  });
  const template = win.document.createElement('template');
  template.innerHTML = clean;
  for (const link of template.content.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    let parsed;
    try { parsed = new URL(href); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) link.removeAttribute('href');
    else link.setAttribute('href', parsed.href);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  const result = template.innerHTML.trim();
  return result || null;
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

export function publicGrounding(metadata, win = globalThis.window) {
  if (!metadata || typeof metadata !== 'object') return null;
  const webSources = normalizeWebSources((Array.isArray(metadata.groundingChunks) ? metadata.groundingChunks : []).map(chunk => ({
    title: chunk?.web?.title,
    url: chunk?.web?.uri,
  })));
  const searchSuggestionHtml = sanitizeSearchSuggestionHtml(metadata.searchEntryPoint?.renderedContent, win);
  if (!webSources.length && !searchSuggestionHtml) return null;
  return {
    ...(webSources.length ? { webSources } : {}),
    ...(searchSuggestionHtml ? { searchSuggestionHtml } : {}),
  };
}

export function storedWebSearchFields(record, win = globalThis.window) {
  const webSources = normalizeWebSources(record?.webSources);
  const searchSuggestionHtml = sanitizeSearchSuggestionHtml(record?.searchSuggestionHtml, win);
  return {
    ...(webSources.length ? { webSources } : {}),
    ...(searchSuggestionHtml ? { searchSuggestionHtml } : {}),
  };
}

export function webSearchMarkup(record, escapeHtml, win = globalThis.window) {
  const { webSources = [], searchSuggestionHtml = null } = storedWebSearchFields(record, win);
  const sourceHtml = webSources.length
    ? '<div class="web-sources">' + webSources.map(source =>
      '<a href="' + escapeHtml(source.url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(source.title) + '</a>'
    ).join('') + '</div>'
    : '';
  const suggestionHtml = searchSuggestionHtml
    ? '<div class="search-suggestion-host"><template class="search-suggestion-source">' + searchSuggestionHtml + '</template></div>'
    : '';
  return sourceHtml + suggestionHtml;
}

export function mountSearchSuggestion(host, win = globalThis.window) {
  if (!host || host.shadowRoot) return host?.shadowRoot || null;
  const source = host.querySelector?.('template.search-suggestion-source');
  const clean = sanitizeSearchSuggestionHtml(source?.innerHTML || '', win);
  source?.remove();
  if (!clean || !host.attachShadow) return null;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = clean;
  return root;
}
