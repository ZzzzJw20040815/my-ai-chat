import { createHash } from 'node:crypto';

export const VERTEX_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const VERTEX_TOKEN_REFRESH_SKEW_MS = 60_000;

const PROJECT_ID = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,20})$/;
const LOCATION = /^(?:global|[a-z][a-z0-9-]{0,30}[a-z0-9])$/;

let cache = null;
let inflight = null;

export function resetVertexAuthForTests() {
  cache = null;
  inflight = null;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function readVertexConfig(env = {}) {
  const projectId = typeof env.VERTEX_PROJECT_ID === 'string' ? env.VERTEX_PROJECT_ID.trim() : '';
  const locationInput = typeof env.VERTEX_LOCATION === 'string' ? env.VERTEX_LOCATION.trim() : '';
  const location = locationInput || 'global';
  if (!projectId) return { ok: false, code: 'VERTEX_CONFIG', message: '服务器尚未配置 Vertex 项目。' };
  if (!PROJECT_ID.test(projectId)) return { ok: false, code: 'VERTEX_CONFIG', message: 'Vertex 项目 ID 无效。' };
  if (!LOCATION.test(location)) return { ok: false, code: 'VERTEX_CONFIG', message: 'Vertex 区域无效。' };
  const raw = env.GOOGLE_CREDENTIALS_JSON;
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, code: 'VERTEX_CONFIG', message: '服务器尚未配置 Vertex 凭据。' };
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { return { ok: false, code: 'VERTEX_CONFIG', message: 'Vertex 凭据不是有效 JSON。' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, code: 'VERTEX_CONFIG', message: 'Vertex 凭据不是有效 JSON。' };
  }
  if (parsed.type !== 'authorized_user') {
    return { ok: false, code: 'VERTEX_CONFIG', message: 'Vertex 凭据必须是 authorized_user。' };
  }
  const clientId = parsed.client_id;
  const clientSecret = parsed.client_secret;
  const refreshToken = parsed.refresh_token;
  if (typeof clientId !== 'string' || !clientId.trim()
    || typeof clientSecret !== 'string' || !clientSecret.trim()
    || typeof refreshToken !== 'string' || !refreshToken.trim()) {
    return { ok: false, code: 'VERTEX_CONFIG', message: 'Vertex 凭据缺少 client_id、client_secret 或 refresh_token。' };
  }
  const cacheKey = createHash('sha256')
    .update([projectId, location, clientId, clientSecret, refreshToken].join('\n'))
    .digest('hex');
  return {
    ok: true, projectId, location, clientId, clientSecret, refreshToken, cacheKey,
  };
}

async function requestToken(config, { fetchImpl, now, timeoutMs }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Vertex 凭据刷新超时。'), { name: 'TimeoutError', code: 'TIMEOUT' })), timeoutMs);
  let response;
  try {
    response = await fetchImpl(VERTEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || error?.code === 'TIMEOUT') {
      throw fail('TIMEOUT', 'Vertex 凭据刷新超时。');
    }
    throw fail('VERTEX_AUTH', 'Vertex 凭据无法刷新。');
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) throw fail('VERTEX_AUTH', 'Vertex 凭据无法刷新。');
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw fail('VERTEX_AUTH', 'Vertex 凭据无法刷新。'); }
  if (!payload || typeof payload.access_token !== 'string' || !payload.access_token) {
    throw fail('VERTEX_AUTH', 'Vertex 凭据无法刷新。');
  }
  const expiresIn = Number(payload.expires_in);
  const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3_600_000;
  const issuedAt = now();
  cache = { key: config.cacheKey, token: payload.access_token, expiresAt: issuedAt + ttl };
  return { accessToken: payload.access_token, projectId: config.projectId, location: config.location, expiresAt: cache.expiresAt };
}

export async function getVertexAccessToken(env, options = {}) {
  const config = readVertexConfig(env);
  if (!config.ok) throw fail(config.code, config.message);
  const now = options.now || (() => Date.now());
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const nowMs = now();
  if (cache && cache.key !== config.cacheKey) cache = null;
  if (cache && cache.expiresAt - VERTEX_TOKEN_REFRESH_SKEW_MS > nowMs) {
    return { accessToken: cache.token, projectId: config.projectId, location: config.location, expiresAt: cache.expiresAt };
  }
  if (inflight?.key === config.cacheKey) return inflight.promise;
  const promise = requestToken(config, { fetchImpl, now, timeoutMs });
  inflight = { key: config.cacheKey, promise };
  try {
    return await promise;
  } finally {
    if (inflight?.promise === promise) inflight = null;
  }
}
