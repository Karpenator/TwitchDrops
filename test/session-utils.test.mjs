import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSession,
  cleanToken,
  decodeCookieValue,
  integrityIsFresh,
  normalizeIntegrityExpiration,
  parseCookieHeader,
  parseDeviceId,
  parseTwilightUser,
  randomHex,
} from '../src/shared/session-utils.js';

const DEVICE_ID = '0123456789abcdef0123456789abcdef';
const NOW = Date.parse('2026-10-19T12:00:00Z');

test('parseCookieHeader finds URL-encoded cookies', () => {
  const header = 'a=1; auth-token=abc%3D%3D; other=2';
  assert.equal(parseCookieHeader(header, 'auth-token'), 'abc==');
  assert.equal(parseCookieHeader(header, 'other'), '2');
  assert.equal(parseCookieHeader(header, 'missing'), null);
  assert.equal(parseCookieHeader(undefined, 'a'), null);
  assert.equal(parseCookieHeader('a=1', 'a.b'), null, 'regex metacharacters are escaped');
});

test('decodeCookieValue and cleanToken strip wrapping quotes', () => {
  assert.equal(decodeCookieValue('hello%20world'), 'hello world');
  assert.equal(decodeCookieValue('bad%zz'), 'bad%zz');
  assert.equal(decodeCookieValue(null), '');
  assert.equal(cleanToken('"abc123"'), 'abc123');
  assert.equal(cleanToken('%22abc123%22'), 'abc123');
  assert.equal(cleanToken(''), '');
  assert.equal(cleanToken(null), '');
});

test('parseTwilightUser reads Twitch session cookies', () => {
  const raw = encodeURIComponent(
    JSON.stringify({ authToken: 'token-1', id: '123', login: 'SomeUser', displayName: 'Some User' }),
  );
  assert.deepEqual(parseTwilightUser(raw), {
    token: 'token-1',
    id: '123',
    login: 'someuser',
    displayName: 'Some User',
  });

  const plain = JSON.stringify({ token: 't', userID: '42', login: 'abc' });
  assert.deepEqual(parseTwilightUser(plain), {
    token: 't',
    id: '42',
    login: 'abc',
    displayName: 'abc',
  });

  assert.equal(parseTwilightUser('not-json'), null);
  assert.equal(parseTwilightUser(''), null);
  assert.equal(parseTwilightUser(null), null);
});

test('parseDeviceId validates uuid-like identifiers', () => {
  assert.equal(parseDeviceId(DEVICE_ID), DEVICE_ID);
  assert.equal(parseDeviceId(encodeURIComponent(DEVICE_ID)), DEVICE_ID);
  assert.equal(parseDeviceId('short'), '');
  assert.equal(parseDeviceId('has spaces in it'), '');
  assert.equal(parseDeviceId(null), '');
});

test('normalizeIntegrityExpiration and integrityIsFresh', () => {
  assert.equal(normalizeIntegrityExpiration(NOW / 1000), NOW);
  assert.equal(normalizeIntegrityExpiration(NOW), NOW);
  assert.equal(normalizeIntegrityExpiration('0'), 0);
  assert.equal(normalizeIntegrityExpiration('nope'), 0);

  assert.equal(integrityIsFresh({ token: 'x', expiresAt: NOW + 5 * 60_000 }, NOW), true);
  assert.equal(integrityIsFresh({ token: 'x', expiresAt: NOW + 30_000 }, NOW), false);
  assert.equal(integrityIsFresh({ token: 'x', expiresAt: 0 }, NOW), true);
  assert.equal(integrityIsFresh({ token: '' }, NOW), false);
  assert.equal(integrityIsFresh(null, NOW), false);
});

test('buildSession combines cookies, device id and fallbacks', () => {
  const session = buildSession({
    authToken: encodeURIComponent('"auth-value"'),
    twilightUser: encodeURIComponent(
      JSON.stringify({ id: '7', login: 'user7', authToken: 'auth-value' }),
    ),
    uniqueId: DEVICE_ID,
    integrity: { token: 'it', expiresAt: NOW + 60_000 },
    now: NOW,
  });
  assert.equal(session.token, 'auth-value');
  assert.equal(session.deviceId, DEVICE_ID);
  assert.equal(session.uuid.length, 32);
  assert.deepEqual(session.user, { id: '7', login: 'user7', displayName: 'user7' });
  assert.equal(session.updatedAt, NOW);
  assert.equal(session.integrity.token, 'it');

  const fallback = buildSession({
    authToken: '',
    twilightUser: null,
    uniqueId: 'bad',
    fallbackDeviceId: DEVICE_ID,
    fallbackUuid: DEVICE_ID,
    now: NOW,
  });
  assert.equal(fallback.token, '');
  assert.equal(fallback.user, null);
  assert.equal(fallback.deviceId, DEVICE_ID);
  assert.equal(fallback.uuid, DEVICE_ID);

  const random = buildSession({ authToken: 'a', twilightUser: null, now: NOW });
  assert.match(random.deviceId, /^[a-f0-9]{32}$/);
  assert.match(random.uuid, /^[a-f0-9]{32}$/);
});

test('randomHex returns lowercase hex of the requested length', () => {
  assert.match(randomHex(8), /^[a-f0-9]{8}$/);
  assert.match(randomHex(32), /^[a-f0-9]{32}$/);
  assert.notEqual(randomHex(32), randomHex(32));
});
