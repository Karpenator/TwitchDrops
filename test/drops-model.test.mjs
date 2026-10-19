import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DROP_STATUS,
  campaignGameKey,
  campaignWatchMark,
  farmGroupFromIds,
  groupFarmableCampaigns,
  groupWatchMark,
  computeCampaignStats,
  flattenClaimableDrops,
  isActiveOrUpcoming,
  isClaimResponseSuccessful,
  isClaimStatusSuccess,
  isFarmableCampaign,
  markDropClaimed,
  mergeCampaignData,
  mergeCampaignsWithDetails,
  normalizeCampaign,
  normalizeCampaignList,
  pickCandidate,
  pickFarmCampaign,
  pickFarmGroup,
  sanitizeImageUrl,
  sanitizeTwitchUrl,
  sortCampaigns,
} from '../src/shared/drops-model.js';

const NOW = Date.parse('2026-10-19T12:00:00Z');

function fixture(name) {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'),
  );
}

const inventory = fixture('inventory').currentUser.inventory;
const dashboard = fixture('dashboard').currentUser.dropCampaigns;

function rustCampaign() {
  return normalizeCampaign(inventory.dropCampaignsInProgress[0], { userId: 'user-1', now: NOW });
}

test('sanitizeTwitchUrl and sanitizeImageUrl only allow Twitch hosts', () => {
  assert.equal(sanitizeTwitchUrl('https://www.twitch.tv/drops/campaigns'), 'https://www.twitch.tv/drops/campaigns');
  assert.equal(sanitizeTwitchUrl('http://www.twitch.tv/drops'), '');
  assert.equal(sanitizeTwitchUrl('https://evil.example/twitch.tv'), '');
  assert.equal(sanitizeTwitchUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeTwitchUrl(null), '');

  assert.ok(sanitizeImageUrl('https://static-cdn.jtvnw.net/ttv-boxart/263490.jpg'));
  assert.ok(sanitizeImageUrl('https://clips.twitch.tv/thumb.png'));
  assert.equal(sanitizeImageUrl('https://static-cdn.jtvnw.net.evil.example/x.png'), '');
  assert.equal(sanitizeImageUrl('data:image/png;base64,AAAA'), '');
});

test('normalizeCampaign exposes progress, claims and stats', () => {
  const campaign = rustCampaign();
  assert.equal(campaign.id, 'campaign-rust');
  assert.equal(campaign.name, 'Rust: Twitch Drops');
  assert.equal(campaign.game.slug, 'rust');
  assert.equal(campaign.game.name, 'Rust');
  assert.equal(campaign.linked, true);
  assert.equal(campaign.active, true);
  assert.equal(campaign.expired, false);
  assert.equal(campaign.totalDrops, 3);
  assert.equal(campaign.claimableCount, 1);
  assert.equal(campaign.claimedCount, 1);
  assert.equal(campaign.inProgressCount, 1);
  assert.equal(campaign.progressPct, 33);
  assert.equal(campaign.categoryUrl, 'https://www.twitch.tv/directory/category/rust');
  assert.deepEqual(
    campaign.drops.map((drop) => drop.id),
    ['drop-1', 'drop-2', 'drop-3'],
  );
  assert.deepEqual(
    campaign.drops.map((drop) => drop.status),
    [DROP_STATUS.CLAIMABLE, DROP_STATUS.LOCKED, DROP_STATUS.CLAIMED],
  );
  const claimable = campaign.drops[0];
  assert.equal(claimable.claimable, true);
  assert.equal(claimable.progressPct, 100);
  assert.equal(claimable.claimId, 'user-1#campaign-rust#drop-1');
  assert.equal(claimable.rewardText, 'Desert Raider Set');
  assert.equal(claimable.benefits.length, 1);
});

test('normalizeCampaign treats completed and expired campaigns correctly', () => {
  const expired = normalizeCampaign(inventory.dropCampaignsInProgress[2], { now: NOW });
  assert.equal(expired.status, 'EXPIRED');
  assert.equal(expired.active, false);
  assert.equal(expired.expired, true);

  const fromDashboard = normalizeCampaignList(dashboard, { now: NOW });
  assert.equal(fromDashboard.length, 4);
  assert.equal(fromDashboard.find((c) => c.id === 'campaign-apex').totalDrops, 0);
  assert.equal(fromDashboard.find((c) => c.id === 'campaign-apex').completed, false);
});

test('normalizeCampaign falls back to the campaign id for the claim id', () => {
  const campaign = normalizeCampaign(
    {
      id: 'campaign-x',
      name: 'X',
      status: 'ACTIVE',
      startAt: '2026-01-01T00:00:00Z',
      endAt: '2027-01-01T00:00:00Z',
      timeBasedDrops: [
        { id: 'drop-x', name: 'Reward', requiredMinutesWatched: 10, self: { currentMinutesWatched: 10 } },
      ],
    },
    { userId: 'u1', now: NOW },
  );
  assert.equal(campaign.drops[0].claimId, 'u1#campaign-x#drop-x');
  assert.equal(campaign.drops[0].claimable, true);
});

test('unlinked campaigns and claim windows are respected', () => {
  const linkedFalse = normalizeCampaign({ ...inventory.dropCampaignsInProgress[0], self: { isAccountConnected: false } }, { now: NOW });
  assert.equal(linkedFalse.linked, false);
  const closed = normalizeCampaign(
    { ...inventory.dropCampaignsInProgress[0], endAt: '2026-10-01T00:00:00Z' },
    { userId: 'user-1', now: NOW },
  );
  assert.equal(closed.drops.some((drop) => drop.claimable), false);
  assert.equal(closed.drops.find((drop) => drop.id === 'drop-1').status, DROP_STATUS.EXPIRED);
});

test('mergeCampaignData merges inventory progress with dashboard metadata', () => {
  const inventoryCampaign = {
    id: 'c1',
    name: 'Inventory name',
    timeBasedDrops: [{ id: 'd1', requiredMinutesWatched: 60, self: { currentMinutesWatched: 30 } }],
  };
  const details = {
    id: 'c1',
    name: 'Details name',
    startAt: '2026-10-01T00:00:00Z',
    endAt: '2026-10-30T00:00:00Z',
    status: 'ACTIVE',
    game: { name: 'Game', slug: 'game' },
    accountLinkURL: 'https://www.twitch.tv/settings/connections',
    timeBasedDrops: [
      {
        id: 'd1',
        name: 'Reward one',
        requiredMinutesWatched: 60,
        benefitEdges: [{ benefit: { name: 'Hat', distributionType: 'DIRECT_ENTITLEMENT' } }],
      },
      {
        id: 'd2',
        name: 'Reward two',
        requiredMinutesWatched: 120,
        benefitEdges: [{ benefit: { name: 'Shirt', distributionType: 'DIRECT_ENTITLEMENT' } }],
      },
    ],
  };

  const merged = mergeCampaignData(inventoryCampaign, details);
  assert.equal(merged.name, 'Inventory name', 'inventory wins for shared fields');
  assert.equal(merged.status, 'ACTIVE');
  assert.equal(merged.timeBasedDrops.length, 2);
  assert.equal(merged.timeBasedDrops[0].name, 'Reward one');
  assert.equal(merged.timeBasedDrops[0].benefitEdges[0].benefit.name, 'Hat');
  assert.equal(merged.timeBasedDrops[0].self.currentMinutesWatched, 30);
  assert.equal(merged.timeBasedDrops[1].id, 'd2');

  const campaign = normalizeCampaign(merged, { userId: 'u', now: NOW });
  assert.equal(campaign.drops[0].currentMinutes, 30);
  assert.equal(campaign.drops[0].rewardText, 'Hat');
});

test('mergeCampaignsWithDetails accepts a plain object and a Map', () => {
  const details = dashboard.find((campaign) => campaign.id === 'campaign-rust');
  const byObject = mergeCampaignsWithDetails(inventory.dropCampaignsInProgress, { 'campaign-rust': details });
  assert.equal(byObject[0].timeBasedDrops.length, 3);
  assert.equal(byObject[0].name, 'Rust: Twitch Drops');

  const byMap = mergeCampaignsWithDetails(inventory.dropCampaignsInProgress, new Map([['campaign-rust', details]]));
  assert.equal(byMap[0].allow.channels.length, 1);
});

test('computeCampaignStats and markDropClaimed recalculate totals', () => {
  const campaign = rustCampaign();
  const claimed = markDropClaimed(campaign, 'drop-1');
  assert.equal(claimed.claimableCount, 0);
  assert.equal(claimed.claimedCount, 2);
  assert.equal(claimed.progressPct, 67);
  assert.equal(claimed.drops[0].status, DROP_STATUS.CLAIMED);
  assert.equal(claimed.drops[0].progressPct, 100);
  assert.equal(claimed.completed, false);

  assert.equal(markDropClaimed(campaign, 'missing'), campaign, 'unknown ids return the same object');

  const complete = markDropClaimed(claimed, 'drop-2');
  assert.equal(complete.completed, true);
  assert.equal(complete.claimableCount, 0);

  assert.deepEqual(computeCampaignStats([]), {
    totalDrops: 0,
    claimableCount: 0,
    claimedCount: 0,
    inProgressCount: 0,
    remainingMinutes: 0,
    progressPct: 0,
  });
});

test('sortCampaigns and flattenClaimableDrops prioritize ready rewards', () => {
  const campaigns = normalizeCampaignList(inventory.dropCampaignsInProgress, { userId: 'user-1', now: NOW });
  const sorted = sortCampaigns(campaigns);
  assert.equal(sorted[0].id, 'campaign-rust');
  const claimable = flattenClaimableDrops(campaigns);
  assert.equal(claimable.length, 1);
  assert.equal(claimable[0].campaignId, 'campaign-rust');
  assert.equal(claimable[0].dropId, 'drop-1');
  assert.equal(claimable[0].claimId, 'user-1#campaign-rust#drop-1');
  assert.equal(flattenClaimableDrops([{ ...campaigns[0], linked: false }]).length, 0);
  assert.equal(isActiveOrUpcoming('active'), true);
  assert.equal(isActiveOrUpcoming('EXPIRED'), false);
});

test('claim status helpers accept every documented success status', () => {
  for (const status of ['SUCCESS', 'ELIGIBLE_FOR_ALL', 'DROP_INSTANCE_ALREADY_CLAIMED', 'CLAIMED']) {
    assert.equal(isClaimStatusSuccess(status), true, status);
  }
  assert.equal(isClaimStatusSuccess('FAILED'), false);
  assert.equal(isClaimStatusSuccess(undefined), false);

  assert.equal(isClaimResponseSuccessful({ data: { claimDropRewards: { status: 'SUCCESS' } } }), true);
  assert.equal(
    isClaimResponseSuccessful({ data: { claimDropRewards: { error: { message: 'nope' }, status: 'SUCCESS' } } }),
    false,
  );
  assert.equal(isClaimResponseSuccessful({ data: {} }), false);
  assert.equal(isClaimResponseSuccessful(null), false);
});

test('farm helpers only consider campaigns worth watching', () => {
  const campaigns = normalizeCampaignList(inventory.dropCampaignsInProgress, { userId: 'user-1', now: NOW });
  const rust = campaigns.find((campaign) => campaign.id === 'campaign-rust');
  const delta = campaigns.find((campaign) => campaign.id === 'campaign-delta');
  assert.equal(isFarmableCampaign(rust, NOW), true);
  assert.equal(isFarmableCampaign(delta, NOW), false, 'unlinked account cannot be farmed');
  assert.equal(isFarmableCampaign({ ...rust, completed: true }, NOW), false);
  assert.equal(isFarmableCampaign({ ...rust, active: false }, NOW), false);

  assert.equal(pickFarmCampaign(campaigns, NOW).id, 'campaign-rust');
  assert.equal(pickFarmCampaign([], NOW), null);
  assert.equal(campaignWatchMark(rust), 60 + 90 + 180);
});

test('pickCandidate honours strategy, exclusions and randomness', () => {
  const candidates = [
    { login: 'small', viewers: 10 },
    { login: 'big', viewers: 5000 },
    { login: 'middle', viewers: 500 },
  ];
  assert.equal(pickCandidate(candidates, { strategy: 'top' }).login, 'big');
  assert.equal(pickCandidate(candidates, { strategy: 'low' }).login, 'small');
  assert.equal(pickCandidate(candidates, { strategy: 'random', random: () => 0.7 }).login, 'middle');
  assert.equal(pickCandidate(candidates, { strategy: 'top', excludeLogin: 'big' }).login, 'middle');
  assert.equal(pickCandidate([], {}), null);
  assert.equal(pickCandidate([{ login: 'only' }], { excludeLogin: 'only' }).login, 'only');
  assert.equal(
    pickCandidate([{ login: 'a', viewers: null }, { login: 'b', viewers: 5 }], { strategy: 'low' }).login,
    'b',
    'channels without viewer counts sort last',
  );
});


function farmableCampaignFixture({
  id,
  gameSlug = 'rust',
  gameName = 'Rust',
  endAt = '2026-10-25T00:00:00Z',
  channels = null,
  drops = [{ requiredMinutes: 120, currentMinutes: 30 }],
  linked = true,
} = {}) {
  return normalizeCampaign(
    {
      id,
      name: `Campaign ${id}`,
      status: 'ACTIVE',
      startAt: '2026-10-10T00:00:00Z',
      endAt,
      game: { name: gameName, slug: gameSlug },
      self: { isAccountConnected: linked },
      allow: channels ? { isEnabled: true, channels: channels.map((login) => ({ login })) } : null,
      timeBasedDrops: drops.map((drop, index) => ({
        id: `${id}-drop-${index}`,
        requiredMinutesWatched: drop.requiredMinutes,
        self: {
          currentMinutesWatched: drop.currentMinutes || 0,
          isClaimed: Boolean(drop.isClaimed),
        },
        benefitEdges: [{ benefit: { name: `Reward ${index}` } }],
      })),
    },
    { userId: 'u1', now: NOW },
  );
}

test('campaignGameKey prefers the slug and falls back to the name', () => {
  assert.equal(campaignGameKey({ game: { slug: 'Rust', name: 'RUST' } }), 'rust');
  assert.equal(campaignGameKey({ game: { name: 'Delta Force' } }), 'delta force');
  assert.equal(campaignGameKey({ game: {} }), '');
  assert.equal(campaignGameKey(null), '');
});

test('groupFarmableCampaigns groups by game and computes group stats', () => {
  const campaigns = [
    farmableCampaignFixture({ id: 'rust-late', endAt: '2026-10-28T00:00:00Z', drops: [{ requiredMinutes: 300, currentMinutes: 60 }] }),
    farmableCampaignFixture({ id: 'rust-early', endAt: '2026-10-22T00:00:00Z', drops: [{ requiredMinutes: 120, currentMinutes: 90 }] }),
    farmableCampaignFixture({ id: 'delta', gameSlug: 'delta-force', gameName: 'Delta Force', endAt: '2026-10-26T00:00:00Z', drops: [{ requiredMinutes: 90, currentMinutes: 0 }] }),
    farmableCampaignFixture({ id: 'expired', endAt: '2026-10-01T00:00:00Z' }),
    farmableCampaignFixture({ id: 'unlinked', linked: false }),
  ];
  const groups = groupFarmableCampaigns(campaigns, NOW);
  assert.equal(groups.length, 2);
  const rust = groups.find((group) => group.key === 'rust');
  assert.deepEqual(rust.campaigns.map((campaign) => campaign.id), ['rust-early', 'rust-late']);
  assert.equal(rust.endsAt, Date.parse('2026-10-22T00:00:00Z'));
  assert.equal(rust.remainingMinutes, 240, 'the slowest campaign defines the group total');
  assert.equal(rust.totalRemainingMinutes, 30 + 240);
  assert.equal(rust.dropsLeft, 2);
  const delta = groups.find((group) => group.key === 'delta-force');
  assert.equal(delta.campaigns.length, 1);
  assert.equal(delta.game.name, 'Delta Force');
  assert.deepEqual(groupFarmableCampaigns([], NOW), []);
});

test('pickFarmGroup follows the deadline or progress priority', () => {
  const campaigns = [
    farmableCampaignFixture({ id: 'rust', endAt: '2026-10-30T00:00:00Z', drops: [{ requiredMinutes: 300, currentMinutes: 60 }] }),
    farmableCampaignFixture({ id: 'delta', gameSlug: 'delta-force', gameName: 'Delta Force', endAt: '2026-10-22T00:00:00Z', drops: [{ requiredMinutes: 90, currentMinutes: 0 }] }),
  ];
  assert.equal(pickFarmGroup(campaigns, NOW).key, 'delta-force');
  assert.equal(pickFarmGroup(campaigns, NOW, { priority: 'progress' }).key, 'delta-force');

  const quick = farmableCampaignFixture({ id: 'quick', gameSlug: 'quick-game', gameName: 'Quick', endAt: '2026-11-05T00:00:00Z', drops: [{ requiredMinutes: 30, currentMinutes: 0 }] });
  assert.equal(pickFarmGroup([...campaigns, quick], NOW, { priority: 'deadline' }).key, 'delta-force');
  assert.equal(pickFarmGroup([...campaigns, quick], NOW, { priority: 'progress' }).key, 'quick-game');
  assert.equal(pickFarmGroup([], NOW), null);
  assert.equal(pickFarmGroup([farmableCampaignFixture({ id: 'off', linked: false })], NOW), null);
});

test('farmGroupFromIds restores a same-game group after a restart', () => {
  const rustA = farmableCampaignFixture({ id: 'rust-a' });
  const rustB = farmableCampaignFixture({ id: 'rust-b', endAt: '2026-10-27T00:00:00Z' });
  const delta = farmableCampaignFixture({ id: 'delta', gameSlug: 'delta-force', gameName: 'Delta Force' });
  const group = farmGroupFromIds([rustA, rustB, delta], ['rust-a', 'rust-b', 'delta'], NOW);
  assert.equal(group.key, 'rust');
  assert.deepEqual(group.campaigns.map((campaign) => campaign.id), ['rust-a', 'rust-b']);

  assert.equal(farmGroupFromIds([rustA], ['missing'], NOW), null);
  assert.equal(farmGroupFromIds([], [], NOW), null);
  const expired = farmableCampaignFixture({ id: 'old', endAt: '2026-10-01T00:00:00Z' });
  assert.equal(farmGroupFromIds([expired], ['old'], NOW), null);
});

test('groupWatchMark sums the progress of every campaign watched at once', () => {
  const rustA = farmableCampaignFixture({ id: 'rust-a', drops: [{ requiredMinutes: 120, currentMinutes: 30 }] });
  const rustB = farmableCampaignFixture({ id: 'rust-b', drops: [{ requiredMinutes: 60, currentMinutes: 60, isClaimed: true }] });
  assert.equal(campaignWatchMark(rustA), 30);
  assert.equal(groupWatchMark([rustA, rustB]), 90);
  assert.equal(groupWatchMark([]), 0);
});
