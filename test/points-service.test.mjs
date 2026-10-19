import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PointsService } from '../src/background/points.js';
import { createDefaultState } from '../src/background/state.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');

const shroudPayload = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/channel-points.json', import.meta.url)), 'utf8'),
);
const dashboard = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/dashboard.json', import.meta.url)), 'utf8'),
);

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

function channelPayload(login, balance, { claimId = '' , channelId = '' } = {}) {
  return {
    data: {
      community: {
        channel: {
          id: channelId || `id-${login}`,
          broadcaster: {
            login,
            displayName: login,
            stream: { id: `stream-${login}`, title: 'Live', game: { name: 'Rust', slug: 'rust' } },
          },
          self: { communityPoints: { balance, availableClaim: claimId ? { id: claimId } : null } },
        },
      },
    },
  };
}

function fakeGql({ failClaims = false } = {}) {
  const calls = { batch: [], request: [], data: [] };
  return {
    calls,
    async data(payload) {
      calls.data.push(payload);
      if (payload.operationName === 'ChannelPointsContext') {
        const login = payload.variables.channelLogin;
        if (login === 'shroud') return shroudPayload;
        return channelPayload(login, 100, { channelId: `id-${login}` });
      }
      throw new Error(`Unexpected operation ${payload.operationName}`);
    },
    async batch(payloads) {
      calls.batch.push(payloads);
      return payloads.map((payload) => {
        const login = payload.variables.channelLogin;
        if (login === 'shroud') return shroudPayload;
        if (login === 'kaicenat') return channelPayload('kaicenat', 3940, { channelId: '668' });
        return channelPayload(login, 8120, { channelId: `id-${login}` });
      });
    },
    async request(payload) {
      calls.request.push(payload);
      if (failClaims) return { errors: [{ message: 'Unauthorized' }] };
      return { data: { claimCommunityPoints: { claim: { id: payload.variables.input.claimID } } } };
    },
  };
}

function fakeTabs({ domClicked = false } = {}) {
  const actions = { sent: [], created: [], updated: [] };
  return {
    actions,
    async query() {
      return [
        { id: 1, url: 'https://www.twitch.tv/shroud' },
        { id: 2, url: 'https://www.twitch.tv/kaicenat' },
        { id: 3, url: 'https://www.twitch.tv/directory/game/Rust' },
      ];
    },
    async sendMessage(tabId, message) {
      actions.sent.push({ tabId, message });
      return message.type === 'CHECK_BONUS' ? { clicked: domClicked } : { ok: true };
    },
    async create(options) {
      actions.created.push(options);
      return { id: 100 + actions.created.length };
    },
    async update(tabId, options) {
      actions.updated.push({ tabId, options });
      return { id: tabId };
    },
    async get(tabId) {
      return { id: tabId, url: 'https://www.twitch.tv/shroud' };
    },
    async remove() {},
  };
}

function fakeNotify() {
  const events = [];
  return { events, async pointsClaimed(event) { events.push(event); } };
}

function makeService(t, { store = memoryStore(), gql = fakeGql(), tabs = fakeTabs(), notify = fakeNotify() } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const session = { token: 'token-1', deviceId: 'device-1', user: { id: 'u1', login: 'me' } };
  const service = new PointsService({
    store,
    gql,
    session: { async get() { return session; } },
    notify,
    tabsApi: tabs,
    logger: { warn: () => {} },
  });
  return { service, store, gql, tabs, notify };
}

test('refresh tracks open channels and auto-claims available points', async (t) => {
  const store = memoryStore({
    ...createDefaultState(),
    points: { ...createDefaultState().points, tracked: [{ login: 'summit1g', addedAt: 1 }] },
  });
  const { service, gql, tabs, notify } = makeService(t, { store });
  const state = await service.refresh({ claim: true });

  assert.equal(gql.calls.batch.length, 1);
  assert.deepEqual(
    gql.calls.batch[0].map((payload) => payload.operationName),
    ['ChannelPointsContext', 'ChannelPointsContext', 'ChannelPointsContext'],
  );
  assert.deepEqual(
    Object.keys(state.points.channels).sort(),
    ['kaicenat', 'shroud', 'summit1g'],
  );
  const shroud = state.points.channels.shroud;
  assert.equal(shroud.balance, 12450);
  assert.equal(shroud.availableClaimId, '', 'the claim clears the pending bonus');
  assert.equal(shroud.multiplier, 1.2);
  assert.equal(shroud.tracked, false);
  assert.equal(shroud.open, true);
  assert.equal(state.points.channels.kaicenat.balance, 3940);
  assert.equal(state.points.channels.summit1g.tracked, true);
  assert.equal(state.points.channels.summit1g.open, false);

  // The DOM click is attempted first, then the GQL fallback is used.
  assert.ok(tabs.actions.sent.some((entry) => entry.message.type === 'CHECK_BONUS'));
  assert.equal(gql.calls.request.length, 1);
  assert.deepEqual(gql.calls.request[0].variables.input, {
    claimID: 'claim-abc',
    channelID: '37402112',
  });
  assert.equal(state.stats.pointsBonuses, 1);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].type, 'points');
  assert.equal(state.history[0].subtitle, 'shroud');
  assert.equal(state.points.recentClaims['37402112::claim-abc'], NOW);
  assert.equal(state.points.lastClaimAt, NOW);
  assert.equal(notify.events.length, 1);
});

test('a successful DOM click skips the GQL claim', async (t) => {
  const tabs = fakeTabs({ domClicked: true });
  const { service, gql, store } = makeService(t, { tabs });
  await service.refresh({ claim: true });
  assert.equal(gql.calls.request.length, 0);
  assert.equal(store.state.stats.pointsBonuses, 1);
  assert.equal(store.state.points.channels.shroud.availableClaimId, '');
  assert.equal(store.state.points.recentClaims['37402112::claim-abc'], undefined);
  const domKey = Object.keys(store.state.points.recentClaims).find((key) => key.startsWith('dom::shroud::'));
  assert.ok(domKey, 'DOM claims are recorded with a time bucket');
});

test('auto-claim honours the points setting', async (t) => {
  const base = createDefaultState();
  const store = memoryStore({
    ...base,
    settings: { ...base.settings, autoClaimPoints: false },
  });
  const { service, gql, tabs } = makeService(t, { store });
  await service.refresh({ claim: true });
  assert.equal(gql.calls.request.length, 0);
  assert.equal(tabs.actions.sent.length, 0);
  assert.equal(store.state.points.channels.shroud.availableClaimId, 'claim-abc');
});

test('handleClaimAvailable dedupes and falls back to GQL', async (t) => {
  const { service, gql, store } = makeService(t);
  await service.refresh({ claim: false });

  const first = await service.handleClaimAvailable({
    channelId: '37402112',
    claimId: 'claim-abc',
    channelLogin: 'shroud',
    tabId: 1,
  });
  assert.deepEqual(first, { ok: true, source: 'gql' });
  assert.equal(gql.calls.request.length, 1);

  const second = await service.handleClaimAvailable({
    channelId: '37402112',
    claimId: 'claim-abc',
    channelLogin: 'shroud',
  });
  assert.deepEqual(second, { ok: true, deduped: true });
  assert.equal(gql.calls.request.length, 1);
  assert.equal(store.state.stats.pointsBonuses, 1);
});

test('failed claims are reported and not recorded', async (t) => {
  const gql = fakeGql({ failClaims: true });
  const { service, store } = makeService(t, { gql });
  await assert.rejects(
    service.claimPoints({ login: 'shroud', channelId: '37402112', claimId: 'claim-abc' }),
    /не подтвердил/,
  );
  assert.equal(store.state.stats.pointsBonuses, 0);
  assert.deepEqual(store.state.points.recentClaims, {});
  assert.equal(store.state.points.channels.shroud, undefined);
});

test('refreshChannel keeps tracked/open flags', async (t) => {
  const store = memoryStore();
  await store.update((state) => {
    state.points.channels.shroud = {
      login: 'shroud',
      channelId: '37402112',
      tracked: true,
      open: true,
      balance: 1,
    };
    return state;
  });
  const { service } = makeService(t, { store });
  const channel = await service.refreshChannel('shroud');
  assert.equal(channel.balance, 12450);
  assert.equal(store.state.points.channels.shroud.tracked, true);
  assert.equal(store.state.points.channels.shroud.open, true);
  assert.equal(store.state.points.channels.shroud.availableClaimId, 'claim-abc');
  assert.equal(await service.refreshChannel('bad login'), null);
});

test('addTracked and removeTracked manage the watch list', async (t) => {
  const { service, store } = makeService(t, { tabs: { async query() { return []; } } });
  await service.addTracked('@Summit1G');
  assert.deepEqual(
    store.state.points.tracked.map((item) => item.login),
    ['summit1g'],
  );
  assert.equal(store.state.points.channels.summit1g.tracked, true);

  const again = await service.addTracked('summit1g');
  assert.deepEqual(again, { ok: true, alreadyTracked: true });
  assert.equal(store.state.points.tracked.length, 1);

  await assert.rejects(service.addTracked('no spaces allowed'), /Некорректное имя канала/);

  await service.removeTracked('summit1g');
  assert.deepEqual(store.state.points.tracked, []);
  assert.equal(store.state.points.channels.summit1g, undefined);

  await service.addTracked('shroud');
  await service.refresh({ claim: false });
  assert.equal(store.state.points.channels.shroud.tracked, true);
  await service.removeTracked('shroud');
  assert.equal(store.state.points.channels.shroud, undefined);
});

test('refresh clears channels when nothing is watched', async (t) => {
  const tabs = { async query() { return []; } };
  const { service, store } = makeService(t, { tabs });
  await store.update((state) => {
    state.points.channels = { old: { login: 'old', balance: 5 } };
    return state;
  });
  const state = await service.refresh({ claim: true });
  assert.deepEqual(state.points.channels, {});
  assert.equal(state.points.lastSync, NOW);
});

test('empty channel contexts surface an error instead of fake balances', async (t) => {
  const tabs = { async query() { return [{ id: 1, url: 'https://www.twitch.tv/shroud' }]; } };
  const gql = {
    calls: { batch: [], request: [], data: [] },
    async batch() {
      return [{ data: { community: { channel: null } } }];
    },
    async request() {
      throw new Error('should not claim');
    },
  };
  const { service, store } = makeService(t, { gql, tabs });
  const state = await service.refresh({ claim: true });
  assert.deepEqual(state.points.channels, {});
  assert.equal(gql.calls.request.length, 0);
  assert.match(state.points.error, /не нашёл|неожиданный|Не удалось/);
});

test('points open tabs ignore non-channel pages', async (t) => {
  const { service } = makeService(t);
  const open = await service.openTabs();
  assert.deepEqual(open, [
    { tabId: 1, login: 'shroud', url: 'https://www.twitch.tv/shroud' },
    { tabId: 2, login: 'kaicenat', url: 'https://www.twitch.tv/kaicenat' },
  ]);
});
