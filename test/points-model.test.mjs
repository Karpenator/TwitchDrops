import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildChannelWatchList,
  claimKey,
  formatPoints,
  isPointsClaimSuccessful,
  normalizeChannelPoints,
  normalizeTrackedChannels,
  totalPoints,
  unwrapGqlData,
} from '../src/shared/points-model.js';
import { MAX_TRACKED_CHANNELS } from '../src/shared/constants.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const payload = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/channel-points.json', import.meta.url)), 'utf8'),
);

test('unwrapGqlData returns data or the payload itself', () => {
  assert.deepEqual(unwrapGqlData({ data: { a: 1 } }), { a: 1 });
  assert.deepEqual(unwrapGqlData({ a: 1 }), { a: 1 });
  assert.deepEqual(unwrapGqlData(null), {});
  assert.deepEqual(unwrapGqlData('nope'), {});
});

test('normalizeChannelPoints parses balance, claim and stream', () => {
  const channel = normalizeChannelPoints(payload, 'shroud', NOW);
  assert.equal(channel.login, 'shroud');
  assert.equal(channel.channelId, '37402112');
  assert.equal(channel.displayName, 'shroud');
  assert.equal(channel.balance, 12450);
  assert.equal(channel.availableClaimId, 'claim-abc');
  assert.equal(channel.multiplier, 1.2);
  assert.equal(channel.isLive, true);
  assert.equal(channel.gameName, 'Rust');
  assert.equal(channel.streamTitle, 'Rust drops');
  assert.equal(channel.updatedAt, NOW);
  assert.ok(channel.avatarUrl.startsWith('https://static-cdn.jtvnw.net/'));
});

test('normalizeChannelPoints handles missing channels and defaults', () => {
  assert.equal(normalizeChannelPoints({ data: {} }, 'x'), null);
  assert.equal(normalizeChannelPoints(null, 'x'), null);
  assert.equal(normalizeChannelPoints({ data: { community: { channel: {} } } }, ''), null);

  const minimal = normalizeChannelPoints(
    { data: { community: { channel: { id: '5', broadcaster: { login: 'Some_One' } } } } },
    '',
    NOW,
  );
  assert.equal(minimal.login, 'some_one');
  assert.equal(minimal.displayName, 'some_one');
  assert.equal(minimal.balance, 0);
  assert.equal(minimal.availableClaimId, '');
  assert.equal(minimal.multiplier, 1);
  assert.equal(minimal.isLive, false);
  assert.equal(minimal.avatarUrl, '');
});

test('normalizeChannelPoints never trusts non-Twitch avatars', () => {
  const channel = normalizeChannelPoints(
    {
      data: {
        community: {
          channel: {
            id: '1',
            broadcaster: { login: 'abc', profileImageURL: 'https://evil.example/a.png' },
            self: { communityPoints: { balance: -10 } },
          },
        },
      },
    },
    'abc',
    NOW,
  );
  assert.equal(channel.avatarUrl, '');
  assert.equal(channel.balance, 0);
});

test('claim helpers', () => {
  assert.equal(claimKey('123', 'abc'), '123::abc');
  assert.equal(isPointsClaimSuccessful({ data: { claimCommunityPoints: { claim: { id: 'x' } } } }), true);
  assert.equal(isPointsClaimSuccessful({ data: {} }), true);
  assert.equal(isPointsClaimSuccessful({ errors: [{ message: 'nope' }] }), false);
  assert.equal(
    isPointsClaimSuccessful({ data: { claimCommunityPoints: { error: { message: 'already claimed' } } } }),
    false,
  );
  assert.equal(isPointsClaimSuccessful(null), false);
});

test('normalizeTrackedChannels dedupes, validates and caps the list', () => {
  const normalized = normalizeTrackedChannels([
    'Some_Channel',
    { login: 'some_channel', addedAt: 1000 },
    '@other',
    'https://www.twitch.tv/third?x=1',
    'directory',
    'a',
    'bad login!',
    '',
    null,
    42,
  ]);
  assert.deepEqual(
    normalized.map((item) => item.login),
    ['some_channel', 'other', 'third'],
  );
  assert.equal(normalized[1].addedAt, 0);

  const many = Array.from({ length: MAX_TRACKED_CHANNELS + 10 }, (_, index) => `chan${index}`);
  assert.equal(normalizeTrackedChannels(many).length, MAX_TRACKED_CHANNELS);
  assert.deepEqual(normalizeTrackedChannels(null), []);
});

test('buildChannelWatchList merges tracked and open channels', () => {
  const watch = buildChannelWatchList({
    tracked: [{ login: 'summit1g', addedAt: 5 }, 'zackrawrr'],
    openLogins: ['summit1g', 'shroud', 'bad login', ''],
  });
  assert.deepEqual(
    watch.map((item) => [item.login, item.tracked, item.open]),
    [
      ['summit1g', true, true],
      ['shroud', false, true],
      ['zackrawrr', true, false],
    ],
  );
  assert.equal(watch[0].addedAt, 5);

  const limited = buildChannelWatchList({
    tracked: ['a1', 'b2', 'c3'],
    openLogins: ['d4', 'e5'],
    max: 2,
  });
  assert.equal(limited.length, 2);
  assert.deepEqual(normalizeTrackedChannels([]), []);
});

test('totalPoints and formatPoints', () => {
  assert.equal(totalPoints({}), 0);
  assert.equal(
    totalPoints({
      a: { balance: 100 },
      b: { balance: 250 },
      c: { balance: 999, error: 'boom' },
      d: null,
    }),
    350,
  );
  assert.equal(formatPoints(12450), '12\u00a0450');
  assert.equal(formatPoints(0), '0');
  assert.equal(formatPoints(-5), '0');
  assert.equal(formatPoints('1234567'), '1\u00a0234\u00a0567');
});
