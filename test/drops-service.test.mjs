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

test('fetch campaign details is limited and failure tolerant', async (t) => {
  const { service, gql } = makeService(t);
  await service.refresh({ claim: false });
  assert.equal(gql.calls.batch.length, 1);
  assert.equal(gql.calls.batch[0].length, 3, 'one entry per in-progress campaign');
  assert.deepEqual(
    gql.calls.batch[0].map((payload) => payload.operationName),
    ['DropCampaignDetails', 'DropCampaignDetails', 'DropCampaignDetails'],
  );
  assert.equal(gql.calls.batch[0][0].variables.dropID, 'campaign-rust');
});
