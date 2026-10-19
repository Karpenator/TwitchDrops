import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { createDefaultState } from '../src/background/state.js';
import { normalizeCampaign } from '../src/shared/drops-model.js';
import { ALARMS, STORAGE } from '../src/shared/constants.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');
let workerIndex = 0;

function rawCampaign(id, game, slug, channel) {
  return {
    id, name: `${game} Drops`, status: 'ACTIVE',
    startAt: '2026-10-10T00:00:00Z', endAt: '2026-10-30T00:00:00Z',
    game: { name: game, slug },
    allow: { isEnabled: true, channels: [{ login: channel }] },
    self: { isAccountConnected: true },
    timeBasedDrops: [{
      id: `${id}-reward`, requiredMinutesWatched: 60,
      self: { currentMinutesWatched: id === 'rust' ? 30 : 0, isClaimed: false },
    }],
  };
}

function area(initial) {
  const entries = structuredClone(initial);
  return {
    entries,
    async get(key) { return { [key]: structuredClone(entries[key]) }; },
    async set(patch) { Object.assign(entries, structuredClone(patch)); },
    async remove(key) { delete entries[key]; },
  };
}

async function makeWorker(t, { autoClaimDrops = true, cachedDelta = {} } = {}) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
  const rust = rawCampaign('rust', 'Rust', 'rust', 'rust_streamer');
  const delta = rawCampaign('delta', 'Delta Force', 'delta-force', 'delta_streamer');
  const initial = createDefaultState();
  initial.user = { id: 'viewer-id', login: 'viewer', displayName: 'Viewer' };
  initial.session.authenticated = true;
  initial.settings.autoClaimDrops = autoClaimDrops;
  initial.settings.notifyClaims = false;
  initial.settings.farmStrategy = 'top';
  initial.drops.lastSync = NOW;
  initial.drops.campaigns = [normalizeCampaign(rust, { now: NOW, userId: 'viewer-id' })];
  initial.drops.available = [{ ...normalizeCampaign(delta, { now: NOW, userId: 'viewer-id' }), isAvailable: true, isInProgress: false, ...cachedDelta }];
  const local = area({ [STORAGE.state]: initial });
  const session = area({ [STORAGE.session]: {
    token: 'test-token', deviceId: 'test-device', uuid: 'test-session', user: initial.user,
    integrity: { token: 'test-integrity', expiresAt: NOW + 86_400_000 },
  } });
  const listeners = {};
  const alarms = new Map();
  const tabs = new Map();
  const gqlCalls = [];
  const api = { deltaLive: true, rustLive: true, deltaDetailsMissing: false, streamGate: null };
  let nextTabId = 100;
  const chrome = {
    storage: { local, session },
    cookies: { async get() { return null; } },
    runtime: {
      onMessage: { addListener(listener) { listeners.message = listener; } },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      async sendMessage() {},
      getURL: (path) => `chrome-extension://test/${path}`,
    },
    alarms: {
      onAlarm: { addListener(listener) { listeners.alarm = listener; } },
      async create(name, config) { alarms.set(name, config); },
      async clear(name) { alarms.delete(name); },
    },
    action: { async setBadgeBackgroundColor() {}, async setBadgeText() {}, async setTitle() {} },
    notifications: { onClicked: { addListener() {} }, onClosed: { addListener() {} } },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener(listener) { listeners.tabUpdated = listener; } },
      async query() { return [...tabs.values()]; },
      async get(id) {
        if (!tabs.has(id)) throw new Error('Tab not found');
        return tabs.get(id);
      },
      async create(patch) {
        const tab = { ...patch, id: ++nextTabId };
        tabs.set(tab.id, tab);
        return tab;
      },
      async update(id, patch) { Object.assign(await this.get(id), patch); },
      async remove(id) { tabs.delete(id); },
      async sendMessage() { return { ok: true, paused: false, guardEnabled: true }; },
    },
  };
  const previousChrome = globalThis.chrome;
  globalThis.chrome = chrome;
  t.after(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });

  async function respond(payload) {
    gqlCalls.push(payload);
    switch (payload.operationName) {
      case 'Inventory':
        return { data: { currentUser: { inventory: { dropCampaignsInProgress: [structuredClone(rust)] } } } };
      case 'ViewerDropsDashboard':
        return { data: { currentUser: { dropCampaigns: [rust, delta].map(({ timeBasedDrops, self, allow, ...metadata }) => metadata) } } };
      case 'DropCampaignDetails':
        return { data: { user: { dropCampaign: payload.variables.dropID === 'delta' && api.deltaDetailsMissing
          ? null : structuredClone(payload.variables.dropID === 'rust' ? rust : delta) } } };
      case 'VideoPlayerStreamInfoOverlayChannel': {
        const login = payload.variables.channel;
        if (api.streamGate) await api.streamGate(login);
        const live = login === 'rust_streamer' ? api.rustLive : login !== 'delta_streamer' || api.deltaLive;
        return { data: { user: { login, displayName: login, stream: live ? {
          id: `stream-${login}`, game: login === 'rust_streamer' ? rust.game : delta.game, viewersCount: 100,
        } : null } } };
      }
      case 'DropsPage_ClaimDropRewards': {
        const id = payload.variables.input.dropInstanceID;
        const campaign = id.includes('#rust#') ? rust : delta;
        campaign.timeBasedDrops[0].self.isClaimed = true;
        return { data: { claimDropRewards: { status: 'SUCCESS' } } };
      }
      default:
        throw new Error(`Unexpected query ${payload.operationName}`);
    }
  }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const payload = JSON.parse(options.body);
    const body = Array.isArray(payload) ? await Promise.all(payload.map(respond)) : await respond(payload);
    return { ok: true, status: 200, async json() { return body; } };
  });
  // Each test gets a fresh worker closure, while exercising the real services.
  await import(`../src/background/service-worker.js?test=${workerIndex++}`);
  const send = (message, sender = {}) => new Promise((resolve) => {
    listeners.message(message, sender, (response) => resolve(structuredClone(response)));
  });
  await send({ type: 'GET_STATE' });
  return { send, listeners, alarms, tabs, rust, delta, gqlCalls, api };
}

test('a successful manual final claim reconciles rotation before replying to the popup', async (t) => {
  const { send, gqlCalls } = await makeWorker(t);
  const started = await send({ type: 'START_FARM' });
  assert.equal(started.state.farm.campaignId, 'rust');
  const tabId = started.state.farm.tabId;
  const response = await send({ type: 'CLAIM_DROP', campaignId: 'rust', dropId: 'rust-reward' });
  assert.equal(response.ok, true);
  assert.equal(response.state.farm.campaignId, 'delta');
  assert.equal(response.state.farm.tabId, tabId);
  assert.equal(gqlCalls.filter((call) => call.operationName === 'Inventory').length, 0, 'do not immediately overwrite a confirmed local claim with a cached inventory');
});

test('the drops alarm syncs, claims and switches to an available game in one cycle', async (t) => {
  const { send, rust, listeners, gqlCalls } = await makeWorker(t);
  await send({ type: 'START_FARM' });
  rust.timeBasedDrops[0].self.currentMinutesWatched = 60;
  await listeners.alarm({ name: ALARMS.drops });
  const response = await send({ type: 'GET_STATE' });
  assert.equal(response.state.drops.campaigns[0].completed, true);
  assert.equal(response.state.farm.campaignId, 'delta');
  assert.equal(gqlCalls.filter((call) => call.operationName === 'Inventory').length, 1);
  assert.equal(gqlCalls.filter((call) => call.operationName === 'DropsPage_ClaimDropRewards').length, 1);
});

test('progress events refresh the farm even with automatic claims disabled', async (t) => {
  const { send, rust, gqlCalls } = await makeWorker(t, { autoClaimDrops: false });
  await send({ type: 'START_FARM' });
  rust.timeBasedDrops[0].self.currentMinutesWatched = 60;
  const result = await send({ type: 'PAGE_DROP_PROGRESS' }, { tab: { id: 101, url: 'https://www.twitch.tv/rust_streamer' } });
  assert.equal(result.ok, true);
  t.mock.timers.tick(4_000);
  await nextTurn();
  const response = await send({ type: 'GET_STATE' });
  assert.equal(response.state.farm.campaignId, 'delta');
  assert.equal(response.state.drops.campaigns[0].claimableCount, 1);
  assert.equal(gqlCalls.filter((call) => call.operationName === 'Inventory').length, 1);
  assert.equal(gqlCalls.filter((call) => call.operationName === 'DropsPage_ClaimDropRewards').length, 0);
});

test('FARM_PLAY enables scheduled farming for that campaign without an automatic default start', async (t) => {
  const { send, alarms, listeners, tabs } = await makeWorker(t);
  let response = await send({ type: 'FARM_PLAY', campaignId: 'delta' });
  assert.equal(response.ok, true);
  assert.equal(response.state.farm.campaignId, 'delta');
  assert.equal(response.state.settings.autoFarm, true);
  assert.equal(alarms.get(ALARMS.farm).periodInMinutes, 2);
  await listeners.alarm({ name: ALARMS.farm });
  response = await send({ type: 'GET_STATE' });
  assert.equal(response.state.farm.campaignId, 'delta');
  assert.equal(tabs.size, 1);
  assert.equal(tabs.get(response.state.farm.tabId).url, 'https://www.twitch.tv/delta_streamer');
});

test('a failed Play request does not silently enable farming or navigate to another game', async (t) => {
  const { send, api, alarms, tabs } = await makeWorker(t);
  api.deltaLive = false;
  const response = await send({ type: 'FARM_PLAY', campaignId: 'delta' });
  assert.equal(response.ok, false);
  const snapshot = await send({ type: 'GET_STATE' });
  assert.equal(snapshot.state.settings.autoFarm, false);
  assert.equal(tabs.size, 0);
  assert.equal(alarms.has(ALARMS.farm), false);
});

test('content scripts cannot invoke the privileged Play action', async (t) => {
  const { send, tabs } = await makeWorker(t);
  const response = await send({ type: 'FARM_PLAY', campaignId: 'delta' }, { tab: { id: 1, url: 'https://www.twitch.tv/rust_streamer' } });
  assert.equal(response.ok, false);
  assert.equal(tabs.size, 0);
});

test('Stop requested while Play is still finding a stream wins, even if farming was off', async (t) => {
  const { send, api, tabs, alarms } = await makeWorker(t);
  let release;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  api.streamGate = async () => { signalStarted(); await gate; };
  const playing = send({ type: 'FARM_PLAY', campaignId: 'delta' });
  await started;
  const stopping = send({ type: 'STOP_FARM' });
  release();
  await Promise.all([playing, stopping]);
  const response = await send({ type: 'GET_STATE' });
  assert.equal(response.state.settings.autoFarm, false);
  assert.equal(response.state.farm.enabled, false);
  assert.equal(tabs.size, 0);
  assert.equal(alarms.has(ALARMS.farm), false);
});

test('the farm alarm refreshes completion even with a long drops sync interval', async (t) => {
  const { send, rust, listeners, gqlCalls } = await makeWorker(t);
  await send({ type: 'SET_SETTINGS', patch: { dropsIntervalMin: 30 } });
  await send({ type: 'START_FARM' });
  rust.timeBasedDrops[0].self.currentMinutesWatched = 60;
  t.mock.timers.tick(2 * 60_000);
  await listeners.alarm({ name: ALARMS.farm });
  const response = await send({ type: 'GET_STATE' });
  assert.equal(response.state.farm.campaignId, 'delta');
  assert.equal(response.state.drops.campaigns[0].completed, true);
  assert.equal(gqlCalls.filter((call) => call.operationName === 'Inventory').length, 1);
});


test('FARM_PLAY accepts an unlinked snapshot, reports a warning and persists the explicit selection', async (t) => {
  const { send, tabs, gqlCalls } = await makeWorker(t, { cachedDelta: { linked: false } });
  const started = await send({ type: 'START_FARM' });
  const tabId = started.state.farm.tabId;
  const response = await send({ type: 'FARM_PLAY', campaignId: 'delta' });
  assert.equal(response.ok, true);
  assert.match(response.warning, /без привязки/);
  assert.equal(response.state.farm.campaignId, 'delta');
  assert.equal(response.state.farm.manualCampaignId, 'delta');
  assert.equal(response.state.farm.tabId, tabId);
  assert.equal(response.state.drops.available[0].linked, false);
  assert.equal(tabs.size, 1);
  assert.equal(tabs.get(tabId).url, 'https://www.twitch.tv/delta_streamer');
  assert.equal(gqlCalls.filter((query) => query.operationName === 'Inventory').length, 0);
});

test('the farm alarm keeps an explicitly selected campaign unlinked after refreshing real metadata', async (t) => {
  const { send, tabs, delta, listeners, gqlCalls } = await makeWorker(t, { cachedDelta: { linked: false } });
  delta.self.isAccountConnected = false;
  const response = await send({ type: 'FARM_PLAY', campaignId: 'delta' });
  assert.equal(response.ok, true);
  assert.match(response.warning, /без привязки/);
  t.mock.timers.tick(2 * 60_000);
  await listeners.alarm({ name: ALARMS.farm });
  const snapshot = await send({ type: 'GET_STATE' });
  assert.equal(snapshot.state.farm.campaignId, 'delta');
  assert.equal(snapshot.state.farm.manualCampaignId, 'delta');
  assert.equal(snapshot.state.settings.autoFarm, true);
  assert.equal(snapshot.state.drops.available[0].linked, false);
  assert.equal(tabs.size, 1);
  assert.equal(tabs.get(response.state.farm.tabId).url, 'https://www.twitch.tv/delta_streamer');
  assert.equal(gqlCalls.filter((query) => query.operationName === 'Inventory').length, 1);
});


test('a farm-tab navigation event restores the trusted channel, ignoring a page-supplied raid login', async (t) => {
  const { send, tabs, gqlCalls } = await makeWorker(t);
  const started = await send({ type: 'START_FARM' });
  const tabId = started.state.farm.tabId;
  tabs.get(tabId).url = 'https://www.twitch.tv/no_drops?referrer=raid';
  const response = await send({ type: 'TAB_CHANNEL', payload: { login: 'rust_streamer' } }, { tab: { id: tabId, url: tabs.get(tabId).url } });
  assert.equal(response.ok, true);
  assert.equal(tabs.get(tabId).url, 'https://www.twitch.tv/rust_streamer');
  assert.equal(tabs.size, 1);
  assert.equal(gqlCalls.some((query) => query.variables?.channel === 'no_drops'), false);
});

test('a browser URL-update event handles a raid even without a content-script message', async (t) => {
  const { send, tabs, listeners, api } = await makeWorker(t);
  const started = await send({ type: 'START_FARM' });
  const tabId = started.state.farm.tabId;
  api.rustLive = false;
  tabs.get(tabId).url = 'https://www.twitch.tv/no_drops?referrer=raid';
  await listeners.tabUpdated(tabId, { url: tabs.get(tabId).url });
  const snapshot = await send({ type: 'GET_STATE' });
  assert.equal(snapshot.state.farm.campaignId, 'delta');
  assert.equal(snapshot.state.farm.tabId, tabId);
  assert.equal(tabs.get(tabId).url, 'https://www.twitch.tv/delta_streamer');
  assert.equal(tabs.size, 1);
});

test('navigation in non-farm tabs and non-navigation tab updates cannot hijack the farm', async (t) => {
  const { send, tabs, listeners, gqlCalls } = await makeWorker(t);
  const started = await send({ type: 'START_FARM' });
  const tabId = started.state.farm.tabId;
  const before = gqlCalls.length;
  await send({ type: 'TAB_CHANNEL', payload: { login: 'no_drops' } }, { tab: { id: 900, url: 'https://www.twitch.tv/no_drops' } });
  await listeners.tabUpdated(900, { url: 'https://www.twitch.tv/no_drops' });
  await listeners.tabUpdated(tabId, { mutedInfo: { muted: true } });
  assert.equal(gqlCalls.length, before);
  assert.equal(tabs.get(tabId).url, 'https://www.twitch.tv/rust_streamer');
});

test('a delayed raid check cannot restart farming after Stop', async (t) => {
  const { send, tabs, api } = await makeWorker(t);
  const started = await send({ type: 'START_FARM' });
  const tabId = started.state.farm.tabId;
  tabs.get(tabId).url = 'https://www.twitch.tv/no_drops?referrer=raid';
  let release;
  let entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const checking = new Promise((resolve) => { entered = resolve; });
  api.streamGate = async () => { entered(); await gate; };
  const navigation = send({ type: 'TAB_CHANNEL' }, { tab: { id: tabId, url: tabs.get(tabId).url } });
  await checking;
  const stopping = send({ type: 'STOP_FARM' });
  release();
  await Promise.all([navigation, stopping]);
  const snapshot = await send({ type: 'GET_STATE' });
  assert.equal(snapshot.state.settings.autoFarm, false);
  assert.equal(snapshot.state.farm.manualCampaignId, null);
  assert.equal(tabs.size, 0);
});

test('a stale browser navigation event cannot undo a newer explicit Play selection', async (t) => {
  const { send, tabs, listeners, gqlCalls } = await makeWorker(t);
  await send({ type: 'START_FARM' });
  const chosen = await send({ type: 'FARM_PLAY', campaignId: 'delta' });
  const tabId = chosen.state.farm.tabId;
  const before = gqlCalls.length;
  await listeners.tabUpdated(tabId, { url: 'https://www.twitch.tv/old_raid_destination' });
  const snapshot = await send({ type: 'GET_STATE' });
  assert.equal(snapshot.state.farm.campaignId, 'delta');
  assert.equal(tabs.get(tabId).url, 'https://www.twitch.tv/delta_streamer');
  assert.equal(gqlCalls.length, before, 'read the actual tab URL instead of trusting an old event');
});

test('FARM_PLAY switches the existing tab despite missing rewards, preserves selection and later accepts real progress', async (t) => {
  const { send, api, tabs, delta, listeners, alarms } = await makeWorker(t, { cachedDelta: { drops: [], totalDrops: 0 } });
  api.deltaDetailsMissing = true;
  const started = await send({ type: 'START_FARM' });
  const tabId = started.state.farm.tabId;
  assert.equal(started.state.farm.campaignId, 'rust', 'automatic selection must not start the empty campaign');
  const played = await send({ type: 'FARM_PLAY', campaignId: 'delta' });
  assert.equal(played.ok, true);
  assert.match(played.warning, /Трансляция запущена/);
  assert.match(played.warning, /ещё не подтверждены/);
  assert.equal(played.state.farm.tabId, tabId);
  assert.equal(played.state.farm.manualCampaignId, 'delta');
  assert.equal(played.state.farm.campaignId, 'delta');
  assert.deepEqual(played.state.drops.available[0].drops, []);
  assert.equal(tabs.get(tabId).url, 'https://www.twitch.tv/delta_streamer');
  assert.equal(tabs.size, 1);
  assert.equal(alarms.has(ALARMS.farm), true);
  t.mock.timers.tick(2 * 60_000);
  await listeners.alarm({ name: ALARMS.farm });
  let current = await send({ type: 'GET_STATE' });
  assert.equal(current.state.farm.campaignId, 'delta');
  assert.equal(current.state.farm.tabId, tabId);
  api.deltaDetailsMissing = false;
  delta.timeBasedDrops[0].self.currentMinutesWatched = 5;
  t.mock.timers.tick(2 * 60_000);
  await listeners.alarm({ name: ALARMS.farm });
  current = await send({ type: 'GET_STATE' });
  assert.equal(current.state.farm.campaignId, 'delta');
  assert.equal(current.state.drops.available[0].drops[0].currentMinutes, 5);
  assert.equal(current.state.farm.lastProgressMark, 5);
  assert.equal(tabs.size, 1);
});
