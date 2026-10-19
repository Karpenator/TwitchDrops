import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FarmService } from '../src/background/farm.js';
import { createDefaultState } from '../src/background/state.js';
import { normalizeCampaign, normalizeCampaignList } from '../src/shared/drops-model.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');

const inventory = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/inventory.json', import.meta.url)), 'utf8'),
).currentUser.inventory;

function memoryStore(initial = createDefaultState()) {
  return {
    state: initial,
    async get() {
      return this.state;
    },
    async update(mutator) {
      const result = await mutator(this.state);
      if (result && typeof result === 'object') this.state = result;
      return this.state;
    },
  };
}

function fakeTabs() {
  const tabs = new Map();
  let nextId = 100;
  const actions = { created: [], updated: [], removed: [] };
  return {
    tabs,
    actions,
    messages: [],
    // Replaced by tests that need content-script answers.
    status: null,
    async sendMessage(tabId, message) {
      this.messages.push({ tabId, message });
      if (message.type === 'FARM_STATUS') return this.status || { ok: false };
      return { ok: true };
    },
    async query() {
      return [...tabs.entries()].map(([id, tab]) => ({ id, url: tab.url }));
    },
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('No tab');
      return { id: tabId, url: tab.url, muted: tab.muted };
    },
    async create({ url, active }) {
      const id = (nextId += 1);
      tabs.set(id, { url, active });
      actions.created.push({ id, url, active });
      return { id, url };
    },
    async update(tabId, patch) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('No tab');
      tabs.set(tabId, { ...tab, ...patch });
      actions.updated.push({ id: tabId, patch });
      return { id: tabId, ...tabs.get(tabId) };
    },
    async remove(tabId) {
      tabs.delete(tabId);
      actions.removed.push(tabId);
    },
  };
}

function streamPayload(login, { viewers = 100, slug = 'rust', name = 'Rust', live = true } = {}) {
  return {
    data: {
      user: live
        ? {
            login,
            displayName: login,
            stream: {
              id: `stream-${login}`,
              viewersCount: viewers,
              game: { displayName: name, slug },
            },
          }
        : { login, displayName: login, stream: null },
    },
  };
}

function fakeGql({ infos = {} } = {}) {
  const calls = { batch: [], data: [], request: [] };
  return {
    calls,
    async batch(payloads) {
      calls.batch.push(payloads);
      return payloads.map((payload) => {
        const login = payload.variables.channel;
        return infos[login] || streamPayload(login);
      });
    },
    async data(payload) {
      calls.data.push(payload);
      const login = payload.variables.channel;
      return infos[login] || streamPayload(login);
    },
    async request(payload) {
      calls.request.push(payload);
      return { data: { game: { streams: { edges: [] } } } };
    },
  };
}

function makeService(t, { store, gql = fakeGql(), tabs = fakeTabs(), dropsRefresh = async () => {} } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const calls = { refresh: 0, notify: [] };
  const service = new FarmService({
    store,
    gql,
    drops: {
      async refresh() {
        calls.refresh += 1;
        return dropsRefresh();
      },
    },
    notify: {
      async show(event) {
        calls.notify.push(event);
      },
    },
    tabsApi: tabs,
    logger: { warn: () => {} },
  });
  return { service, tabs, gql, calls };
}

function farmableCampaign({
  id = 'campaign-farm',
  name = 'Farm campaign',
  gameName = 'Rust',
  gameSlug = 'rust',
  channels = ['shroud', 'summit1g'],
  endAt = '2026-10-22T00:00:00Z',
  requiredMinutes = 120,
  currentMinutes = 30,
  drops = null,
} = {}) {
  return normalizeCampaign(
    {
      id,
      name,
      status: 'ACTIVE',
      startAt: '2026-10-10T00:00:00Z',
      endAt,
      game: { name: gameName, slug: gameSlug },
      allow: {
        isEnabled: true,
        channels: channels.map((login) => ({ login, displayName: login })),
      },
      self: { isAccountConnected: true },
      timeBasedDrops:
        drops ||
        [
          {
            id: `${id}-drop`,
            requiredMinutesWatched: requiredMinutes,
            self: { currentMinutesWatched: currentMinutes },
            benefitEdges: [{ benefit: { name: 'Reward' } }],
          },
        ],
    },
    { userId: 'user-1', now: NOW },
  );
}

function baseState(campaign) {
  const base = createDefaultState();
  return {
    ...base,
    settings: { ...base.settings, farmStrategy: 'top' },
    drops: { ...base.drops, campaigns: [campaign], lastSync: NOW },
  };
}

test('start picks an allowed live channel and opens a muted farm tab', async (t) => {
  const campaign = farmableCampaign();
  const store = memoryStore(baseState(campaign));
  const tabs = fakeTabs();
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud', { viewers: 100 }),
      summit1g: streamPayload('summit1g', { viewers: 500 }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });

  await service.start();

  assert.equal(store.state.settings.autoFarm, true);
  assert.equal(store.state.farm.enabled, true);
  assert.equal(store.state.farm.channelLogin, 'summit1g', 'top strategy picks the biggest stream');
  assert.equal(store.state.farm.campaignId, 'campaign-farm');
  assert.equal(store.state.farm.gameName, 'Rust');
  assert.equal(store.state.farm.error, null);
  assert.equal(tabs.actions.created.length, 1);
  assert.equal(tabs.actions.created[0].url, 'https://www.twitch.tv/summit1g');
  assert.equal(tabs.actions.created[0].active, false);
  assert.equal(store.state.farm.tabId, tabs.actions.created[0].id);
  assert.deepEqual(
    tabs.actions.updated.at(-1).patch,
    { muted: true, autoDiscardable: false },
  );
});

test('a healthy tab is kept and never duplicated', async (t) => {
  const campaign = farmableCampaign();
  const store = memoryStore(baseState(campaign));
  const tabs = fakeTabs();
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud', { viewers: 100 }),
      summit1g: streamPayload('summit1g', { viewers: 500 }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });
  await service.start();
  const created = tabs.actions.created.length;
  const tabId = store.state.farm.tabId;

  await service.tick();
  assert.equal(tabs.actions.created.length, created);
  assert.equal(store.state.farm.tabId, tabId);
  assert.equal(store.state.farm.channelLogin, 'summit1g');
});

test('skip switches to another channel in the same tab', async (t) => {
  const campaign = farmableCampaign();
  const store = memoryStore(baseState(campaign));
  const tabs = fakeTabs();
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud', { viewers: 100 }),
      summit1g: streamPayload('summit1g', { viewers: 500 }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });
  await service.start();
  const tabId = store.state.farm.tabId;
  const updatesBefore = tabs.actions.updated.length;

  const result = await service.skip();
  assert.equal(result.ok, true);
  assert.deepEqual(result.campaigns, ['Farm campaign']);
  assert.equal(store.state.farm.channelLogin, 'shroud');
  assert.equal(store.state.farm.tabId, tabId, 'the same tab is reused');
  assert.equal(tabs.actions.created.length, 1);
  assert.equal(tabs.actions.updated.length, updatesBefore + 2, 'navigate + mute');
  assert.equal(tabs.tabs.get(tabId).url, 'https://www.twitch.tv/shroud');
});

test('stale progress switches channel after the cooldown', async (t) => {
  const campaign = farmableCampaign();
  const store = memoryStore(baseState(campaign));
  const tabs = fakeTabs();
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud', { viewers: 100 }),
      summit1g: streamPayload('summit1g', { viewers: 500 }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });
  await service.start();
  assert.equal(store.state.farm.channelLogin, 'summit1g');

  await store.update((state) => {
    state.farm.lastProgressMark = 30;
    state.farm.lastProgressAt = NOW - 21 * 60_000;
    state.farm.lastSwitchAt = NOW - 21 * 60_000;
    return state;
  });

  await service.tick();
  assert.equal(store.state.farm.channelLogin, 'shroud');
  assert.equal(store.state.farm.lastSwitchAt, NOW);
  assert.equal(store.state.farm.lastProgressAt, NOW);
});

test('a tab on a non-channel Twitch page is navigated back to the channel', async (t) => {
  const campaign = farmableCampaign();
  const store = memoryStore(baseState(campaign));
  const tabs = fakeTabs();
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud', { viewers: 100 }),
      summit1g: streamPayload('summit1g', { viewers: 500 }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });
  await service.start();
  const tabId = store.state.farm.tabId;
  tabs.tabs.set(tabId, { url: 'https://www.twitch.tv/directory', muted: true });

  await service.tick();
  assert.equal(tabs.tabs.get(tabId).url, 'https://www.twitch.tv/summit1g');
});

test('an offline stream causes a new channel to be picked', async (t) => {
  const campaign = farmableCampaign();
  const store = memoryStore(baseState(campaign));
  const tabs = fakeTabs();
  const infos = {
    shroud: streamPayload('shroud', { viewers: 100 }),
    summit1g: streamPayload('summit1g', { viewers: 500 }),
  };
  const gql = fakeGql({ infos });
  const { service } = makeService(t, { store, gql, tabs });
  await service.start();
  assert.equal(store.state.farm.channelLogin, 'summit1g');

  infos.summit1g = streamPayload('summit1g', { live: false });
  await service.tick();
  assert.equal(store.state.farm.channelLogin, 'shroud');
  assert.equal(tabs.actions.created.length, 1);
});

test('stop closes the tab and clears the farm state', async (t) => {
  const campaign = farmableCampaign();
  const store = memoryStore(baseState(campaign));
  const tabs = fakeTabs();
  const { service } = makeService(t, { store, tabs });
  await service.start();
  const tabId = store.state.farm.tabId;

  await service.stop();
  assert.equal(store.state.settings.autoFarm, false);
  assert.equal(store.state.farm.enabled, false);
  assert.equal(store.state.farm.tabId, null);
  assert.deepEqual(tabs.actions.removed, [tabId]);
});

test('closing the farm tab stops the farm and notifies', async (t) => {
  const campaign = farmableCampaign();
  const store = memoryStore(baseState(campaign));
  const tabs = fakeTabs();
  const { service, calls } = makeService(t, { store, tabs });
  await service.start();
  const tabId = store.state.farm.tabId;

  await service.handleTabRemoved(tabId);
  assert.equal(store.state.settings.autoFarm, false);
  assert.equal(store.state.farm.enabled, false);
  assert.equal(store.state.farm.tabId, null);
  assert.match(store.state.farm.error, /закрыта/);
  assert.equal(calls.notify.length, 1);
});

test('no eligible campaign reports an error instead of throwing', async (t) => {
  const base = createDefaultState();
  const store = memoryStore({
    ...base,
    settings: { ...base.settings, autoFarm: true },
    drops: { ...base.drops, campaigns: [], lastSync: NOW },
  });
  const { service, calls } = makeService(t, { store });
  await service.start();
  assert.match(store.state.farm.error, /Нет доступных каналов/);
  assert.equal(calls.refresh, 0, 'drops were synced recently');
});

test('stale drops trigger a refresh before choosing a channel', async (t) => {
  const campaign = farmableCampaign();
  const store = memoryStore({
    ...baseState(campaign),
    drops: { ...baseState(campaign).drops, lastSync: 0 },
    settings: { ...baseState(campaign).settings, autoFarm: true },
  });
  const { service, calls } = makeService(t, { store });
  await service.tick();
  assert.equal(calls.refresh, 1);
  assert.equal(store.state.farm.channelLogin, 'shroud');
});

test('farmable campaign selection ignores unlinked campaigns', async (t) => {
  const raw = structuredClone(inventory.dropCampaignsInProgress);
  raw[0].timeBasedDrops[0].self.currentMinutesWatched = 30;
  const campaigns = normalizeCampaignList(raw, { userId: 'user-1', now: NOW });
  const base = createDefaultState();
  const store = memoryStore({
    ...base,
    settings: { ...base.settings, autoFarm: true },
    drops: { ...base.drops, campaigns, lastSync: NOW },
  });
  const { service } = makeService(t, { store });
  await service.start();
  assert.equal(store.state.farm.channelLogin, 'shroud');
  assert.equal(store.state.farm.campaignId, 'campaign-rust');
});


test('one channel advances every campaign of the same game at once', async (t) => {
  const shared = farmableCampaign({ id: 'rust-a', name: 'Rust: Twitch Drops', endAt: '2026-10-22T00:00:00Z' });
  const extra = farmableCampaign({
    id: 'rust-b',
    name: 'Rust: Prime Rewards',
    channels: ['shroud'],
    endAt: '2026-10-24T00:00:00Z',
    requiredMinutes: 240,
    currentMinutes: 60,
  });
  const state = baseState(shared);
  state.drops.campaigns = [shared, extra];
  const store = memoryStore(state);
  const tabs = fakeTabs();
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud', { viewers: 50 }),
      summit1g: streamPayload('summit1g', { viewers: 900 }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });

  await service.start();

  // summit1g is the "top" channel, but shroud is the only one that advances
  // both campaigns, so overlap wins over viewer count.
  assert.equal(store.state.farm.gameName, 'Rust');
  assert.equal(store.state.farm.gameSlug, 'rust');
  assert.equal(store.state.farm.channelLogin, 'shroud');
  assert.deepEqual(store.state.farm.campaignIds, ['rust-a', 'rust-b']);
  assert.deepEqual(store.state.farm.campaignNames, ['Rust: Twitch Drops', 'Rust: Prime Rewards']);
  assert.equal(store.state.farm.campaignId, 'rust-a', 'the nearest deadline leads the group');
  assert.equal(
    store.state.farm.lastProgressMark,
    30 + 60,
    'watch marks of all simultaneously watched campaigns are tracked',
  );
  assert.equal(tabs.actions.created.length, 1);
});

test('a newly discovered campaign of the same game joins the running group', async (t) => {
  const first = farmableCampaign({ id: 'rust-a' });
  const store = memoryStore(baseState(first));
  const tabs = fakeTabs();
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud', { viewers: 100 }),
      summit1g: streamPayload('summit1g', { viewers: 500 }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });
  await service.start();
  const tabId = store.state.farm.tabId;
  const channel = store.state.farm.channelLogin;
  assert.deepEqual(store.state.farm.campaignIds, ['rust-a']);

  const late = farmableCampaign({
    id: 'rust-late',
    name: 'Rust: Late Campaign',
    channels: ['shroud', 'summit1g'],
    endAt: '2026-10-24T00:00:00Z',
    currentMinutes: 0,
  });
  await store.update((state) => {
    state.drops.campaigns = [...state.drops.campaigns, late];
    return state;
  });
  await service.tick();

  assert.equal(store.state.farm.tabId, tabId, 'the tab is reused');
  assert.equal(store.state.farm.channelLogin, channel);
  assert.deepEqual(store.state.farm.campaignIds.sort(), ['rust-a', 'rust-late']);
  assert.equal(store.state.farm.lastProgressMark, 30 + 0);
});

test('after a game is finished the farm rotates to the next campaign group', async (t) => {
  const rust = farmableCampaign({ id: 'rust-a', name: 'Rust Drops', endAt: '2026-10-21T00:00:00Z' });
  const delta = farmableCampaign({
    id: 'delta-a',
    name: 'Delta Force Rewards',
    gameName: 'Delta Force',
    gameSlug: 'delta-force',
    channels: ['delta_streamer'],
    endAt: '2026-10-27T00:00:00Z',
    requiredMinutes: 60,
    currentMinutes: 0,
  });
  const state = baseState(rust);
  state.drops.campaigns = [rust, delta];
  const store = memoryStore(state);
  const tabs = fakeTabs();
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud'),
      summit1g: streamPayload('summit1g'),
      delta_streamer: streamPayload('delta_streamer', {
        slug: 'delta-force',
        name: 'Delta Force',
      }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });
  await service.start();
  assert.equal(store.state.farm.campaignIds[0], 'rust-a');
  assert.equal(store.state.farm.channelLogin, 'shroud');

  // All Rust drops are claimed: the group is no longer farmable.
  await store.update((current) => {
    current.drops.campaigns = current.drops.campaigns.map((campaign) => {
      if (campaign.id !== 'rust-a') return campaign;
      const drops = campaign.drops.map((drop) => ({
        ...drop,
        isClaimed: true,
        claimable: false,
        currentMinutes: drop.requiredMinutes,
        remainingMinutes: 0,
        progressPct: 100,
        status: 'claimed',
      }));
      return { ...campaign, drops, completed: true, claimableCount: 0, claimedCount: drops.length };
    });
    return current;
  });

  const createdBefore = tabs.actions.created.length;
  await service.tick();

  assert.equal(store.state.farm.channelLogin, 'delta_streamer');
  assert.deepEqual(store.state.farm.campaignIds, ['delta-a']);
  assert.equal(store.state.farm.gameName, 'Delta Force');
  assert.equal(store.state.farm.tabId, tabs.actions.created.length > createdBefore ? tabs.actions.created.at(-1).id : store.state.farm.tabId);
  assert.equal(tabs.tabs.get(store.state.farm.tabId).url, 'https://www.twitch.tv/delta_streamer');
});

test('farmPriority progress starts with the quickest group', async (t) => {
  const soon = farmableCampaign({
    id: 'rust-a',
    endAt: '2026-10-21T00:00:00Z',
    requiredMinutes: 480,
    currentMinutes: 0,
  });
  const quick = farmableCampaign({
    id: 'quick-a',
    gameName: 'Quick Game',
    gameSlug: 'quick-game',
    channels: ['quick_streamer'],
    endAt: '2026-11-05T00:00:00Z',
    requiredMinutes: 30,
    currentMinutes: 0,
  });
  const state = baseState(soon);
  state.drops.campaigns = [soon, quick];
  state.settings.farmPriority = 'progress';
  const store = memoryStore(state);
  const tabs = fakeTabs();
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud'),
      summit1g: streamPayload('summit1g'),
      quick_streamer: streamPayload('quick_streamer', { slug: 'quick-game', name: 'Quick Game' }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });
  await service.start();
  assert.equal(store.state.farm.channelLogin, 'quick_streamer');
  assert.deepEqual(store.state.farm.campaignIds, ['quick-a']);
});

test('skip stays inside the current group when another channel can cover it', async (t) => {
  const rustA = farmableCampaign({ id: 'rust-a', channels: ['shroud'] });
  const rustB = farmableCampaign({
    id: 'rust-b',
    channels: ['summit1g'],
    endAt: '2026-10-24T00:00:00Z',
  });
  const delta = farmableCampaign({
    id: 'delta-a',
    gameName: 'Delta Force',
    gameSlug: 'delta-force',
    channels: ['delta_streamer'],
    endAt: '2026-10-30T00:00:00Z',
  });
  const state = baseState(rustA);
  state.drops.campaigns = [rustA, rustB, delta];
  const store = memoryStore(state);
  const tabs = fakeTabs();
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud', { viewers: 100 }),
      summit1g: streamPayload('summit1g', { viewers: 300 }),
      delta_streamer: streamPayload('delta_streamer', { slug: 'delta-force', name: 'Delta Force' }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });
  await service.start();
  // The "top" strategy picks the busier channel; each one covers one campaign.
  assert.equal(store.state.farm.channelLogin, 'summit1g');
  assert.deepEqual(store.state.farm.campaignIds, ['rust-b']);

  const result = await service.skip();
  assert.equal(result.ok, true);
  assert.equal(store.state.farm.channelLogin, 'shroud');
  assert.equal(store.state.farm.gameName, 'Rust');
  assert.deepEqual(store.state.farm.campaignIds, ['rust-a']);
});


test('a hidden farm tab with background watch off is reported', async (t) => {
  const campaign = farmableCampaign();
  const store = memoryStore(baseState(campaign));
  const tabs = fakeTabs();
  tabs.status = {
    ok: true,
    hidden: true,
    visibility: 'hidden',
    paused: false,
    ended: false,
    guardEnabled: false,
    farm: true,
  };
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud', { viewers: 100 }),
      summit1g: streamPayload('summit1g', { viewers: 500 }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });
  await service.start();
  await service.tick();

  assert.match(store.state.farm.error, /Фоновый просмотр/);
  assert.equal(
    tabs.messages.some((entry) => entry.message.type === 'FARM_RESUME'),
    false,
    'nothing to resume: the player is not paused',
  );
});

test('a paused farm tab is asked to resume and the reason is shown', async (t) => {
  const campaign = farmableCampaign();
  const store = memoryStore(baseState(campaign));
  const tabs = fakeTabs();
  tabs.status = {
    ok: true,
    hidden: true,
    visibility: 'hidden',
    paused: true,
    ended: false,
    guardEnabled: true,
    farm: true,
  };
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud', { viewers: 100 }),
      summit1g: streamPayload('summit1g', { viewers: 500 }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });
  await service.start();
  await service.tick();

  assert.match(store.state.farm.error, /на паузе/);
  assert.equal(
    tabs.messages.some((entry) => entry.message.type === 'FARM_RESUME'),
    true,
    'the content script is told to press play',
  );
});

test('a healthy guarded tab has no error and receives the guard config', async (t) => {
  const campaign = farmableCampaign();
  const store = memoryStore(baseState(campaign));
  const tabs = fakeTabs();
  tabs.status = {
    ok: true,
    hidden: true,
    visibility: 'hidden',
    paused: false,
    ended: false,
    guardEnabled: true,
    farm: true,
  };
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud', { viewers: 100 }),
      summit1g: streamPayload('summit1g', { viewers: 500 }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });
  await service.start();
  await service.tick();

  assert.equal(store.state.farm.error, null);
  const config = tabs.messages.find((entry) => entry.message.type === 'GUARD_CONFIG');
  assert.deepEqual(
    config?.message,
    { type: 'GUARD_CONFIG', enabled: true, farm: true },
    'the farm tab is told to keep playing with the guard on',
  );
});

test('stopping without closing the tab drops the farm flag', async (t) => {
  const campaign = farmableCampaign();
  const store = memoryStore(baseState(campaign));
  const tabs = fakeTabs();
  const gql = fakeGql({
    infos: {
      shroud: streamPayload('shroud', { viewers: 100 }),
      summit1g: streamPayload('summit1g', { viewers: 500 }),
    },
  });
  const { service } = makeService(t, { store, gql, tabs });
  await service.start();
  const tabId = store.state.farm.tabId;
  tabs.messages.length = 0;

  await service.stop({ closeTab: false });

  assert.equal(tabs.tabs.has(tabId), true, 'the user keeps the tab');
  const message = tabs.messages.find(
    (entry) => entry.message.type === 'GUARD_CONFIG' && entry.message.farm === false,
  );
  assert.ok(message, 'the guard must stop silencing the player');
  assert.equal(message.message.enabled, true);
});

function availableDelta(patch = {}) {
  return {
    ...farmableCampaign({
      id: 'delta-available', gameName: 'Delta Force', gameSlug: 'delta-force',
      channels: ['delta_streamer'], currentMinutes: 0, endAt: '2026-10-30T00:00:00Z',
      ...patch,
    }),
    isAvailable: true,
    isInProgress: false,
  };
}

function deltaGql(infos = {}) {
  return fakeGql({ infos: {
    delta_streamer: streamPayload('delta_streamer', { name: 'Delta Force', slug: 'delta-force' }),
    ...infos,
  } });
}

test('a completed inventory game rotates into an unstarted available game in the same tab', async (t) => {
  const rust = farmableCampaign({ id: 'rust-started' });
  const state = baseState(rust);
  state.drops.available = [availableDelta()];
  state.settings.farmAutoSwitch = false; // Completion rotation is not the idle-switch toggle.
  const store = memoryStore(state);
  const { service, tabs } = makeService(t, { store, gql: deltaGql() });
  await service.start();
  const tabId = state.farm.tabId;
  state.drops.campaigns[0] = { ...rust, completed: true };
  await service.tick({ refreshDrops: false });
  assert.equal(state.farm.channelLogin, 'delta_streamer');
  assert.deepEqual(state.farm.campaignIds, ['delta-available']);
  assert.equal(state.farm.tabId, tabId);
  assert.equal(tabs.actions.created.length, 1);
  assert.equal(tabs.tabs.get(tabId).url, 'https://www.twitch.tv/delta_streamer');
  await service.tick();
  assert.deepEqual(state.farm.campaignIds, ['delta-available'], 'available targets survive until inventory catches up');
});

test('an offline highest-priority game cannot block other available games', async (t) => {
  const state = baseState(farmableCampaign({ channels: ['offline_streamer'] }));
  state.drops.available = [availableDelta()];
  const store = memoryStore(state);
  const { service } = makeService(t, { store, gql: deltaGql({ offline_streamer: streamPayload('offline_streamer', { live: false }) }) });
  await service.start();
  assert.equal(state.farm.channelLogin, 'delta_streamer');
  assert.equal(state.farm.error, null);
});

test('fully earned but unclaimed final rewards do not waste more watch time', async (t) => {
  const rust = farmableCampaign();
  const state = baseState(rust);
  state.settings.autoClaimDrops = false;
  state.drops.available = [availableDelta()];
  const { service } = makeService(t, { store: memoryStore(state), gql: deltaGql() });
  await service.start();
  state.drops.campaigns[0] = {
    ...rust, claimableCount: 1, remainingMinutes: 0,
    drops: rust.drops.map((drop) => ({ ...drop, currentMinutes: drop.requiredMinutes, remainingMinutes: 0, claimable: true })),
  };
  await service.tick({ refreshDrops: false });
  assert.equal(state.farm.channelLogin, 'delta_streamer');
  assert.equal(state.drops.campaigns[0].drops[0].isClaimed, false, 'rotation must not turn auto-claim on');
});

test('Play starts the chosen available campaign and overrides automatic priority', async (t) => {
  const state = baseState(farmableCampaign());
  state.drops.available = [availableDelta()];
  const { service, tabs } = makeService(t, { store: memoryStore(state), gql: deltaGql() });
  const result = await service.play('delta-available');
  assert.equal(result.ok, true);
  assert.equal(state.settings.autoFarm, true);
  assert.equal(state.farm.enabled, true);
  assert.equal(state.farm.channelLogin, 'delta_streamer');
  assert.equal(state.farm.campaignId, 'delta-available');
  assert.deepEqual(tabs.actions.updated.at(-1).patch, { muted: true, autoDiscardable: false });
  await service.tick();
  assert.equal(state.farm.campaignId, 'delta-available', 'the next alarm must not undo the selection');
});

test('Play switches an existing farm tab instead of opening a second one', async (t) => {
  const state = baseState(farmableCampaign());
  state.drops.available = [availableDelta()];
  const { service, tabs } = makeService(t, { store: memoryStore(state), gql: deltaGql() });
  await service.start();
  const tabId = state.farm.tabId;
  assert.equal((await service.play('delta-available')).ok, true);
  assert.equal(state.farm.tabId, tabId);
  assert.equal(tabs.actions.created.length, 1);
  assert.equal(tabs.tabs.get(tabId).url, 'https://www.twitch.tv/delta_streamer');
});

test('Play must cover the selected campaign, not just more campaigns of its game', async (t) => {
  const selected = farmableCampaign({ id: 'selected', channels: ['selected_streamer'], endAt: '2026-10-30T00:00:00Z' });
  const state = baseState(farmableCampaign({ id: 'other-a', channels: ['other_streamer'] }));
  state.drops.campaigns.push(farmableCampaign({ id: 'other-b', channels: ['other_streamer'] }));
  state.drops.available = [selected];
  const { service } = makeService(t, { store: memoryStore(state) });
  assert.equal((await service.play('selected')).ok, true);
  assert.equal(state.farm.channelLogin, 'selected_streamer');
  assert.deepEqual(state.farm.campaignIds, ['selected']);
  await service.tick();
  assert.deepEqual(state.farm.campaignIds, ['selected']);
});

test('an unavailable Play target leaves the current farm and settings untouched', async (t) => {
  const state = baseState(farmableCampaign());
  state.drops.available = [availableDelta()];
  const { service, tabs } = makeService(t, { store: memoryStore(state), gql: deltaGql({ delta_streamer: streamPayload('delta_streamer', { live: false }) }) });
  await service.start();
  const before = structuredClone(state.farm);
  const result = await service.play('delta-available');
  assert.equal(result.ok, false);
  assert.match(result.message, /нет подходящих каналов/);
  assert.deepEqual(state.farm, before);
  assert.equal(tabs.actions.created.length, 1);
});

test('Play rejects missing, future, ended, completed and unlinked campaigns without navigation', async (t) => {
  const normal = availableDelta();
  const state = baseState(farmableCampaign());
  state.drops.available = [
    { ...normal, id: 'future', upcoming: true, active: false, startsAt: NOW + 60_000 },
    { ...normal, id: 'ended', endsAt: NOW - 1 },
    { ...normal, id: 'done', completed: true },
    { ...normal, id: 'unlinked', linked: false },
  ];
  const { service, tabs } = makeService(t, { store: memoryStore(state), gql: deltaGql() });
  for (const id of ['missing', 'future', 'ended', 'done', 'unlinked']) {
    assert.equal((await service.play(id)).ok, false, id);
  }
  assert.equal(tabs.actions.created.length, 0);
  assert.equal(state.settings.autoFarm, false);
});

test('Play refreshes old metadata before choosing an allowed channel', async (t) => {
  const hydrated = availableDelta();
  const state = baseState(farmableCampaign());
  state.drops.available = [{ ...hydrated, drops: [], totalDrops: 0, allowedChannels: [] }];
  const { service, calls } = makeService(t, {
    store: memoryStore(state), gql: deltaGql(),
    dropsRefresh: async () => { state.drops.available = [hydrated]; },
  });
  assert.equal((await service.play('delta-available')).ok, true);
  assert.equal(calls.refresh, 1);
  assert.equal(state.farm.channelLogin, 'delta_streamer');
});

test('Play does not fabricate eligibility when reward details are unavailable', async (t) => {
  const state = baseState(farmableCampaign());
  state.drops.available = [{ ...availableDelta(), drops: [], totalDrops: 0 }];
  const { service, calls, tabs } = makeService(t, { store: memoryStore(state), gql: deltaGql() });
  const result = await service.play('delta-available');
  assert.equal(result.ok, false);
  assert.match(result.message, /Не удалось загрузить/);
  assert.equal(calls.refresh, 1);
  assert.equal(tabs.actions.created.length, 0);
  assert.equal(state.settings.autoFarm, false);
});

test('all allowlisted channels are checked, including channels after the old twentieth cutoff', async (t) => {
  const channels = Array.from({ length: 26 }, (_, index) => `allowed_${index}`);
  const infos = Object.fromEntries(channels.map((login, index) => [login, streamPayload(login, { live: index === 25 })]));
  const state = baseState(farmableCampaign({ channels }));
  const gql = fakeGql({ infos });
  const { service } = makeService(t, { store: memoryStore(state), gql });
  await service.start();
  assert.equal(state.farm.channelLogin, 'allowed_25');
  assert.equal(gql.calls.batch.flat().length, 26);
  assert.ok(gql.calls.batch.every((batch) => batch.length <= 10));
});

test('the directory resolves a game name when Twitch omits its slug', async (t) => {
  const state = baseState(farmableCampaign({ gameSlug: '', channels: [] }));
  const gql = fakeGql();
  gql.request = async (payload) => {
    gql.calls.request.push(payload);
    return { data: { game: { slug: 'rust', streams: { edges: [{ node: {
      broadcaster: { login: 'directory_streamer' }, viewersCount: 42,
    } }] } } } };
  };
  const { service } = makeService(t, { store: memoryStore(state), gql });
  await service.start();
  assert.equal(state.farm.channelLogin, 'directory_streamer');
  assert.equal(gql.calls.request[0].variables.name, 'Rust');
  assert.equal(gql.calls.request[0].variables.slug, null);
  assert.match(gql.calls.request[0].query, /game\(slug: \$slug, name: \$name\)/);
});

test('navigation commands are serialized so an alarm cannot undo Play and Stop wins last', async (t) => {
  const state = baseState(farmableCampaign());
  state.drops.available = [availableDelta()];
  const { service, tabs } = makeService(t, { store: memoryStore(state), gql: deltaGql() });
  await service.start();
  await Promise.all([service.tick(), service.play('delta-available')]);
  assert.equal(state.farm.channelLogin, 'delta_streamer');
  assert.equal(tabs.actions.created.length, 1);
  await Promise.all([service.play('campaign-farm'), service.stop()]);
  assert.equal(state.settings.autoFarm, false);
  assert.equal(state.farm.tabId, null);
  assert.equal(tabs.tabs.size, 0);
});

test('remaining campaigns of the current game get a turn before another category', async (t) => {
  const first = farmableCampaign({ id: 'rust-first', channels: ['shroud'] });
  const second = farmableCampaign({ id: 'rust-second', channels: ['summit1g'], endAt: '2026-10-30T00:00:00Z' });
  const state = baseState(first);
  state.drops.campaigns.push(second);
  state.drops.available = [availableDelta({ endAt: '2026-10-21T00:00:00Z' })];
  const { service } = makeService(t, { store: memoryStore(state), gql: deltaGql() });
  await service.play('rust-first');
  state.drops.campaigns[0] = { ...first, completed: true };
  await service.tick({ refreshDrops: false });
  assert.equal(state.farm.campaignId, 'rust-second');
  assert.equal(state.farm.channelLogin, 'summit1g');
});
