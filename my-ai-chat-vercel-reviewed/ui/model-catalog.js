import { DEFAULT_MODEL, mergeModelCatalog, normalizeDiscoveredModel } from '../shared/models.js';

export const MODEL_CATALOG_STORAGE_KEY = 'my-ai-chat-model-catalog';
export const MODEL_CATALOG_SYNC_STORAGE_KEY = 'my-ai-chat-last-model-catalog-sync';
export const VERTEX_MODEL_CATALOG_STORAGE_KEY = 'my-ai-chat-model-catalog:vertex';
export const VERTEX_MODEL_CATALOG_SYNC_STORAGE_KEY = 'my-ai-chat-last-model-catalog-sync:vertex';
export const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function storageKeys(channel) {
  return channel === 'vertex'
    ? { models: VERTEX_MODEL_CATALOG_STORAGE_KEY, sync: VERTEX_MODEL_CATALOG_SYNC_STORAGE_KEY }
    : { models: MODEL_CATALOG_STORAGE_KEY, sync: MODEL_CATALOG_SYNC_STORAGE_KEY };
}

export function availableDefaultModel(modelId, catalog) {
  return catalog.has(modelId) ? modelId : DEFAULT_MODEL;
}

function readCache(storage, key) {
  try {
    const parsed = JSON.parse(storage.getItem(key) || 'null');
    return parsed?.version === 1 && Array.isArray(parsed.models)
      ? parsed.models.map(normalizeDiscoveredModel).filter(Boolean) : [];
  } catch { return []; }
}

function readSyncTime(storage, key) {
  try {
    const value = storage.getItem(key);
    return value && Number.isFinite(Date.parse(value)) ? value : null;
  } catch { return null; }
}

export function createModelCatalog({ storage = localStorage, fetcher = fetch, now = () => Date.now() } = {}) {
  let channel = 'ai-studio';
  let serial = 0;
  let discovered = readCache(storage, storageKeys(channel).models);
  let syncedAt = readSyncTime(storage, storageKeys(channel).sync);
  let autoAttempted = false;
  const load = () => {
    const keys = storageKeys(channel);
    discovered = readCache(storage, keys.models);
    syncedAt = readSyncTime(storage, keys.sync);
  };

  const catalog = {
    get models() { return mergeModelCatalog(discovered); },
    get syncedAt() { return syncedAt; },
    get channel() { return channel; },
    has(id) { return catalog.models.some(model => model.id === id); },
    metadata(id) { return catalog.models.find(model => model.id === id) || null; },
    name(id) { return catalog.metadata(id)?.name || id; },
    setChannel(next) {
      if (next !== 'ai-studio' && next !== 'vertex' || next === channel) return false;
      channel = next;
      serial += 1;
      autoAttempted = false;
      load();
      return true;
    },
    async refresh({ force = false } = {}) {
      const requested = channel;
      const ticket = ++serial;
      const url = requested === 'vertex'
        ? (force ? '/api/models?channel=vertex&refresh=1' : '/api/models?channel=vertex')
        : (force ? '/api/models?refresh=1' : '/api/models');
      const response = await fetcher(url, {
        method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin',
      });
      const payload = await response.json().catch(() => null);
      if (ticket !== serial || channel !== requested) return catalog.models;
      if (!response.ok || !Array.isArray(payload?.models)) throw new Error(payload?.error?.message || 'Could not refresh models.');
      const next = payload.models.map(normalizeDiscoveredModel).filter(Boolean);
      const nextSyncedAt = Number.isFinite(Date.parse(payload.syncedAt)) ? payload.syncedAt : new Date(now()).toISOString();
      discovered = next;
      syncedAt = nextSyncedAt;
      const keys = storageKeys(requested);
      try {
        storage.setItem(keys.models, JSON.stringify({ version: 1, models: next }));
        storage.setItem(keys.sync, nextSyncedAt);
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
