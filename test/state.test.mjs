import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATE_VERSION,
  StateStore,
  addHistory,
  createDefaultState,
  normalizeState,
} from '../src/background/state.js';
import { HISTORY_LIMIT } from '../src/shared/constants.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';

function memoryArea() {
  const data = {};
  return {
    data,
    async get(key) {
      return { [key]: data[key] };
    },
    async set(values) {
      Object.assign(data, structuredClone(values));
    },
    async remove(key) {
      delete data[key];
    },
  };
}

test('createDefaultState has a stable, empty shape', () => {
  const state = createDefaultState();
  assert.equal(state.version, STATE_VERSION);
  assert.deepEqual(state.settings, { ...DEFAULT_SETTINGS });
  assert.equal(state.user, null);
  assert.deepEqual(state.session, { authenticated: false, error: null, checkedAt: 0 });
  assert.deepEqual(state.drops.campaigns, []);
  assert.deepEqual(state.drops.available, []);
  assert.deepEqual(state.points.channels, {});
  assert.deepEqual(state.points.tracked, []);
  assert.equal(state.farm.enabled, false);
  assert.equal(state.farm.tabId, null);
  assert.deepEqual(state.farm.campaignIds, []);
  assert.deepEqual(state.farm.campaignNames, []);
  assert.equal(state.farm.gameSlug, '');
  assert.deepEqual(state.history, []);
  assert.deepEqual(state.stats, { dropsClaimed: 0, pointsBonuses: 0 });
});

test('normalizeState rejects unknown versions and bad roots', () => {
  assert.deepEqual(normalizeState(null), createDefaultState());
  assert.deepEqual(normalizeState('nope'), createDefaultState());
  assert.deepEqual(normalizeState({ version: STATE_VERSION + 1 }), createDefaultState());
});

test('normalizeState repairs every section', () => {
  const state = normalizeState({
    version: STATE_VERSION,
    settings: { autoClaimDrops: 'nope', dropsIntervalMin: 3, autoFarm: true },
    user: { id: 7, login: 'abc' },
    session: { authenticated: 1, error: 5, checkedAt: '123' },
    drops: {
      campaigns: [{ id: 'c1' }, null, 'bad'],
      available: 'nope',
      lastSync: '500',
      error: 'boom',
      claimFailures: { d1: 'failed' },
      lastClaimAt: 10,
    },
    points: {
      channels: {
        shroud: {
          channelId: 123,
          displayName: '',
          balance: '150.7',
          multiplier: 0.5,
          isLive: 1,
          tracked: 'yes',
          bogus: true,
        },
        broken: null,
        '': { balance: 10 },
      },
      tracked: ['summit1g', '@summit1g', 'bad login'],
      lastSync: 42,
      error: null,
      lastClaimAt: 0,
      recentClaims: { '1::a': 123 },
    },
    farm: {
      enabled: 1,
      tabId: '99',
      channelLogin: 'shroud',
      campaignId: 'c1',
      campaignName: 'Rust Drops',
      campaignIds: ['c1', 'c2', 5, ''],
      campaignNames: ['Rust Drops', 'Rust Prime'],
      gameName: 'Rust',
      gameSlug: 'rust',
      lastProgressMark: '55',
    },
    history: [
      { id: 'h1', type: 'points', title: 'Bonus', subtitle: 'shroud', amount: '-5', at: '1' },
      null,
      { type: 'unknown', title: '' },
    ],
    stats: { dropsClaimed: '3', pointsBonuses: -2 },
  });

  assert.equal(state.settings.autoClaimDrops, true);
  assert.equal(state.settings.dropsIntervalMin, 3);
  assert.equal(state.settings.autoFarm, true);
  assert.deepEqual(state.user, { id: '7', login: 'abc', displayName: 'abc' });
  assert.deepEqual(state.session, { authenticated: true, error: null, checkedAt: 123 });

  assert.equal(state.drops.campaigns.length, 1);
  assert.deepEqual(state.drops.available, []);
  assert.equal(state.drops.lastSync, 500);
  assert.equal(state.drops.error, 'boom');

  assert.equal(state.points.channels.shroud.channelId, '123');
  assert.equal(state.points.channels.shroud.displayName, 'shroud');
  assert.equal(state.points.channels.shroud.balance, 151);
  assert.equal(state.points.channels.shroud.multiplier, 1);
  assert.equal(state.points.channels.shroud.isLive, true);
  assert.equal(state.points.channels.shroud.tracked, true, 'any truthy value becomes true');
  assert.equal(Object.hasOwn(state.points.channels.shroud, 'bogus'), false);
  assert.deepEqual(Object.keys(state.points.channels), ['shroud']);
  assert.deepEqual(
    state.points.tracked.map((item) => item.login),
    ['summit1g'],
  );
  assert.equal(state.points.lastSync, 42);

  assert.equal(state.farm.enabled, true);
  assert.equal(state.farm.tabId, 99);
  assert.equal(state.farm.lastProgressMark, 55);
  assert.equal(state.farm.channelDisplayName, '');
  assert.deepEqual(state.farm.campaignIds, ['c1', 'c2']);
  assert.deepEqual(state.farm.campaignNames, ['Rust Drops', 'Rust Prime']);
  assert.equal(state.farm.gameSlug, 'rust');

  // A legacy single-campaign farm becomes a one-element group.
  const legacy = normalizeState({
    version: STATE_VERSION,
    farm: { campaignId: 'old-campaign', campaignName: 'Old campaign' },
  });
  assert.deepEqual(legacy.farm.campaignIds, ['old-campaign']);
  assert.deepEqual(legacy.farm.campaignNames, ['Old campaign']);

  assert.equal(state.history.length, 2);
  assert.deepEqual(state.history[0], {
    id: 'h1',
    type: 'points',
    title: 'Bonus',
    subtitle: 'shroud',
    imageUrl: '',
    amount: 0,
    at: 1,
  });
  assert.equal(state.history[1].type, 'drop');
  assert.equal(state.stats.dropsClaimed, 3);
  assert.equal(state.stats.pointsBonuses, 0);
});

test('addHistory prepends entries and caps the list', () => {
  const state = createDefaultState();
  const first = addHistory(state, { type: 'drop', title: 'Hat', subtitle: 'Game' }, 1000);
  assert.equal(state.history.length, 1);
  assert.equal(first.at, 1000);
  assert.equal(first.type, 'drop');
  assert.match(first.id, /^[a-z0-9]+-[a-f0-9]{8}$/);

  for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
    addHistory(state, { type: 'points', title: `Bonus ${index}` }, 2000 + index);
  }
  assert.equal(state.history.length, HISTORY_LIMIT);
  assert.equal(state.history[0].title, `Bonus ${HISTORY_LIMIT + 4}`);

  addHistory(state, { type: 'nope', title: '', subtitle: null, imageUrl: 5, amount: '7' }, 9999);
  assert.equal(state.history[0].type, 'drop');
  assert.equal(state.history[0].title, 'Награда');
  assert.equal(state.history[0].subtitle, '');
  assert.equal(state.history[0].imageUrl, '');
  assert.equal(state.history[0].amount, 7);
});

test('StateStore loads, persists and serializes concurrent updates', async () => {
  const area = memoryArea();
  const changes = [];
  const store = new StateStore({
    area,
    logger: { warn: () => {} },
    onChange: (state) => changes.push(state.stats.dropsClaimed),
  });

  await store.load();
  assert.deepEqual(await store.get(), createDefaultState());

  const [a, b] = await Promise.all([
    store.update((state) => {
      state.stats.dropsClaimed += 1;
    }),
    store.update((state) => {
      state.stats.pointsBonuses += 2;
      state.points.tracked.push({ login: 'abc', addedAt: 1 });
    }),
  ]);
  assert.equal(a.stats.dropsClaimed, 1);
  assert.equal(b.stats.pointsBonuses, 2);
  assert.equal(b.stats.dropsClaimed, 1);
  assert.deepEqual(changes, [1, 1], 'onChange fires once per persisted update');
  assert.equal(area.data['twitchautopilot:state'].stats.dropsClaimed, 1);
  assert.equal(area.data['twitchautopilot:state'].points.tracked.length, 1);

  await assert.rejects(
    store.update(() => {
      throw new Error('boom');
    }),
    /boom/,
  );
  const recovered = await store.update((state) => {
    state.stats.dropsClaimed = 10;
  });
  assert.equal(recovered.stats.dropsClaimed, 10, 'the queue recovers after a failed mutation');

  await store.flush();
});

test('StateStore tolerates storage failures', async () => {
  const warnings = [];
  const store = new StateStore({
    area: {
      async get() {
        throw new Error('read failed');
      },
      async set() {
        throw new Error('write failed');
      },
    },
    logger: { warn: (...args) => warnings.push(args) },
  });
  const state = await store.get();
  assert.equal(state.version, STATE_VERSION);
  await store.update((draft) => {
    draft.stats.dropsClaimed = 1;
  });
  assert.equal(store.state.stats.dropsClaimed, 1);
  assert.equal(warnings.length, 2);
});


test('StateStore migrates settings from the pre-rename DropPilot key', async () => {
  const area = memoryArea();
  const legacy = createDefaultState();
  legacy.settings.autoFarm = true;
  legacy.settings.backgroundWatch = false;
  legacy.stats.dropsClaimed = 42;
  legacy.history = [
    {
      id: 'h1',
      type: 'drop',
      title: 'Reward',
      subtitle: 'Rust',
      imageUrl: '',
      amount: 1,
      createdAt: 1,
    },
  ];
  area.data['droppilot:state'] = legacy;

  const store = new StateStore({ area, logger: { warn: () => {} } });
  const state = await store.load();

  assert.equal(state.stats.dropsClaimed, 42);
  assert.equal(state.settings.autoFarm, true);
  assert.equal(state.settings.backgroundWatch, false);
  assert.equal(state.history.length, 1);
  assert.ok(area.data['twitchautopilot:state'], 'state is copied to the new key');
  assert.equal(area.data['droppilot:state'], undefined, 'the legacy key is removed');
});

test('StateStore prefers the new key when both exist', async () => {
  const area = memoryArea();
  const legacy = createDefaultState();
  legacy.stats.dropsClaimed = 1;
  area.data['droppilot:state'] = legacy;
  const current = createDefaultState();
  current.stats.dropsClaimed = 7;
  area.data['twitchautopilot:state'] = current;

  const store = new StateStore({ area, logger: { warn: () => {} } });
  const state = await store.load();

  assert.equal(state.stats.dropsClaimed, 7);
  assert.equal(area.data['droppilot:state'].stats.dropsClaimed, 1, 'the legacy key is untouched');
});


test('a stopped farm keeps its null tab id across worker restarts', () => {
  assert.equal(normalizeState(createDefaultState()).farm.tabId, null);
});


test('the manual campaign opt-in survives storage while legacy and malformed states get no opt-in', async () => {
  const area = memoryArea();
  const first = new StateStore({ area });
  await first.load();
  await first.update((state) => { state.farm.manualCampaignId = 'unlinked-campaign'; });
  const restored = new StateStore({ area });
  assert.equal((await restored.load()).farm.manualCampaignId, 'unlinked-campaign');
  assert.equal(normalizeState({ version: STATE_VERSION, farm: {} }).farm.manualCampaignId, null);
  assert.equal(normalizeState({ version: STATE_VERSION, farm: { manualCampaignId: {} } }).farm.manualCampaignId, null);
});
