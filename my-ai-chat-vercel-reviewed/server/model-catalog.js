import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import {
  CURATED_MODELS, isAllowedModel, isPersistableModelId, modelDisplayName, modelMetadata, normalizeDiscoveredModel,
} from '../shared/models.js';

export const SERVER_CATALOG_TTL_MS = 15 * 60 * 1000;
const SPECIALIZED_MODEL = /(?:^|-)(?:image|imagen|tts|audio|live|embedding|embed|robotics?|computer-use|deep-research|research|transcription|speech|native-audio|customtools)(?:-|$)/i;

let serverCache = null;
const keyDigest = apiKey => createHash('sha256').update(apiKey).digest('hex');
const cleanText = (value, fallback, limit) => typeof value === 'string' && value.trim()
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
  : fallback;

export function modelIdFromResource(name) {
  if (typeof name !== 'string') return null;
  const id = name.startsWith('models/') ? name.slice('models/'.length) : name;
  return isPersistableModelId(id) ? id : null;
}

export function isChatModel(raw) {
  const id = modelIdFromResource(raw?.name);
  if (!id || SPECIALIZED_MODEL.test(id)) return false;
  return Array.isArray(raw.supportedActions)
    && raw.supportedActions.some(action => typeof action === 'string' && action.toLowerCase() === 'generatecontent');
}

export function sanitizeListedModel(raw) {
  if (!isChatModel(raw)) return null;
  const id = modelIdFromResource(raw.name);
  const maxTemperature = typeof raw.maxTemperature === 'number' && Number.isFinite(raw.maxTemperature) && raw.maxTemperature > 0
    ? raw.maxTemperature : null;
  const topP = typeof raw.topP === 'number' && Number.isFinite(raw.topP) && raw.topP >= 0 && raw.topP <= 1 ? raw.topP : null;
  return normalizeDiscoveredModel({
    id,
    name: cleanText(raw.displayName, modelDisplayName(id), 100),
    description: cleanText(raw.description, 'Automatically discovered Gemini chat model', 180),
    stage: /(?:preview|experimental|exp)(?:-|$)/i.test(id) ? 'preview' : 'stable',
    source: 'discovered',
    capabilities: {
      thinking: raw.thinking === true,
      topK: typeof raw.topK === 'number' && Number.isFinite(raw.topK),
      safetySettings: false,
      // The current UI edits temperature and Top P together, so both must be explicit.
      samplingOverrides: maxTemperature !== null && topP !== null,
      outputTokenLimit: Number.isInteger(raw.outputTokenLimit) && raw.outputTokenLimit > 0 ? raw.outputTokenLimit : null,
      maxTemperature,
      topP,
    },
  });
}

export async function googleListModels(apiKey) {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } });
  const pager = await ai.models.list({ config: { pageSize: 100 } });
  const models = [];
  for await (const model of pager) models.push(model);
  return models;
}

export async function refreshServerCatalog(apiKey, options = {}) {
  const listModels = options.listModels || googleListModels;
  const now = options.now ?? Date.now();
  const models = (await listModels(apiKey)).map(sanitizeListedModel).filter(Boolean);
  serverCache = { key: keyDigest(apiKey), expiresAt: now + SERVER_CATALOG_TTL_MS, models };
  return { models, syncedAt: new Date(now).toISOString() };
}

export async function getServerCatalog(apiKey, options = {}) {
  const now = options.now ?? Date.now(), digest = keyDigest(apiKey);
  if (!options.force && serverCache?.key === digest && serverCache.expiresAt > now) {
    return { models: serverCache.models, syncedAt: new Date(serverCache.expiresAt - SERVER_CATALOG_TTL_MS).toISOString(), cached: true };
  }
  try { return await refreshServerCatalog(apiKey, options); }
  catch (error) {
    if (options.allowStale && serverCache?.key === digest) {
      return { models: serverCache.models, syncedAt: new Date(serverCache.expiresAt - SERVER_CATALOG_TTL_MS).toISOString(), cached: true, stale: true };
    }
    throw error;
  }
}

export async function trustedModelMetadata(modelId, apiKey, options = {}) {
  if (isAllowedModel(modelId)) return modelMetadata(modelId);
  if (!isPersistableModelId(modelId)) return null;
  const catalog = await getServerCatalog(apiKey, { ...options, allowStale: true });
  return catalog.models.find(model => model.id === modelId) || null;
}

export function curatedCatalog() { return CURATED_MODELS; }

export function resetServerCatalogForTests() { serverCache = null; }

function jsonError(code, message, status) {
  return Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

export async function handleModels(request, env, options = {}) {
  if (request.method !== 'GET') return jsonError('INVALID_REQUEST', 'Model catalog request is not valid.', 405);
  const url = new URL(request.url), origin = request.headers.get('origin');
  if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site')
    return jsonError('INVALID_REQUEST', 'Model catalog request is not valid.', 403);
  if ([...url.searchParams].some(([key, value]) => key !== 'refresh' || value !== '1'))
    return jsonError('INVALID_REQUEST', 'Model catalog request is not valid.', 400);
  if (!env.GEMINI_API_KEY?.trim())
    return jsonError('KEY_MISSING', 'Gemini is not configured for this site.', 503);
  try {
    const catalog = await getServerCatalog(env.GEMINI_API_KEY, {
      force: url.searchParams.get('refresh') === '1',
      listModels: options.listModels,
      now: options.now,
    });
    return Response.json({ models: catalog.models, syncedAt: catalog.syncedAt }, {
      headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch {
    return jsonError('CATALOG_UNAVAILABLE', 'Could not refresh models. Existing models are still available.', 502);
  }
}
