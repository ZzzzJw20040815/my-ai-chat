import { DEFAULT_MODEL, mergeModelCatalog, normalizeDiscoveredModel } from '../shared/models.js';

export const MODEL_CATALOG_STORAGE_KEY = 'my-ai-chat-model-catalog';
export const MODEL_CATALOG_SYNC_STORAGE_KEY = 'my-ai-chat-last-model-catalog-sync';
export const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function availableDefaultModel(modelId, catalog) {
  return catalog.has(modelId) ? modelId : DEFAULT_MODEL;
}

function readCache(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(MODEL_CATALOG_STORAGE_KEY) || 'null');
    return parsed?.version === 1 && Array.isArray(parsed.models)
      ? parsed.models.map(normalizeDiscoveredModel).filter(Boolean) : [];
  } catch { return []; }
}

function readSyncTime(storage) {
  try {
    const value = storage.getItem(MODEL_CATALOG_SYNC_STORAGE_KEY);
    return value && Number.isFinite(Date.parse(value)) ? value : null;
  } catch { return null; }
}

export function createModelCatalog({ storage = localStorage, fetcher = fetch, now = () => Date.now() } = {}) {
  let discovered = readCache(storage);
  let syncedAt = readSyncTime(storage);
  let autoAttempted = false;

  const catalog = {
    get models() { return mergeModelCatalog(discovered); },
    get syncedAt() { return syncedAt; },
    has(id) { return catalog.models.some(model => model.id === id); },
    metadata(id) { return catalog.models.find(model => model.id === id) || null; },
    name(id) { return catalog.metadata(id)?.name || id; },
    async refresh({ force = false } = {}) {
      const response = await fetcher(force ? '/api/models?refresh=1' : '/api/models', {
        method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(payload?.models)) throw new Error(payload?.error?.message || 'Could not refresh models.');
      const next = payload.models.map(normalizeDiscoveredModel).filter(Boolean);
      const nextSyncedAt = Number.isFinite(Date.parse(payload.syncedAt)) ? payload.syncedAt : new Date(now()).toISOString();
      discovered = next;
      syncedAt = nextSyncedAt;
      try {
        storage.setItem(MODEL_CATALOG_STORAGE_KEY, JSON.stringify({ version: 1, models: next }));
        storage.setItem(MODEL_CATALOG_SYNC_STORAGE_KEY, nextSyncedAt);
      } catch { /* The live catalog still works when browser persistence is unavailable. */ }
      return catalog.models;
    },
    async autoRefresh() {
      if (autoAttempted) return { attempted: false, reason: 'session' };
      const age = syncedAt ? now() - Date.parse(syncedAt) : Infinity;
      if (age >= 0 && age < MODEL_CATALOG_MAX_AGE_MS) return { attempted: false, reason: 'fresh' };
      autoAttempted = true;
      try {
        await catalog.refresh();
        return { attempted: true, ok: true };
      } catch (error) {
        return { attempted: true, ok: false, error };
      }
    },
  };
  return catalog;
}
