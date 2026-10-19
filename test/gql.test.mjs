import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GQL_TIMEOUT_MS,
  GqlClient,
  buildGqlHeaders,
  fetchIntegrityToken,
  parseGqlErrorMessage,
} from '../src/background/gql.js';
import { ERROR_CODES, TwitchApiError } from '../src/shared/errors.js';

const SESSION = {
  token: 'token-1',
  deviceId: 'device-1',
  uuid: 'session-1',
  integrity: { token: 'integrity-1' },
};

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return body; } };
}

function makeClient(handler, extra = {}) {
  const calls = [];
  const client = new GqlClient({
    getSession: async () => SESSION,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return handler(calls.length, JSON.parse(options.body), options);
    },
    logger: { warn: () => {} },
    ...extra,
  });
  return { client, calls };
}

test('buildGqlHeaders builds the web client headers', () => {
  const headers = buildGqlHeaders(SESSION);
  assert.equal(headers['Content-Type'], 'text/plain;charset=UTF-8');
  assert.equal(headers['Client-Id'], 'kimne78kx3ncx6brgo4mv6wki5h1ko');
  assert.equal(headers.Authorization, 'OAuth token-1');
  assert.equal(headers['X-Device-Id'], 'device-1');
  assert.equal(headers['Client-Session-Id'], 'session-1');
  assert.equal(headers['Client-Integrity'], 'integrity-1');

  const anonymous = buildGqlHeaders(SESSION, { auth: false });
  assert.equal(anonymous.Authorization, undefined);
  assert.equal(anonymous['Client-Integrity'], undefined);
});

test('buildGqlHeaders requires a session with a token', () => {
  assert.throws(() => buildGqlHeaders(null), (error) => error.code === ERROR_CODES.AUTH);
  assert.throws(
    () => buildGqlHeaders({ deviceId: 'x' }),
    (error) => error instanceof TwitchApiError && error.code === ERROR_CODES.AUTH,
  );
});

test('request posts the payload and returns JSON', async () => {
  const { client, calls } = makeClient(() => jsonResponse({ data: { ok: true } }));
  const payload = { operationName: 'Test', extensions: { persistedQuery: { version: 1, sha256Hash: 'x' } } };
  const response = await client.request(payload);
  assert.deepEqual(response, { data: { ok: true } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://gql.twitch.tv/gql');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.deepEqual(calls[0].body, payload);
  assert.equal(GQL_TIMEOUT_MS >= 5_000, true);
});

test('request retries with a raw query when the persisted hash rotated', async () => {
  const { client, calls } = makeClient((call) =>
    call === 1
      ? jsonResponse({ errors: [{ message: 'PersistedQueryNotFound' }] })
      : jsonResponse({ data: { ok: true } }),
  );
  const payload = { operationName: 'Old', extensions: { persistedQuery: { version: 1, sha256Hash: 'old' } } };
  const fallback = { operationName: 'Old', query: 'query Old { viewer { id } }', variables: {} };
  const response = await client.request(payload, { rawFallback: fallback });
  assert.deepEqual(response, { data: { ok: true } });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, fallback);
});

test('request refreshes the session once on auth errors', async () => {
  let refreshed = 0;
  let current = SESSION;
  const { client, calls } = makeClient(
    (call) =>
      call === 1
        ? jsonResponse({ error: 'Unauthorized' }, { ok: false, status: 401 })
        : jsonResponse({ data: { ok: true } }),
    {
      getSession: async () => current,
      refreshSession: async () => {
        refreshed += 1;
        current = { ...SESSION, token: 'token-2' };
        return current;
      },
    },
  );
  const response = await client.request({ operationName: 'Test' });
  assert.deepEqual(response, { data: { ok: true } });
  assert.equal(refreshed, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, 'OAuth token-1');
  assert.equal(calls[1].options.headers.Authorization, 'OAuth token-2');
});

test('request relays through a Twitch tab when refresh did not help', async () => {
  let relayedPayload = null;
  const { client } = makeClient(
    () => jsonResponse({ error: 'Unauthorized' }, { ok: false, status: 401 }),
    {
      refreshSession: async () => null,
      relay: async (payload) => {
        relayedPayload = payload;
        return { data: { relayed: true } };
      },
    },
  );
  const payload = { operationName: 'Test' };
  const response = await client.request(payload, { allowRelay: true });
  assert.deepEqual(response, { data: { relayed: true } });
  assert.equal(relayedPayload, payload);
});

test('request maps HTTP and network failures to stable error codes', async () => {
  const { client: rateLimited } = makeClient(() => jsonResponse({}, { ok: false, status: 429 }));
  await assert.rejects(rateLimited.request({ operationName: 'x' }), (error) => {
    assert.equal(error.code, ERROR_CODES.RATE_LIMIT);
    return true;
  });

  const { client: notFound } = makeClient(() => jsonResponse({}, { ok: false, status: 404 }));
  await assert.rejects(notFound.request({ operationName: 'x' }), (error) => error.code === ERROR_CODES.NOT_FOUND);

  const { client: broken } = makeClient(() => ({
    ok: true,
    status: 200,
    async json() {
      throw new Error('bad json');
    },
  }));
  await assert.rejects(broken.request({ operationName: 'x' }), (error) => error.code === ERROR_CODES.PARSE);

  const { client: offline } = makeClient(() => {
    throw new Error('Failed to fetch');
  });
  await assert.rejects(offline.request({ operationName: 'x' }), (error) => error.code === ERROR_CODES.NETWORK);

  const { client: timedOut } = makeClient(
    (call, body, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
    { timeoutMs: 5 },
  );
  await assert.rejects(timedOut.request({ operationName: 'x' }), (error) => error.code === ERROR_CODES.TIMEOUT);
});

test('data() unwraps data and rejects batch responses', async () => {
  const { client } = makeClient(() => jsonResponse({ data: { viewer: { id: '1' } } }));
  assert.deepEqual(await client.data({ operationName: 'x' }), { viewer: { id: '1' } });

  const { client: batchClient } = makeClient(() => jsonResponse([{ data: {} }]));
  await assert.rejects(batchClient.data({ operationName: 'x' }), (error) => error.code === ERROR_CODES.PARSE);
});

test('batch() returns array responses and retries items individually', async () => {
  const payloads = [{ operationName: 'A' }, { operationName: 'B' }];
  const { client, calls } = makeClient((call, body) => {
    if (Array.isArray(body) && call === 1) {
      return jsonResponse([
        { data: { a: 1 } },
        { errors: [{ message: 'PersistedQueryNotFound' }] },
      ]);
    }
    if (Array.isArray(body)) {
      return jsonResponse([{ data: { a: 1 } }, { data: { b: 2 } }]);
    }
    return body.operationName === 'B'
      ? jsonResponse({ data: { b: 2 } })
      : jsonResponse({ data: { a: 1 } });
  });
  const result = await client.batch(payloads);
  assert.equal(result.length, 2);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].body.operationName, 'A');
  assert.equal(calls[2].body.operationName, 'B');

  const { client: empty } = makeClient(() => jsonResponse([]));
  assert.deepEqual(await empty.batch([]), []);
});

test('batch() records a per-item error when a retry fails', async () => {
  const { client } = makeClient((call, body) => {
    if (Array.isArray(body)) {
      return jsonResponse([{ errors: [{ message: 'PersistedQueryNotFound' }] }]);
    }
    return jsonResponse({ errors: [{ message: 'PersistedQueryNotFound' }] });
  });
  const result = await client.batch([{ operationName: 'A' }]);
  assert.equal(result.length, 1);
  assert.match(result[0].errors[0].message, /PersistedQueryNotFound/);
  assert.equal(result[0].data, null);
});

test('parseGqlErrorMessage classifies GraphQL messages', () => {
  assert.equal(parseGqlErrorMessage({ errors: [{ message: 'PersistedQueryNotFound' }] }), ERROR_CODES.NOT_FOUND);
  assert.equal(parseGqlErrorMessage({ errors: [{ message: 'Failed integrity check' }] }), ERROR_CODES.INTEGRITY);
  assert.equal(parseGqlErrorMessage({ errors: [{ message: 'Unauthorized' }] }), ERROR_CODES.AUTH);
  assert.equal(parseGqlErrorMessage({ errors: [{ message: 'Rate limit exceeded' }] }), ERROR_CODES.RATE_LIMIT);
  assert.equal(parseGqlErrorMessage({ errors: [] }), '');
  assert.equal(parseGqlErrorMessage(null), '');
});

test('fetchIntegrityToken mints and validates tokens', async () => {
  let request = null;
  const token = await fetchIntegrityToken({
    session: SESSION,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ token: ' fresh-token ', expiration: 12345, request_id: 'req-1' });
    },
  });
  assert.equal(token.token, 'fresh-token');
  assert.equal(token.expiration, 12345);
  assert.equal(token.requestId, 'req-1');
  assert.equal(token.source, 'minted');
  assert.equal(request.url, 'https://gql.twitch.tv/integrity');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['Client-Id'], 'ue6666qo983tsx6so1t0vnawi233wa');
  assert.equal(request.options.headers.Authorization, 'OAuth token-1');
  assert.equal(request.options.headers['Client-Version'], 'da69d5f2-ac48-4169-9574-48fee4a96513');

  assert.equal(await fetchIntegrityToken({ session: { token: 'x' }, fetchImpl: async () => {
    throw new Error('should not be called');
  } }), null);
  assert.equal(await fetchIntegrityToken({ session: SESSION, fetchImpl: async () => jsonResponse({}, { ok: false, status: 500 }) }), null);
  assert.equal(await fetchIntegrityToken({ session: SESSION, fetchImpl: async () => jsonResponse({ token: '' }) }), null);
  assert.equal(await fetchIntegrityToken({ session: SESSION, fetchImpl: async () => {
    throw new Error('offline');
  } }), null);
});
