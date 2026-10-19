import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clamp,
  formatDuration,
  formatMinutes,
  formatRelative,
  formatTimeLeft,
  isFuture,
  msUntil,
  toTimestamp,
} from '../src/shared/time.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('toTimestamp understands ISO strings, seconds and milliseconds', () => {
  assert.equal(toTimestamp('2026-10-19T12:00:00Z'), Date.parse('2026-10-19T12:00:00Z'));
  assert.equal(toTimestamp(1_760_000_000), 1_760_000_000_000);
  assert.equal(toTimestamp(1_760_000_000_000), 1_760_000_000_000);
  assert.equal(toTimestamp('1760000000'), 1_760_000_000_000);
  assert.equal(toTimestamp(null), null);
  assert.equal(toTimestamp(''), null);
  assert.equal(toTimestamp('not a date'), null);
});

test('clamp keeps values inside the range and defaults to the minimum', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
  assert.equal(clamp(Number.NaN, 0, 10), 0);
});

test('formatDuration renders days, hours and minutes', () => {
  assert.equal(formatDuration(0), '<1 мин');
  assert.equal(formatDuration(30_000), '<1 мин');
  assert.equal(formatDuration(MINUTE), '1 мин');
  assert.equal(formatDuration(45 * MINUTE), '45 мин');
  assert.equal(formatDuration(2 * HOUR), '2 ч');
  assert.equal(formatDuration(2 * HOUR + 15 * MINUTE), '2 ч 15 мин');
  assert.equal(formatDuration(2 * DAY + 4 * HOUR), '2 д 4 ч');
  assert.equal(formatDuration(3 * DAY), '3 д');
  assert.equal(formatDuration(-10), '<1 мин');
});

test('formatMinutes uses the longest sensible unit pair', () => {
  assert.equal(formatMinutes(0), '0 мин');
  assert.equal(formatMinutes(59), '59 мин');
  assert.equal(formatMinutes(60), '1 ч');
  assert.equal(formatMinutes(95), '1 ч 35 мин');
  assert.equal(formatMinutes(24 * 60), '1 д');
  assert.equal(formatMinutes(30 * 60 + 30), '1 д 6 ч');
  assert.equal(formatMinutes(Number.NaN), '0 мин');
});

test('formatTimeLeft is relative to the supplied clock', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  assert.equal(formatTimeLeft(null, now), 'без срока');
  assert.equal(formatTimeLeft(now - 1, now), 'завершено');
  assert.equal(formatTimeLeft(now + 2 * HOUR, now), 'осталось 2 ч');
  assert.equal(formatTimeLeft(now + 90 * MINUTE, now), 'осталось 1 ч 30 мин');
});

test('formatRelative and isFuture/msUntil work on absolute timestamps', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  assert.equal(formatRelative(0, now), 'ещё не синхронизировано');
  assert.equal(formatRelative(now - 5_000, now), 'только что');
  assert.equal(formatRelative(now - 30_000, now), 'меньше минуты назад');
  assert.equal(formatRelative(now - 5 * MINUTE, now), '5 мин назад');
  assert.equal(formatRelative(now - 3 * HOUR, now), '3 ч назад');
  assert.equal(formatRelative(now - 2 * DAY, now), '2 д назад');

  assert.equal(isFuture(now + MINUTE, now), true);
  assert.equal(isFuture(now - MINUTE, now), false);
  assert.equal(isFuture(null, now), false);
  assert.equal(msUntil(now + 1500, now), 1500);
  assert.equal(msUntil(now - 1500, now), 0);
  assert.equal(msUntil(null, now), 0);
});
