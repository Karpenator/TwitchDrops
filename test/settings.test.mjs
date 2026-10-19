import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  FARM_PRIORITIES,
  FARM_STRATEGIES,
  INTERVAL_OPTIONS,
  applySettingsPatch,
  areClaimsEnabled,
  intervalLabel,
  normalizeSettings,
} from '../src/shared/settings.js';

test('normalizeSettings returns the documented defaults', () => {
  assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS });
  assert.deepEqual(normalizeSettings({}), { ...DEFAULT_SETTINGS });
  assert.equal(normalizeSettings(undefined).autoClaimDrops, true);
  assert.equal(normalizeSettings(undefined).autoFarm, false);
});

test('normalizeSettings coerces bad values instead of throwing', () => {
  const settings = normalizeSettings({
    autoClaimDrops: 'yes',
    autoClaimPoints: 0,
    notifyClaims: null,
    dropsIntervalMin: 7,
    pointsIntervalMin: '15',
    autoFarm: true,
    farmMuted: false,
    farmStrategy: 'turbo',
    farmPriority: 'random',
    farmAutoSwitch: 'nope',
  });
  assert.equal(settings.autoClaimDrops, true);
  assert.equal(settings.autoClaimPoints, true);
  assert.equal(settings.notifyClaims, true);
  assert.equal(settings.dropsIntervalMin, DEFAULT_SETTINGS.dropsIntervalMin);
  assert.equal(settings.pointsIntervalMin, 15);
  assert.equal(settings.autoFarm, true);
  assert.equal(settings.farmMuted, false);
  assert.equal(settings.farmStrategy, DEFAULT_SETTINGS.farmStrategy);
  assert.equal(settings.farmPriority, DEFAULT_SETTINGS.farmPriority);
  assert.equal(settings.farmAutoSwitch, true);
  assert.ok(FARM_STRATEGIES.includes(settings.farmStrategy));
  assert.ok(FARM_PRIORITIES.includes(settings.farmPriority));
});

test('every interval option survives normalization', () => {
  for (const minutes of INTERVAL_OPTIONS) {
    const settings = normalizeSettings({ dropsIntervalMin: minutes, pointsIntervalMin: minutes });
    assert.equal(settings.dropsIntervalMin, minutes);
    assert.equal(settings.pointsIntervalMin, minutes);
  }
});

test('farmPriority accepts both documented modes and rejects the rest', () => {
  assert.equal(normalizeSettings({ farmPriority: 'progress' }).farmPriority, 'progress');
  assert.equal(normalizeSettings({ farmPriority: 'deadline' }).farmPriority, 'deadline');
  assert.equal(normalizeSettings({ farmPriority: 'first' }).farmPriority, 'deadline');
  assert.equal(normalizeSettings({}).farmPriority, 'deadline');
  const patched = applySettingsPatch({ farmPriority: 'deadline' }, { farmPriority: 'progress' });
  assert.equal(patched.farmPriority, 'progress');
});

test('applySettingsPatch only accepts known keys', () => {
  const base = normalizeSettings({ autoClaimDrops: false, dropsIntervalMin: 10 });
  const patched = applySettingsPatch(base, {
    autoClaimPoints: false,
    dropsIntervalMin: 2,
    farmStrategy: 'top',
    unknownKey: 'ignored',
    __proto__: { polluted: true },
  });
  assert.equal(patched.autoClaimPoints, false);
  assert.equal(patched.dropsIntervalMin, 2);
  assert.equal(patched.farmStrategy, 'top');
  assert.equal(patched.autoClaimDrops, false, 'untouched values are preserved');
  assert.equal(Object.hasOwn(patched, 'unknownKey'), false);
  assert.equal(Object.hasOwn(patched, 'polluted'), false);
  assert.equal(Object.hasOwn(patched, 'unknownKey'), false);
});

test('applySettingsPatch keeps values valid after a bad patch', () => {
  const patched = applySettingsPatch(DEFAULT_SETTINGS, {
    pointsIntervalMin: 999,
    autoFarm: 'true',
  });
  assert.equal(patched.pointsIntervalMin, DEFAULT_SETTINGS.pointsIntervalMin);
  assert.equal(patched.autoFarm, false);
});

test('areClaimsEnabled and intervalLabel', () => {
  assert.equal(areClaimsEnabled({ autoClaimDrops: false, autoClaimPoints: false }), false);
  assert.equal(areClaimsEnabled({ autoClaimDrops: false, autoClaimPoints: true }), true);
  assert.equal(areClaimsEnabled(undefined), true);
  assert.equal(intervalLabel(1), 'каждую минуту');
  assert.equal(intervalLabel(5), 'каждые 5 мин');
  assert.equal(intervalLabel(0), 'каждую минуту');
  assert.equal(intervalLabel(999), 'каждые 60 мин');
});
