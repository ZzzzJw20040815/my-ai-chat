import { GoogleGenAI } from '@google/genai';
import { isAllowedModel, modelMetadata } from '../shared/models.js';
import {
  MAX_OUTPUT_TOKENS_LIMIT, MAX_SYSTEM_INSTRUCTION_LENGTH, SAMPLING_LIMITS, THINKING_LEVELS,
} from '../shared/settings.js';

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_MESSAGES = 100;
export const ERROR_TEXT = Object.freeze({
  KEY_MISSING: '服务器尚未配置 GEMINI_API_KEY。请在 Vercel Project Settings 中将其添加为 Secret，不要发送到聊天中。',
  KEY_INVALID: 'Gemini 凭据无效或没有访问权限，请由 Site Owner 检查 Secret 和 Google 项目。',
  RATE_LIMIT: 'Gemini 请求过于频繁或额度不足（429）。请稍后重试，或检查 Google 项目的配额。',
  MODEL_UNAVAILABLE: '所选 Gemini 模型目前不可用，请切换模型或稍后重试。',
  NETWORK_ERROR: '连接 Gemini 失败，请检查网络后重试。',
  SERVER_ERROR: '服务暂时无法完成请求，请稍后重试。',
  INVALID_REQUEST: '请求格式不正确，或模型不在允许列表中。',
  CONTEXT_LIMIT: '当前对话超过本阶段的长度限制。请新建聊天或缩短消息；未静默丢弃上下文。',
  TIMEOUT: '生成超时，请重试或缩短问题。',
  BLOCKED: 'Gemini 未返回可显示的文本，或此回复被安全机制阻止。请调整问题后重试。',
  TRUNCATED: '回复达到输出长度限制，可继续提问。',
});
const jsonError = (code, status) => Response.json({ error: { code, message: ERROR_TEXT[code] } }, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
export function classifyError(error) {
  const status = Number(error?.status || error?.code);
  if (status === 429) return ['RATE_LIMIT', 429];
  if (status === 401 || status === 403) return ['KEY_INVALID', 502];
  if (status === 404 || status === 400) return ['MODEL_UNAVAILABLE', 502];
  if (error?.name === 'TimeoutError') return ['TIMEOUT', 504];
  if (error instanceof TypeError) return ['NETWORK_ERROR', 502];
  return ['SERVER_ERROR', 502];
}
export function validatePayload(payload) {
  if (!payload || !isAllowedModel(payload.model) || !Array.isArray(payload.messages) || !payload.messages.length)
    throw new Error('INVALID_REQUEST');
  if (payload.messages.length > MAX_MESSAGES) throw new Error('CONTEXT_LIMIT');
  const ids = new Set();
  let total = 0;
  const contents = payload.messages.map((message, index) => {
    if (!message || typeof message.id !== 'string' || !message.id || message.id.length > 100 || ids.has(message.id)
      || message.role !== (index % 2 ? 'assistant' : 'user')
      || typeof message.content !== 'string' || !message.content.trim() || message.status !== 'complete')
      throw new Error('INVALID_REQUEST');
    ids.add(message.id);
    total += message.content.length;
    if (message.content.length > 50000 || total > 150000) throw new Error('CONTEXT_LIMIT');
    return { role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] };
  });
  if (contents.at(-1).role !== 'user') throw new Error('INVALID_REQUEST');
  return { model: payload.model, contents, config: validateGenerationSettings(payload.settings, payload.model) };
}
function invalidRequest() { throw new Error('INVALID_REQUEST'); }
function validNumber(value, limits) {
  return typeof value === 'number' && Number.isFinite(value) && value >= limits.min && value <= limits.max;
}
export function validateGenerationSettings(value, modelId) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidRequest();
  const config = {};
  if ('systemInstruction' in value) {
    if (typeof value.systemInstruction !== 'string' || value.systemInstruction.length > MAX_SYSTEM_INSTRUCTION_LENGTH) invalidRequest();
    if (value.systemInstruction.trim()) config.systemInstruction = value.systemInstruction;
  }
  if ('maxOutputTokens' in value && value.maxOutputTokens !== null) {
    if (!Number.isInteger(value.maxOutputTokens) || value.maxOutputTokens < 1 || value.maxOutputTokens > MAX_OUTPUT_TOKENS_LIMIT) invalidRequest();
    config.maxOutputTokens = value.maxOutputTokens;
  }
  if ('thinkingLevel' in value && value.thinkingLevel !== 'default') {
    if (!THINKING_LEVELS.includes(value.thinkingLevel)) invalidRequest();
    if (!modelMetadata(modelId)?.capabilities.thinkingLevels.includes(value.thinkingLevel)) invalidRequest();
    config.thinkingConfig = { thinkingLevel: value.thinkingLevel.toUpperCase() };
  }
  if ('samplingOverrides' in value) {
    const sampling = value.samplingOverrides;
    if (!sampling || typeof sampling !== 'object' || Array.isArray(sampling) || typeof sampling.enabled !== 'boolean') invalidRequest();
    if (sampling.enabled) {
      if (!validNumber(sampling.temperature, SAMPLING_LIMITS.temperature)
        || !validNumber(sampling.topP, SAMPLING_LIMITS.topP)) invalidRequest();
      config.temperature = sampling.temperature;
      config.topP = sampling.topP;
      if (modelMetadata(modelId)?.capabilities.topK) {
        if (!Number.isInteger(sampling.topK) || !validNumber(sampling.topK, SAMPLING_LIMITS.topK)) invalidRequest();
        config.topK = sampling.topK;
      }
    }
  }
  return config;
}
async function readPayload(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID_REQUEST');
  let bytes = 0, text = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('CONTEXT_LIMIT'); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}
// Server-only SDK; no caller-controlled endpoint, credentials or SDK settings.
export async function googleStream(apiKey, params, signal) {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1beta' } });
  return ai.models.generateContentStream({
    ...params, config: { ...params.config, abortSignal: signal },
  });
}
// Injectable transport is only for unit tests; requests cannot select a mock.
export async function handleChat(request, env, transport = googleStream, timeoutMs = 120000) {
  if (request.method !== 'POST') return jsonError('INVALID_REQUEST', 405);
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site')
    return jsonError('INVALID_REQUEST', 403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return jsonError('INVALID_REQUEST', 415);
  let params;
  try { params = validatePayload(await readPayload(request)); }
  catch (error) {
    return jsonError(error.message === 'CONTEXT_LIMIT' ? 'CONTEXT_LIMIT' : 'INVALID_REQUEST', error.message === 'CONTEXT_LIMIT' ? 413 : 400);
  }
  if (!env.GEMINI_API_KEY?.trim()) return jsonError('KEY_MISSING', 503);
  const abort = new AbortController();
  let timedOut = false, cancelled = false;
  const onDisconnect = () => { cancelled = true; abort.abort(); };
  request.signal.addEventListener('abort', onDisconnect, { once: true });
  if (request.signal.aborted) onDisconnect();
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
  const cleanup = () => { clearTimeout(timer); request.signal.removeEventListener('abort', onDisconnect); };
  const encoder = new TextEncoder();
  const source = new ReadableStream({
    start(controller) {
      const emit = event => { if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
      void (async () => {
        let textLength = 0, finishReason;
        try {
          abort.signal.throwIfAborted();
          emit({ type: 'start' });
          const iterator = await transport(env.GEMINI_API_KEY, params, abort.signal);
          for await (const chunk of iterator) {
            if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
            if (chunk.promptFeedback?.blockReason) throw { code: 'BLOCKED' };
            finishReason = chunk.candidates?.[0]?.finishReason || finishReason;
            const delta = chunk.text;
            if (typeof delta === 'string' && delta) {
              textLength += delta.length;
              if (textLength > 100000) { abort.abort(); throw { code: 'CONTEXT_LIMIT' }; }
              emit({ type: 'delta', text: delta });
            }
          }
          if (finishReason && !['STOP', 'MAX_TOKENS'].includes(finishReason)) throw { code: 'BLOCKED' };
          if (!textLength) throw { code: 'BLOCKED' };
          emit({ type: 'done', notice: finishReason === 'MAX_TOKENS' ? ERROR_TEXT.TRUNCATED : null });
        } catch (error) {
          const code = timedOut ? 'TIMEOUT' : ['BLOCKED', 'CONTEXT_LIMIT'].includes(error?.code) ? error.code : classifyError(error)[0];
          if (!cancelled) emit({ type: 'error', code, message: ERROR_TEXT[code] });
        } finally {
          cleanup();
          try { controller.close(); } catch { /* A cancelled reader is already closed. */ }
        }
      })();
    },
    cancel() { cancelled = true; abort.abort(); cleanup(); },
  });
  const stream = source.pipeThrough(new TransformStream());
  return new Response(stream, { headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  } });
}
