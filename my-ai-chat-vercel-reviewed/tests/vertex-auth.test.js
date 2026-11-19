import test from 'node:test';
import assert from 'node:assert/strict';
import { getVertexAccessToken, resetVertexAuthForTests } from '../server/vertex-auth.js';

const SECRET = 'refresh-token-sentinel';
const CLIENT_SECRET = 'client-secret-sentinel';
const baseCredentials = {
  type: 'authorized_user', client_id: 'client-id-sentinel', client_secret: CLIENT_SECRET, refresh_token: SECRET,
};
const envFor = (overrides = {}, credentials = baseCredentials) => ({
  VERTEX_PROJECT_ID: 'vertex-proj', VERTEX_LOCATION: 'global',
  GOOGLE_CREDENTIALS_JSON: JSON.stringify(credentials), ...overrides,
});
const tokenResponse = (token = 'access-token-sentinel', expiresIn = 3600) => Response.json({
  access_token: token, expires_in: expiresIn, token_type: 'Bearer',
});

test('OAuth refresh uses form encoding and does not echo secrets on failure', async () => {
  resetVertexAuthForTests();
  let captured;
  await assert.rejects(getVertexAccessToken(envFor(), {
    now: () => 0,
    fetchImpl: async (url, init) => {
      captured = { url, init, body: init.body };
      return new Response(JSON.stringify({ error: 'invalid_grant', error_description: SECRET + CLIENT_SECRET }), { status: 400 });
    },
  }), error => {
    assert.equal(error.code, 'VERTEX_AUTH');
    assert.equal(String(error.message).includes(SECRET), false);
    assert.equal(String(error.message).includes(CLIENT_SECRET), false);
    return true;
  });
  assert.equal(captured.url, 'https://oauth2.googleapis.com/token');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const params = new URLSearchParams(captured.body);
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(params.get('refresh_token'), SECRET);
});

test('token cache hits, refreshes inside the 60 second window, and merges concurrent refreshes', async () => {
  resetVertexAuthForTests();
  let calls = 0;
  let clock = 1_000_000;
  const fetchImpl = async () => { calls += 1; return tokenResponse('cached-token', 120); };
  const options = { now: () => clock, fetchImpl };
  const first = await getVertexAccessToken(envFor(), options);
  assert.equal(first.accessToken, 'cached-token');
  clock = 1_000_000 + 50_000;
  const hit = await getVertexAccessToken(envFor(), options);
  assert.equal(hit.accessToken, 'cached-token');
  assert.equal(calls, 1);
  clock = 1_000_000 + 70_000;
  const refreshed = await getVertexAccessToken(envFor(), { ...options, fetchImpl: async () => { calls += 1; return tokenResponse('refreshed-token', 3600); } });
  assert.equal(refreshed.accessToken, 'refreshed-token');
  assert.equal(calls, 2);

  resetVertexAuthForTests();
  let pending;
  let concurrentCalls = 0;
  const concurrentFetch = () => {
    concurrentCalls += 1;
    return new Promise(resolve => { pending = resolve; });
  };
  const left = getVertexAccessToken(envFor(), { now: () => 0, fetchImpl: concurrentFetch });
  const right = getVertexAccessToken(envFor(), { now: () => 0, fetchImpl: concurrentFetch });
  await Promise.resolve();
  assert.equal(concurrentCalls, 1);
  pending(tokenResponse('shared-token', 3600));
  const [a, b] = await Promise.all([left, right]);
  assert.equal(a.accessToken, 'shared-token');
  assert.equal(b.accessToken, 'shared-token');
});

test('changed credentials do not reuse the previous token', async () => {
  resetVertexAuthForTests();
  const seen = [];
  const fetchImpl = async (_url, init) => {
    seen.push(new URLSearchParams(init.body).get('refresh_token'));
    return tokenResponse('token-' + seen.length, 3600);
  };
  const first = await getVertexAccessToken(envFor(), { now: () => 0, fetchImpl });
  const second = await getVertexAccessToken(envFor({}, { ...baseCredentials, refresh_token: 'other-refresh-sentinel' }), { now: () => 0, fetchImpl });
  assert.equal(first.accessToken, 'token-1');
  assert.equal(second.accessToken, 'token-2');
  assert.deepEqual(seen, [SECRET, 'other-refresh-sentinel']);
});

test('missing config, invalid JSON, missing fields, and timeouts stay safe', async () => {
  resetVertexAuthForTests();
  await assert.rejects(getVertexAccessToken({}), error => error.code === 'VERTEX_CONFIG' && !String(error.message).includes(SECRET));
  await assert.rejects(getVertexAccessToken(envFor({ GOOGLE_CREDENTIALS_JSON: '{bad ' + SECRET })), error => {
    assert.equal(error.code, 'VERTEX_CONFIG');
    assert.equal(String(error.message).includes(SECRET), false);
    return true;
  });
  await assert.rejects(getVertexAccessToken(envFor({}, { type: 'authorized_user', client_id: 'x' })), error => error.code === 'VERTEX_CONFIG');
  await assert.rejects(getVertexAccessToken(envFor({}, { ...baseCredentials, type: 'service_account' })), error => {
    assert.equal(error.code, 'VERTEX_CONFIG');
    assert.equal(String(error.message).includes(CLIENT_SECRET), false);
    return true;
  });
  await assert.rejects(getVertexAccessToken(envFor(), {
    now: () => 0, timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'TimeoutError';
        reject(error);
      });
    }),
  }), error => error.code === 'TIMEOUT' && !String(error.message).includes(SECRET));
});
