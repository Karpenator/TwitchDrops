import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DropsService } from '../src/background/drops.js';
import { createDefaultState } from '../src/background/state.js';
import { DEFAULT_SETTINGS } from '../src/shared/settings.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');

function fixture(name) {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'),
  );
}

const dashboard = fixture('dashboard');
const inventory = fixture('inventory');

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

function fakeSession() {
  const session = {
    token: 'token-1',
    deviceId: 'device-1',
    user: { id: 'user-1', login: 'karpenator', displayName: 'Karpenator' },
  };
  return {
    session,
    async get() {
      return session;
    },
    async setUser(user) {
      session.user = {
        id: String(user.id || ''),
        login: String(user.login || ''),
        displayName: String(user.displayName || user.login || ''),
      };
      return session;
    },
  };
}

function fakeGql({ claimStatus = 'SUCCESS', onClaim = null } = {}) {
  const calls = { data: [], batch: [], request: [] };
  // A real account would report the drop as claimed on the next inventory
  // fetch; mirror that so repeated refreshes behave like production.
  const inventoryData = JSON.parse(JSON.stringify(inventory));
  function markClaimed(claimId) {
    for (const campaign of inventoryData.currentUser.inventory.dropCampaignsInProgress) {
      for (const drop of campaign.timeBasedDrops || []) {
        if (drop.self?.dropInstanceID === claimId) drop.self.isClaimed = true;
      }
    }
  }
  return {
    calls,
    async data(payload) {
      calls.data.push(payload);
      if (payload.operationName === 'ViewerDropsDashboard') return dashboard;
      if (payload.operationName === 'Inventory') return inventoryData;
      if (payload.operationName === 'CurrentUser') {
        return { currentUser: { id: 'user-1', login: 'karpenator', displayName: 'Karpenator' } };
      }
      throw new Error(`Unexpected data operation: ${payload.operationName}`);
    },
    async batch(payloads) {
      calls.batch.push(payloads);
      return payloads.map((payload) => ({
        data: {
          user: {
            dropCampaign:
              payload.operationName === 'DropCampaignDetails'
                ? {
                    id: payload.variables.dropID,
                    name: 'Rust: Twitch Drops',
                    status: 'ACTIVE',
                    startAt: '2026-10-10T00:00:00Z',
                    endAt: '2026-10-25T00:00:00Z',
                    game: { name: 'Rust', slug: 'rust' },
                  }
                : null,
          },
        },
      }));
    },
    async request(payload) {
      calls.request.push(payload);
      onClaim?.(payload);
      if (claimStatus === 'SUCCESS') markClaimed(payload?.variables?.input?.dropInstanceID);
      return { data: { claimDropRewards: { status: claimStatus } } };
    },
  };
}

function fakeNotify() {
  const events = [];
  return {
    events,
    async dropClaimed(event) {
      events.push(event);
    },
  };
}

function makeService(t, { store = memoryStore(), gql = fakeGql(), notify = fakeNotify() } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const session = fakeSession();
  const service = new DropsService({
    store,
    gql,
    session,
    notify,
    logger: { warn: () => {} },
  });
  return { service, store, gql, notify, session };
}

test('refresh merges inventory and dashboard, then auto-claims ready drops', async (t) => {
  const { service, store, gql, notify } = makeService(t);
  const state = await service.refresh({ claim: true });

  assert.equal(state.drops.campaigns.length, 3, 'all inventory campaigns are kept');
  const rust = state.drops.campaigns.find((campaign) => campaign.id === 'campaign-rust');
  assert.equal(rust.claimableCount, 0, 'the ready drop was claimed during refresh');
  assert.equal(rust.claimedCount, 2);
  assert.equal(rust.drops.find((drop) => drop.id === 'drop-1').isClaimed, true);
  assert.equal(rust.drops.find((drop) => drop.id === 'drop-2').status, 'locked');

  assert.equal(state.drops.available.length, 2);
  assert.deepEqual(
    state.drops.available.map((campaign) => campaign.id).sort(),
    ['campaign-apex', 'campaign-upcoming'],
  );
  assert.equal(state.drops.available.every((campaign) => campaign.isAvailable), true);
  assert.equal(state.drops.error, null);
  assert.equal(state.session.authenticated, true);
  assert.equal(state.drops.lastSync, NOW);
  assert.equal(state.stats.dropsClaimed, 1);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].type, 'drop');
  assert.equal(state.history[0].title, 'Desert Raider Set');
  assert.deepEqual(state.user, { id: 'user-1', login: 'karpenator', displayName: 'Karpenator' });

  assert.equal(gql.calls.request.length, 1);
  assert.equal(gql.calls.request[0].variables.input.dropInstanceID, 'user-1#campaign-rust#drop-1');
  assert.equal(notify.events.length, 1);
  assert.equal(notify.events[0].drop.dropName, 'Desert Raider Set');
});

test('a second refresh does not claim the same drop twice', async (t) => {
  const { service, gql } = makeService(t);
  await service.refresh({ claim: true });
  assert.equal(gql.calls.request.length, 1);
  const second = await service.refresh({ claim: true });
  assert.equal(gql.calls.request.length, 1, 'claimed drop is not claimable anymore');
  assert.equal(second.drops.campaigns.find((campaign) => campaign.id === 'campaign-rust').claimableCount, 0);
});

test('auto-claim honours the setting', async (t) => {
  const store = memoryStore({
    ...createDefaultState(),
    settings: { ...DEFAULT_SETTINGS, autoClaimDrops: false },
  });
  const { service, gql, notify } = makeService(t, { store });
  const state = await service.refresh({ claim: true });
  assert.equal(gql.calls.request.length, 0);
  assert.equal(notify.events.length, 0);
  const rust = state.drops.campaigns.find((campaign) => campaign.id === 'campaign-rust');
  assert.equal(rust.claimableCount, 1, 'the ready drop stays claimable');
});

test('failed automatic claims are backed off, manual ones are not', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const store = memoryStore();
  const gql = fakeGql({ claimStatus: 'FAILED' });
  const serviceWithFailure = new DropsService({
    store,
    gql,
    session: fakeSession(),
    notify: fakeNotify(),
    logger: { warn: () => {} },
  });
  await serviceWithFailure.refresh({ claim: true });
  const failures = store.state.drops.claimFailures;
  assert.deepEqual(Object.keys(failures), ['drop-1']);
  assert.equal(failures['drop-1'].until, NOW + 10 * 60_000);

  const before = gql.calls.request.length;
  await serviceWithFailure.claimAllReady();
  assert.equal(gql.calls.request.length, before, 'backed-off drop is skipped');

  await assert.rejects(
    serviceWithFailure.claimDrop('campaign-rust', 'drop-1', { manual: true }),
    /Twitch отклонил награду|FAILED/,
  );
  assert.equal(gql.calls.request.length, before + 1, 'manual claims bypass the backoff');
});

test('claimDrop validates ids and missing drops', async (t) => {
  const { service } = makeService(t);
  await service.refresh({ claim: false });
  await assert.rejects(service.claimDrop('missing', 'drop-1'), /не найдена/);
  await assert.rejects(service.claimDrop('campaign-rust', 'missing'), /не найдена/);
  const claimed = await service.claimDrop('campaign-rust', 'drop-1', { manual: true });
  assert.deepEqual(claimed, { ok: true, status: 'claimed' });
  const again = await service.claimDrop('campaign-rust', 'drop-1');
  assert.deepEqual(again, { ok: true, alreadyClaimed: true });
});

test('refresh reports an unauthenticated session without calling GQL', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const store = memoryStore();
  const gql = fakeGql();
  const service = new DropsService({
    store,
    gql,
    session: {
      async get() {
        return { token: '', deviceId: '', user: null };
      },
    },
    notify: fakeNotify(),
    logger: { warn: () => {} },
  });
  await assert.rejects(service.refresh(), (error) => error.code === 'auth');
  assert.equal(gql.calls.data.length, 0);
  assert.equal(store.state.session.authenticated, false);
  assert.match(store.state.drops.error, /Сессия Twitch/);
});

test('refresh stores a drops error when both dashboard and inventory fail', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const store = memoryStore();
  const gql = {
    async data() {
      throw new Error('network down');
    },
    async batch() {
      return [];
    },
  };
  const service = new DropsService({
    store,
    gql,
    session: fakeSession(),
    notify: fakeNotify(),
    logger: { warn: () => {} },
  });
  await assert.rejects(service.refresh(), /network down/);
  assert.match(store.state.drops.error, /Не удалось получить данные|network down/);
});

test('fetch campaign details covers inventory and dashboard with the viewer login', async (t) => {
  const { service, gql } = makeService(t);
  await service.refresh({ claim: false });
  assert.equal(gql.calls.batch.length, 1);
  assert.equal(gql.calls.batch[0].length, 5, 'inventory and available campaigns, without duplicate ids');
  assert.deepEqual(
    gql.calls.batch[0].map((payload) => payload.operationName),
    Array(5).fill('DropCampaignDetails'),
  );
  assert.equal(gql.calls.batch[0][0].variables.dropID, 'campaign-rust');
  assert.ok(gql.calls.batch[0].every((payload) => payload.variables.channelLogin === 'karpenator'));
});

function rawCampaign(id, patch = {}) {
  return {
    id, name: `Campaign ${id}`, status: 'ACTIVE',
    startAt: '2026-10-10T00:00:00Z', endAt: '2026-11-01T00:00:00Z',
    game: { id: `game-${id}`, name: `Game ${id}`, slug: `game-${id}` },
    self: { isAccountConnected: true },
    allow: { isEnabled: false, channels: [] },
    timeBasedDrops: [{
      id: `reward-${id}`, requiredMinutesWatched: 60,
      self: { currentMinutesWatched: 0, isClaimed: false },
    }],
    ...patch,
  };
}

function dashboardEntry(campaign) {
  const { timeBasedDrops, self, allow, ...metadata } = campaign;
  return metadata;
}

function campaignApi({ available = [], started = [] } = {}) {
  const calls = { batch: [], request: [] };
  const failures = {};
  const details = new Map([...available, ...started].map((campaign) => [campaign.id, campaign]));
  return {
    calls, failures, details,
    async data(payload) {
      if (failures[payload.operationName]) throw failures[payload.operationName];
      if (payload.operationName === 'Inventory') {
        return { currentUser: { inventory: { dropCampaignsInProgress: started } } };
      }
      return { currentUser: { dropCampaigns: [...started, ...available].map(dashboardEntry) } };
    },
    async batch(payloads) {
      calls.batch.push(payloads);
      if (failures.batch) throw failures.batch;
      return payloads.map((payload) => ({ data: { user: { dropCampaign: details.get(payload.variables.dropID) || null } } }));
    },
    async request(payload) {
      calls.request.push(payload);
      const claimId = payload.variables.input.dropInstanceID;
      for (const campaign of details.values()) {
        for (const drop of campaign.timeBasedDrops) {
          if (claimId === `user-1#${campaign.id}#${drop.id}`) drop.self.isClaimed = true;
        }
      }
      return { data: { claimDropRewards: { status: 'SUCCESS' } } };
    },
  };
}

test('all dashboard campaigns are retained and hydrated beyond the old 30/40 limits', async (t) => {
  const available = Array.from({ length: 46 }, (_, i) => rawCampaign(`available-${i}`));
  const gql = campaignApi({ available });
  const { service, store } = makeService(t, { gql });
  await service.refresh({ claim: false });
  assert.equal(store.state.drops.available.length, 46);
  assert.ok(store.state.drops.available.every((campaign) => campaign.drops.length === 1));
  assert.equal(store.state.drops.available[45].id, 'available-45');
  assert.equal(gql.calls.batch.length, 4);
  const payloads = gql.calls.batch.flat();
  assert.equal(new Set(payloads.map((payload) => payload.variables.dropID)).size, 46);
  assert.ok(gql.calls.batch.every((batch) => batch.length <= 15));
  assert.ok(payloads.every((payload) => payload.variables.channelLogin === 'karpenator'));
});

test('available details include real rewards, account links and channel restrictions', async (t) => {
  const available = [rawCampaign('restricted', {
    self: { isAccountConnected: false },
    allow: { isEnabled: true, channels: [{ login: 'only_streamer' }] },
  })];
  const { service, store } = makeService(t, { gql: campaignApi({ available }) });
  await service.refresh({ claim: false });
  const campaign = store.state.drops.available[0];
  assert.equal(campaign.linked, false);
  assert.equal(campaign.drops[0].requiredMinutes, 60);
  assert.deepEqual(campaign.allowedChannels.map((channel) => channel.login), ['only_streamer']);
});

test('a detail batch failure never removes dashboard categories', async (t) => {
  const available = Array.from({ length: 21 }, (_, i) => rawCampaign(`entry-${i}`));
  const gql = campaignApi({ available });
  const batch = gql.batch;
  gql.batch = async (payloads) => {
    if (payloads[0].variables.dropID === 'entry-0') throw new Error('batch temporarily unavailable');
    return batch(payloads);
  };
  const { service, store } = makeService(t, { gql });
  await service.refresh({ claim: false });
  assert.equal(store.state.drops.available.length, 21);
  assert.equal(store.state.drops.available.filter((campaign) => campaign.drops.length > 0).length, 6);
});

test('partial dashboard and inventory failures preserve the previous lists for the same viewer', async (t) => {
  const gql = campaignApi({ available: [rawCampaign('new')], started: [rawCampaign('started')] });
  const { service, store } = makeService(t, { gql });
  await service.refresh({ claim: false });
  gql.failures.ViewerDropsDashboard = new Error('dashboard offline');
  await service.refresh({ claim: false });
  assert.deepEqual(store.state.drops.available.map((campaign) => campaign.id), ['new']);
  assert.ok(store.state.drops.error, 'a partial sync is not reported as a complete success');
  delete gql.failures.ViewerDropsDashboard;
  gql.failures.Inventory = new Error('inventory offline');
  await service.refresh({ claim: false });
  assert.deepEqual(store.state.drops.campaigns.map((campaign) => campaign.id), ['started']);
  assert.deepEqual(store.state.drops.available.map((campaign) => campaign.id), ['new']);
});

test('partial sync does not reuse another viewer\'s cached campaigns', async (t) => {
  const gql = campaignApi({ available: [rawCampaign('new')] });
  const { service, store } = makeService(t, { gql });
  await service.refresh({ claim: false });
  store.state.user.id = 'another-viewer';
  gql.failures.ViewerDropsDashboard = new Error('dashboard offline');
  await service.refresh({ claim: false });
  assert.deepEqual(store.state.drops.available, []);
});

test('claims cover available campaigns even before inventory starts listing them', async (t) => {
  const campaign = rawCampaign('ready');
  campaign.timeBasedDrops[0].self.currentMinutesWatched = 60;
  const gql = campaignApi({ available: [campaign] });
  const { service, store } = makeService(t, { gql });
  await service.refresh({ claim: true });
  assert.equal(store.state.drops.available[0].completed, true);
  assert.equal(store.state.drops.available[0].drops[0].isClaimed, true);
  assert.equal(store.state.stats.dropsClaimed, 1);
  assert.equal(gql.calls.request.length, 1);
  await service.refresh({ claim: true });
  assert.equal(store.state.drops.available.length, 0, 'completed dashboard entries are not offered again');
  assert.equal(gql.calls.request.length, 1);
});

test('missing category slugs are resolved from Twitch once per game and reused', async (t) => {
  const game = { id: 'canonical-game', name: 'A Display Name That Is Not The Slug' };
  const gql = campaignApi({ available: [rawCampaign('one', { game }), rawCampaign('two', { game })] });
  const originalBatch = gql.batch;
  const categoryQueries = [];
  gql.batch = async (payloads) => {
    if (payloads[0].operationName !== 'AutoPilotGameCategory') return originalBatch(payloads);
    categoryQueries.push(...payloads);
    return payloads.map(() => ({ data: { game: { id: game.id, slug: 'actual-twitch-category' } } }));
  };
  const { service, store, session, notify } = makeService(t, { gql });
  await service.refresh({ claim: false });
  assert.equal(categoryQueries.length, 1, 'two campaigns of the same game need one lookup');
  assert.equal(categoryQueries[0].variables.name, game.name);
  assert.ok(store.state.drops.available.every((campaign) => campaign.game.slug === 'actual-twitch-category'));
  assert.ok(store.state.drops.available.every((campaign) => campaign.categoryUrl === 'https://www.twitch.tv/directory/category/actual-twitch-category?filter=drops'));
  await service.refresh({ claim: false });
  assert.equal(categoryQueries.length, 1, 'the canonical slug is cached, not repeatedly guessed');
  const restarted = new DropsService({ store, gql, session, notify });
  await restarted.refresh({ claim: false });
  assert.equal(categoryQueries.length, 1, 'canonical slugs survive in the saved campaign data');
});

test('a failed category lookup keeps rewards and uses the corrected name fallback', async (t) => {
  const game = { id: 'warhammer', name: 'Warhammer 40,000: Space Marine II' };
  const gql = campaignApi({ available: [rawCampaign('warhammer', { game })] });
  const originalBatch = gql.batch;
  gql.batch = async (payloads) => {
    if (payloads[0].operationName === 'AutoPilotGameCategory') throw new Error('temporarily unavailable');
    return originalBatch(payloads);
  };
  const { service, store } = makeService(t, { gql });
  await service.refresh({ claim: false });
  assert.equal(store.state.drops.available.length, 1);
  const campaign = store.state.drops.available[0];
  assert.equal(campaign.drops.length, 1);
  assert.equal(campaign.game.slug, '', 'a guessed slug is not treated as authoritative metadata');
  assert.equal(campaign.categoryUrl, 'https://www.twitch.tv/directory/category/warhammer-40-000-space-marine-ii?filter=drops');
});

test('an existing canonical slug needs no extra category query', async (t) => {
  const game = { id: 'official', name: 'Old Game Name', slug: 'current-twitch-slug' };
  const gql = campaignApi({ available: [rawCampaign('official', { game })] });
  const { service, store } = makeService(t, { gql });
  await service.refresh({ claim: false });
  assert.equal(gql.calls.batch.flat().some((payload) => payload.operationName === 'AutoPilotGameCategory'), false);
  assert.equal(store.state.drops.available[0].categoryUrl, 'https://www.twitch.tv/directory/category/current-twitch-slug?filter=drops');
});

test('a slug belonging to a different game id is not accepted', async (t) => {
  const game = { id: 'arena', name: 'Arena Breakout: Infinite' };
  const gql = campaignApi({ available: [rawCampaign('arena', { game })] });
  const originalBatch = gql.batch;
  gql.batch = async (payloads) => payloads[0].operationName === 'AutoPilotGameCategory'
    ? [{ data: { game: { id: 'another-game', slug: 'wrong-category' } } }]
    : originalBatch(payloads);
  const { service, store } = makeService(t, { gql });
  await service.refresh({ claim: false });
  assert.equal(store.state.drops.available[0].categoryUrl, 'https://www.twitch.tv/directory/category/arena-breakout-infinite?filter=drops');
});
