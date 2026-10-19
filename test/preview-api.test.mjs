import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The preview demo is a static page, but its chrome.* shim is plain script.
 * Run it against a fake `window` so the demo data cannot silently go stale
 * (wrong field names, missing claim ids, broken settings toggles...).
 */
const source = readFileSync(
  fileURLToPath(new URL('../preview/demo-api.js', import.meta.url)),
  'utf8',
);

function makeApi() {
  const window = {};
  new Function('window', source)(window);
  return { window, runtime: window.chrome.runtime };
}

async function send(runtime, message) {
  return runtime.sendMessage(message);
}

test('GET_STATE returns a coherent demo snapshot', async () => {
  const { runtime } = makeApi();
  const response = await send(runtime, { type: 'GET_STATE' });
  assert.equal(response.ok, true);
  assert.equal(response.version, '1.3.0');
  assert.equal(response.openTabs.length, 2);
  assert.equal(response.state.session.authenticated, true);
  assert.equal(response.state.drops.campaigns.length, 4);
  assert.equal(response.state.drops.available.length, 8);
  assert.equal(response.state.points.channels.shroud.availableClaimId, 'demo-claim-shroud');
  assert.equal(response.state.points.tracked.length, 2);
  assert.equal(response.state.history.length, 4);

  const rust = response.state.drops.campaigns.find((campaign) => campaign.id === 'rust-campaign');
  assert.equal(rust.totalDrops, 4);
  assert.equal(rust.claimableCount, 1);
  assert.equal(rust.claimedCount, 2);
  assert.equal(rust.progressPct, 50);
  assert.equal(rust.drops[2].status, 'claimable');
  assert.equal(rust.drops[2].claimId, 'demo#rust-3');

  const delta = response.state.drops.campaigns.find((campaign) => campaign.id === 'delta-campaign');
  assert.equal(delta.totalDrops, 3);
  assert.equal(delta.drops[2].status, 'locked');
  assert.equal(delta.drops[2].preconditionsMet, false);
});

test('GET_STATE returns a deep copy', async () => {
  const { runtime } = makeApi();
  const first = await send(runtime, { type: 'GET_STATE' });
  first.state.drops.campaigns[0].name = 'mutated';
  first.state.points.channels.shroud.balance = 0;
  const second = await send(runtime, { type: 'GET_STATE' });
  assert.notEqual(second.state.drops.campaigns[0].name, 'mutated');
  assert.notEqual(second.state.points.channels.shroud.balance, 0);
});

test('CLAIM_DROP moves a ready reward to claimed and records history', async () => {
  const { runtime } = makeApi();
  const response = await send(runtime, {
    type: 'CLAIM_DROP',
    campaignId: 'rust-campaign',
    dropId: 'rust-3',
  });
  assert.equal(response.ok, true);
  const campaign = response.state.drops.campaigns.find((item) => item.id === 'rust-campaign');
  const drop = campaign.drops.find((item) => item.id === 'rust-3');
  assert.equal(drop.isClaimed, true);
  assert.equal(drop.claimable, false);
  assert.equal(drop.status, 'claimed');
  assert.equal(drop.progressPct, 100);
  assert.equal(campaign.claimedCount, 3);
  assert.equal(campaign.claimableCount, 0);
  assert.equal(response.state.stats.dropsClaimed, 15);
  assert.equal(response.state.history[0].title, 'Скины для оружия');
  assert.equal(response.state.history.length, 5);

  const again = await send(runtime, {
    type: 'CLAIM_DROP',
    campaignId: 'rust-campaign',
    dropId: 'rust-3',
  });
  assert.equal(again.ok, false);
  assert.match(again.error, /уже получена/);
});

test('CLAIM_ALL_DROPS claims ready rewards across every campaign', async () => {
  const { runtime } = makeApi();
  const response = await send(runtime, { type: 'CLAIM_ALL_DROPS' });
  assert.equal(response.ok, true);
  assert.equal(response.result.claimed.length, 2, 'claims across different campaigns');
  assert.deepEqual(response.result.failed, []);
  const rust = response.state.drops.campaigns.find((item) => item.id === 'rust-campaign');
  assert.equal(rust.claimableCount, 0);
  assert.equal(rust.claimedCount, 3);
  const wot = response.state.drops.campaigns.find((item) => item.id === 'wot-campaign');
  assert.equal(wot.claimableCount, 0);
  assert.equal(response.state.history[0].title, 'Двухнедельный премиум');
  assert.equal(response.state.stats.dropsClaimed, 16);
});

test('CLAIM_POINTS adds the bonus balance and increments stats', async () => {
  const { runtime } = makeApi();
  const response = await send(runtime, { type: 'CLAIM_POINTS', login: 'shroud' });
  assert.equal(response.ok, true);
  assert.equal(response.state.points.channels.shroud.availableClaimId, '');
  assert.equal(response.state.points.channels.shroud.balance, 12900);
  assert.equal(response.state.stats.pointsBonuses, 38);
  assert.equal(response.state.history[0].type, 'points');
  assert.equal(response.state.history[0].subtitle, 'shroud');

  const missing = await send(runtime, { type: 'CLAIM_POINTS', login: 'kaicenat' });
  assert.equal(missing.ok, false);
});

test('settings and farm actions stay in sync', async () => {
  const { runtime } = makeApi();
  let response = await send(runtime, {
    type: 'SET_SETTINGS',
    patch: { autoClaimDrops: false, farmStrategy: 'top', autoFarm: true },
  });
  assert.equal(response.ok, true);
  assert.equal(response.state.settings.autoClaimDrops, false);
  assert.equal(response.state.settings.farmStrategy, 'top');
  assert.equal(response.state.settings.autoFarm, true);
  assert.equal(response.state.farm.enabled, true);
  assert.equal(response.state.farm.channelLogin, 'shroud');
  assert.equal(response.state.farm.tabId, 777);
  assert.deepEqual(response.state.farm.campaignIds, ['rust-campaign', 'rust-prime']);
  assert.equal(response.state.farm.campaignNames.length, 2);
  assert.equal(response.state.farm.gameName, 'Rust');

  response = await send(runtime, { type: 'FARM_SKIP' });
  assert.equal(response.ok, true);
  assert.equal(response.state.farm.channelLogin, 'summit1g');

  response = await send(runtime, { type: 'SET_SETTINGS', patch: { autoFarm: false } });
  assert.equal(response.state.farm.enabled, false);
  assert.equal(response.state.farm.channelLogin, null);

  response = await send(runtime, { type: 'START_FARM' });
  assert.equal(response.state.settings.autoFarm, true);
  response = await send(runtime, { type: 'STOP_FARM' });
  assert.equal(response.state.settings.autoFarm, false);
});

test('channels can be added and removed', async () => {
  const { runtime } = makeApi();
  let response = await send(runtime, { type: 'ADD_CHANNEL', login: 'New_Channel' });
  assert.equal(response.ok, true);
  assert.equal(response.state.points.channels.new_channel.tracked, true);
  assert.ok(response.state.points.tracked.some((item) => item.login === 'new_channel'));

  response = await send(runtime, { type: 'ADD_CHANNEL', login: 'new_channel' });
  assert.equal(response.state.points.tracked.length, 3);
  assert.equal(response.state.points.tracked.filter((item) => item.login === 'new_channel').length, 1);

  response = await send(runtime, { type: 'ADD_CHANNEL', login: '' });
  assert.equal(response.ok, false);

  response = await send(runtime, { type: 'REMOVE_CHANNEL', login: 'new_channel' });
  assert.equal(response.ok, true);
  assert.equal(response.state.points.tracked.some((item) => item.login === 'new_channel'), false);
  assert.equal(response.state.points.channels.new_channel, undefined);
});

test('history and stats can be cleared', async () => {
  const { runtime } = makeApi();
  let response = await send(runtime, { type: 'CLEAR_HISTORY' });
  assert.deepEqual(response.state.history, []);
  response = await send(runtime, { type: 'RESET_STATS' });
  assert.deepEqual(response.state.stats, { dropsClaimed: 0, pointsBonuses: 0 });
});

test('unknown actions fail cleanly and open handlers accept only Twitch', async () => {
  const { window, runtime } = makeApi();
  const opened = [];
  window.open = (...args) => opened.push(args);
  const unknown = await send(runtime, { type: 'NOPE' });
  assert.deepEqual(unknown, { ok: false, error: 'Демо: неизвестное действие' });

  await send(runtime, { type: 'OPEN_CHANNEL', login: 'shroud' });
  await send(runtime, { type: 'OPEN_URL', url: 'https://www.twitch.tv/drops/campaigns' });
  await send(runtime, { type: 'OPEN_URL', url: 'https://evil.example/' });
  assert.equal(opened.length, 2);
  assert.match(opened[0][0], /twitch\.tv\/shroud$/);
  assert.match(opened[1][0], /twitch\.tv\/drops\/campaigns$/);
});


test('Play selects an available campaign and reuses the demo farm tab', async () => {
  const { runtime } = makeApi();
  let response = await send(runtime, { type: 'FARM_PLAY', campaignId: 'apex-campaign' });
  assert.equal(response.ok, true);
  assert.equal(response.state.settings.autoFarm, true);
  assert.equal(response.state.farm.campaignId, 'apex-campaign');
  assert.equal(response.state.farm.gameSlug, 'apex-legends');
  const tabId = response.state.farm.tabId;
  response = await send(runtime, { type: 'FARM_PLAY', campaignId: 'throne-and-liberty-campaign' });
  assert.equal(response.state.farm.tabId, tabId);
  assert.equal(response.state.farm.campaignId, 'throne-and-liberty-campaign');
  response = await send(runtime, { type: 'FARM_SKIP' });
  assert.equal(response.state.farm.gameSlug, 'throne-and-liberty', 'skip must not reset the chosen category to Rust');
  response = await send(runtime, { type: 'FARM_PLAY', campaignId: 'rivals-campaign' });
  assert.equal(response.ok, false);
  assert.match(response.error, /ещё не началась/);
});
