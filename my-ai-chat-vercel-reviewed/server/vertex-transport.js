import { isPersistableModelId } from '../shared/models.js';
import { getVertexAccessToken } from './vertex-auth.js';

const ACTIONS = new Set(['generateContent', 'streamGenerateContent']);

export function vertexModelId(model) {
  if (typeof model !== 'string' || !model || model.length > 120) return null;
  const id = model.startsWith('models/') ? model.slice('models/'.length) : model;
  if (id.startsWith('models/') || id.includes('/') || id.includes('\\') || id.includes('..') || id.includes(':') || id.includes('?') || id.includes('#')) return null;
  return isPersistableModelId(id) ? id : null;
}

export function vertexEndpoint({ projectId, location, modelId, action }) {
  if (!ACTIONS.has(action) || !vertexModelId(modelId)) throw new Error('INVALID_REQUEST');
  const project = encodeURIComponent(projectId);
  const region = encodeURIComponent(location);
  const model = encodeURIComponent(modelId);
  const host = location === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${location}-aiplatform.googleapis.com`;
  const query = action === 'streamGenerateContent' ? '?alt=sse' : '';
  return `${host}/v1beta1/projects/${project}/locations/${region}/publishers/google/models/${model}:${action}${query}`;
}

export function vertexRestBody(params) {
  const config = params?.config && typeof params.config === 'object' ? params.config : {};
  const contents = Array.isArray(params?.contents) ? params.contents.map(item => {
    const role = item?.role === 'model' ? 'model' : item?.role === 'user' ? 'user' : null;
    if (!role || !Array.isArray(item.parts)) throw new Error('INVALID_REQUEST');
    return { role, parts: item.parts };
  }) : [];
  const body = { contents };
  if (typeof config.systemInstruction === 'string' && config.systemInstruction) {
    body.systemInstruction = { parts: [{ text: config.systemInstruction }] };
  } else if (config.systemInstruction && typeof config.systemInstruction === 'object') {
    body.systemInstruction = config.systemInstruction;
  }
  const generationConfig = {};
  if (config.maxOutputTokens != null) generationConfig.maxOutputTokens = config.maxOutputTokens;
  if (config.thinkingConfig) generationConfig.thinkingConfig = { thinkingLevel: config.thinkingConfig.thinkingLevel };
  if (config.responseMimeType) generationConfig.responseMimeType = config.responseMimeType;
  if (config.responseJsonSchema) generationConfig.responseJsonSchema = config.responseJsonSchema;
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  if (Array.isArray(config.tools)) body.tools = config.tools;
  if (Array.isArray(config.safetySettings)) body.safetySettings = config.safetySettings;
  return body;
}

function textFromResponse(json) {
  const parts = json?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.filter(part => typeof part?.text === 'string' && part.thought !== true).map(part => part.text).join('');
}

function withText(json) {
  return { ...json, text: textFromResponse(json) };
}

async function* readSse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('VERTEX_UPSTREAM');
  const decoder = new TextDecoder();
  let buffer = '';
  const emit = function* (block) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (!data || data === '[DONE]') continue;
      yield withText(JSON.parse(data));
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n\r?\n/);
    buffer = parts.pop() || '';
    for (const part of parts) yield* emit(part);
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield* emit(buffer);
}

function upstreamError(status) {
  const error = new Error(status === 401 || status === 403 ? 'VERTEX_AUTH' : 'VERTEX_UPSTREAM');
  error.code = error.message;
  error.status = status;
  return error;
}

export async function vertexGenerate(env, params, signal, action, options = {}) {
  const modelId = vertexModelId(params?.model);
  if (!modelId) throw new Error('INVALID_REQUEST');
  const token = await getVertexAccessToken(env, options);
  const url = vertexEndpoint({ projectId: token.projectId, location: token.location, modelId, action });
  const headers = {
    Authorization: `Bearer ${token.accessToken}`,
    'x-goog-user-project': token.projectId,
    'Content-Type': 'application/json',
  };
  const fetchImpl = options.fetchImpl || fetch;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', headers, body: JSON.stringify(vertexRestBody({ ...params, model: modelId })), signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const wrapped = new Error('NETWORK_ERROR');
    wrapped.code = 'NETWORK_ERROR';
    throw wrapped;
  }
  if (!response.ok) throw upstreamError(response.status);
  if (action === 'streamGenerateContent') return readSse(response);
  return withText(await response.json());
}

export function vertexChatStream(env, params, signal, options) {
  return vertexGenerate(env, params, signal, 'streamGenerateContent', options);
}

export function vertexContent(env, params, signal, options) {
  return vertexGenerate(env, params, signal, 'generateContent', options);
}
