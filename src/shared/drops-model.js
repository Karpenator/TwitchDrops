import { categoryUrl } from './twitch-url.js';
import { toTimestamp, clamp } from './time.js';

const CLAIMABLE_STATUSES = new Set([
  'ELIGIBLE_FOR_ALL',
  'SUCCESS',
  'CLAIMED',
  'DROP_INSTANCE_ALREADY_CLAIMED',
]);

const UPCOMING_OR_ACTIVE = new Set(['ACTIVE', 'UPCOMING']);

export const DROP_STATUS = Object.freeze({
  CLAIMED: 'claimed',
  CLAIMABLE: 'claimable',
  WATCHING: 'watching',
  LOCKED: 'locked',
  PENDING: 'pending',
  EXPIRED: 'expired',
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function sanitizeTwitchUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase();
    return host === 'twitch.tv' || host.endsWith('.twitch.tv') ? url.toString() : '';
  } catch {
    return '';
  }
}

export function sanitizeImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') return '';
    const host = url.hostname.toLowerCase();
    const allowed =
      host === 'static-cdn.jtvnw.net' ||
      host.endsWith('.jtvnw.net') ||
      host === 'clips.twitch.tv' ||
      host.endsWith('.twitch.tv');
    return allowed ? url.toString() : '';
  } catch {
    return '';
  }
}

function normalizeChannel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const login = text(raw.login || raw.name).toLowerCase();
  if (!/^[a-z0-9_]{2,25}$/.test(login)) return null;
  return {
    id: text(raw.id),
    login,
    displayName: text(raw.displayName) || login,
  };
}

function normalizeBenefits(rawDrop) {
  return arr(rawDrop?.benefitEdges)
    .map((edge) => {
      const benefit = edge?.benefit || edge;
      if (!benefit || typeof benefit !== 'object') return null;
      const name = text(benefit.name);
      if (!name) return null;
      return {
        id: text(benefit.id),
        name,
        type: text(benefit.distributionType) || 'UNKNOWN',
        imageUrl: sanitizeImageUrl(benefit.imageAssetURL || benefit.imageURL),
      };
    })
    .filter(Boolean);
}

/**
 * Twitch returns inventory drops with progress (`self`) and campaign details
 * with the full reward metadata. Merge both without losing either.
 */
export function mergeCampaignData(inventoryCampaign, detailsCampaign) {
  if (!inventoryCampaign) return detailsCampaign || null;
  if (!detailsCampaign) return inventoryCampaign;
  const merged = {
    ...detailsCampaign,
    ...inventoryCampaign,
  };
  for (const key of ['game', 'allow', 'self', 'accountLinkURL', 'status', 'startAt', 'endAt']) {
    if (merged[key] == null && detailsCampaign[key] != null) merged[key] = detailsCampaign[key];
  }
  // Inventory often has only a partial game/self object. Do not lose the
  // category slug or account-link/allowlist metadata from the detail query.
  for (const key of ['game', 'allow', 'self']) {
    if (!detailsCampaign[key] || !inventoryCampaign[key]) continue;
    merged[key] = { ...detailsCampaign[key], ...inventoryCampaign[key] };
    for (const [field, value] of Object.entries(detailsCampaign[key])) {
      if (merged[key][field] == null) merged[key][field] = value;
    }
  }
  const detailDrops = new Map(
    arr(detailsCampaign.timeBasedDrops)
      .map((drop) => [text(drop?.id), drop])
      .filter(([id]) => Boolean(id)),
  );
  const inventoryDrops = arr(inventoryCampaign.timeBasedDrops);
  if (inventoryDrops.length === 0) {
    merged.timeBasedDrops = arr(detailsCampaign.timeBasedDrops);
  } else {
    const used = new Set();
    merged.timeBasedDrops = inventoryDrops.map((drop) => {
      const id = text(drop?.id);
      const detail = detailDrops.get(id);
      if (detail) used.add(id);
      if (!detail) return drop;
      const combined = { ...detail, ...drop };
      for (const key of [
        'name',
        'benefitEdges',
        'requiredMinutesWatched',
        'startAt',
        'endAt',
        'preconditionDrops',
        'preconditions',
      ]) {
        if (combined[key] == null) combined[key] = detail[key];
      }
      if (detail.self) combined.self = { ...detail.self, ...drop.self };
      return combined;
    });
    for (const [id, detail] of detailDrops) {
      if (!used.has(id)) merged.timeBasedDrops.push(detail);
    }
  }
  return merged;
}

export function mergeCampaignsWithDetails(inventoryCampaigns, detailsById) {
  return arr(inventoryCampaigns).map((campaign) => {
    const id = text(campaign?.id);
    const details = id && detailsById ? detailsById[id] || detailsById.get?.(id) : null;
    return mergeCampaignData(campaign, details);
  });
}

function claimIdForDrop(rawDrop, campaignId, userId) {
  const fromSelf = text(rawDrop?.self?.dropInstanceID || rawDrop?.self?.dropInstanceId);
  if (fromSelf) return fromSelf;
  if (userId && campaignId && text(rawDrop?.id)) {
    return `${userId}#${campaignId}#${rawDrop.id}`;
  }
  return '';
}

function normalizeDrop(rawDrop, campaign, { userId, now }) {
  const id = text(rawDrop?.id);
  const requiredMinutes = Math.max(0, Math.round(num(rawDrop?.requiredMinutesWatched, 0)));
  const self = rawDrop?.self && typeof rawDrop.self === 'object' ? rawDrop.self : {};
  const isClaimed = bool(self.isClaimed, false);
  const currentMinutesRaw = Math.max(0, Math.round(num(self.currentMinutesWatched, 0)));
  const currentMinutes = isClaimed
    ? Math.max(requiredMinutes, currentMinutesRaw)
    : Math.min(requiredMinutes || currentMinutesRaw, currentMinutesRaw);
  const preconditionsMet = bool(rawDrop?.preconditions?.isMet, true);
  const startsAt = toTimestamp(rawDrop?.startAt);
  const endsAt = toTimestamp(rawDrop?.endAt);
  const claimWindowOpen = !campaign.endsAt || now < campaign.endsAt + 24 * 60 * 60 * 1000;
  const claimId = claimIdForDrop(rawDrop, campaign.id, userId);
  const benefits = normalizeBenefits(rawDrop);
  const earned = requiredMinutes > 0 && currentMinutes >= requiredMinutes;
  const claimable =
    !isClaimed && claimWindowOpen && preconditionsMet && earned && Boolean(claimId);
  let status = DROP_STATUS.WATCHING;
  if (isClaimed) status = DROP_STATUS.CLAIMED;
  else if (claimable) status = DROP_STATUS.CLAIMABLE;
  else if (!preconditionsMet) status = DROP_STATUS.LOCKED;
  else if (!claimWindowOpen) status = DROP_STATUS.EXPIRED;
  else if (requiredMinutes === 0) status = DROP_STATUS.CLAIMED;
  else if (currentMinutes === 0) status = DROP_STATUS.PENDING;

  const progressPct = isClaimed
    ? 100
    : requiredMinutes > 0
      ? clamp(Math.round((currentMinutes / requiredMinutes) * 100), 0, 100)
      : 0;

  return {
    id,
    name: text(rawDrop?.name),
    requiredMinutes,
    currentMinutes,
    remainingMinutes: isClaimed ? 0 : Math.max(0, requiredMinutes - currentMinutes),
    progressPct: claimable ? 100 : progressPct,
    isClaimed,
    claimable,
    claimId,
    preconditionsMet,
    startsAt,
    endsAt,
    benefits,
    rewardText: benefits.map((benefit) => benefit.name).join(', '),
    status,
  };
}

/**
 * Normalize an inventory/dashboard campaign into the shape used by the UI and
 * by the automation services.
 */
export function normalizeCampaign(rawCampaign, { userId = '', now = Date.now() } = {}) {
  if (!rawCampaign || typeof rawCampaign !== 'object') return null;
  const id = text(rawCampaign.id);
  if (!id) return null;

  const gameRaw = rawCampaign.game && typeof rawCampaign.game === 'object' ? rawCampaign.game : {};
  const gameName = text(gameRaw.displayName || gameRaw.name) || 'Twitch';
  const gameSlug = text(gameRaw.slug) || '';
  const game = {
    id: text(gameRaw.id),
    name: gameName,
    slug: gameSlug,
    boxArtUrl: sanitizeImageUrl(gameRaw.boxArtURL || gameRaw.boxArtUrl),
  };

  const startsAt = toTimestamp(rawCampaign.startAt);
  const endsAt = toTimestamp(rawCampaign.endAt);
  const status = text(rawCampaign.status).toUpperCase() || 'ACTIVE';
  const linked = rawCampaign?.self?.isAccountConnected !== false;
  const accountLinkUrl = sanitizeTwitchUrl(rawCampaign.accountLinkURL);

  const allow =
    rawCampaign.allow && typeof rawCampaign.allow === 'object' ? rawCampaign.allow : null;
  const allowEnabled = allow ? bool(allow.isEnabled, true) : true;
  const allowedChannels = allowEnabled ? arr(allow?.channels).map(normalizeChannel).filter(Boolean) : [];

  const campaignBase = {
    id,
    name: text(rawCampaign.name) || gameName,
    game,
    status,
    startsAt,
    endsAt,
    linked,
    accountLinkUrl,
    allowedChannels,
    imageUrl: game.boxArtUrl,
    isAvailable: Boolean(rawCampaign.isAvailable),
    isInProgress: Boolean(rawCampaign.isInProgress ?? true),
  };

  const drops = arr(rawCampaign.timeBasedDrops)
    .map((drop) => normalizeDrop(drop, campaignBase, { userId, now }))
    .filter((drop) => drop.id)
    .sort((a, b) => a.requiredMinutes - b.requiredMinutes || a.name.localeCompare(b.name, 'ru'));

  const stats = computeCampaignStats(drops);
  const active =
    status === 'ACTIVE' &&
    (!startsAt || startsAt <= now) &&
    (!endsAt || now < endsAt) &&
    status !== 'EXPIRED';
  const upcoming = status === 'UPCOMING' || (startsAt != null && startsAt > now);
  const expired = status === 'EXPIRED' || (endsAt != null && endsAt <= now);
  const completed =
    drops.length > 0 &&
    drops.every((drop) => drop.isClaimed || drop.requiredMinutes === 0);

  return {
    ...campaignBase,
    active,
    upcoming,
    expired,
    completed,
    drops,
    ...stats,
    categoryUrl: campaignCategoryUrl(campaignBase),
  };
}

/** Rebuild links from game metadata, including snapshots with an old broken URL. */
export function campaignCategoryUrl(campaign) {
  return categoryUrl(text(campaign?.game?.slug) || text(campaign?.game?.name), { dropsOnly: true });
}

export function computeCampaignStats(drops) {
  const claimableCount = drops.filter((drop) => drop.claimable).length;
  const claimedCount = drops.filter((drop) => drop.isClaimed).length;
  const inProgressCount = drops.filter(
    (drop) => !drop.isClaimed && drop.currentMinutes > 0 && !drop.claimable,
  ).length;
  const remainingMinutes = drops.reduce((total, drop) => total + drop.remainingMinutes, 0);
  return {
    totalDrops: drops.length,
    claimableCount,
    claimedCount,
    inProgressCount,
    remainingMinutes,
    progressPct: drops.length ? Math.round((claimedCount / drops.length) * 100) : 0,
  };
}

/** Update local state after a successful claim without waiting for a refresh. */
export function markDropClaimed(campaign, dropId) {
  if (!campaign || !Array.isArray(campaign.drops)) return campaign;
  let changed = false;
  const drops = campaign.drops.map((drop) => {
    if (drop.id !== dropId) return drop;
    changed = true;
    return {
      ...drop,
      isClaimed: true,
      claimable: false,
      currentMinutes: Math.max(drop.currentMinutes, drop.requiredMinutes),
      remainingMinutes: 0,
      progressPct: 100,
      status: DROP_STATUS.CLAIMED,
    };
  });
  if (!changed) return campaign;
  return {
    ...campaign,
    drops,
    ...computeCampaignStats(drops),
    completed: drops.length > 0 && drops.every((d) => d.isClaimed || d.requiredMinutes === 0),
  };
}

export function normalizeCampaignList(list, options = {}) {
  return arr(list)
    .map((campaign) => normalizeCampaign(campaign, options))
    .filter(Boolean);
}

export function sortCampaigns(campaigns) {
  return [...arr(campaigns)].sort((a, b) => {
    if (b.claimableCount !== a.claimableCount) return b.claimableCount - a.claimableCount;
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    const aEnd = a.endsAt || Number.MAX_SAFE_INTEGER;
    const bEnd = b.endsAt || Number.MAX_SAFE_INTEGER;
    if (aEnd !== bEnd) return aEnd - bEnd;
    return a.game.name.localeCompare(b.game.name, 'ru');
  });
}

export function flattenClaimableDrops(campaigns) {
  const result = [];
  for (const campaign of arr(campaigns)) {
    if (!campaign || campaign.linked === false) continue;
    for (const drop of arr(campaign.drops)) {
      if (!drop.claimable) continue;
      result.push({
        campaignId: campaign.id,
        campaignName: campaign.name,
        gameName: campaign.game?.name || '',
        dropId: drop.id,
        dropName: drop.rewardText || drop.name || 'Награда',
        claimId: drop.claimId,
        endsAt: campaign.endsAt,
        imageUrl: drop.benefits.find((benefit) => benefit.imageUrl)?.imageUrl || campaign.imageUrl,
      });
    }
  }
  return result.sort((a, b) => (a.endsAt || Infinity) - (b.endsAt || Infinity));
}

export function isClaimStatusSuccess(status) {
  return CLAIMABLE_STATUSES.has(String(status || '').toUpperCase());
}

export function isClaimResponseSuccessful(payload) {
  const data = payload?.data ?? payload;
  if (!data || typeof data !== 'object') return false;
  const response = data.claimDropRewards ?? data;
  if (response?.error?.message) return false;
  return isClaimStatusSuccess(response?.status);
}

/**
 * Campaign suitable for the real-tab auto-farm: active, linked, has rewards
 * left to watch and has a category we can search. Fully earned rewards stay
 * claimable but must not keep the farm watching a finished game.
 */
export function isFarmableCampaign(campaign, now = Date.now()) {
  if (!campaign || !campaign.active || campaign.linked === false) return false;
  if (campaign.completed || campaign.expired) return false;
  if (campaign.startsAt && campaign.startsAt > now) return false;
  if (campaign.endsAt && campaign.endsAt <= now) return false;
  if (!campaign.game?.name) return false;
  // The directory can resolve a game by name when Twitch omits its slug.
  if (!campaign.allowedChannels?.length && !campaign.game?.slug &&
      !campaign.game?.id && campaign.game.name === 'Twitch') return false;
  return arr(campaign.drops).some(
    (drop) =>
      !drop.isClaimed &&
      !drop.claimable &&
      drop.requiredMinutes > 0 &&
      drop.currentMinutes < drop.requiredMinutes &&
      drop.preconditionsMet !== false &&
      (!drop.startsAt || drop.startsAt <= now) &&
      (!drop.endsAt || drop.endsAt > now),
  );
}

/** Inventory wins duplicate ids; unstarted dashboard campaigns also need a turn. */
export function campaignPool(drops) {
  const byId = new Map();
  for (const campaign of [...arr(drops?.campaigns), ...arr(drops?.available)]) {
    if (campaign?.id && !byId.has(String(campaign.id))) {
      byId.set(String(campaign.id), campaign);
    }
  }
  return [...byId.values()];
}

export function pickFarmCampaign(campaigns, now = Date.now()) {
  const candidates = arr(campaigns)
    .filter((campaign) => isFarmableCampaign(campaign, now))
    .sort((a, b) => {
      // Prefer campaigns that are already partially watched.
      const aStarted = a.drops.some((drop) => drop.currentMinutes > 0 && !drop.isClaimed) ? 1 : 0;
      const bStarted = b.drops.some((drop) => drop.currentMinutes > 0 && !drop.isClaimed) ? 1 : 0;
      if (aStarted !== bStarted) return bStarted - aStarted;
      return (a.endsAt || Number.MAX_SAFE_INTEGER) - (b.endsAt || Number.MAX_SAFE_INTEGER);
    });
  return candidates[0] || null;
}

export function campaignWatchMark(campaign) {
  if (!campaign) return 0;
  return arr(campaign.drops).reduce(
    (total, drop) => total + (drop.isClaimed ? drop.requiredMinutes : drop.currentMinutes),
    0,
  );
}

/**
 * Stable key for "the same game/category". Twitch credits watch time to every
 * campaign that is live on the watched channel, but a channel only streams one
 * category, so campaigns can only overlap when they share a game.
 */
export function campaignGameKey(campaign) {
  return String(campaign?.game?.slug || campaign?.game?.name || '')
    .trim()
    .toLowerCase();
}

function campaignEnd(campaign) {
  return campaign?.endsAt || Number.MAX_SAFE_INTEGER;
}

function sortGroupCampaigns(campaigns) {
  return [...campaigns].sort(
    (a, b) =>
      campaignEnd(a) - campaignEnd(b) ||
      (a.remainingMinutes || 0) - (b.remainingMinutes || 0) ||
      String(a.name || '').localeCompare(String(b.name || ''), 'ru'),
  );
}

/**
 * Group farmable campaigns by game. Every campaign in a group can be advanced
 * by watching the same channel at the same time (Twitch's overlapping-campaign
 * behavior), so a group is the smallest unit the farm needs to schedule.
 */
export function groupFarmableCampaigns(campaigns, now = Date.now()) {
  const groups = new Map();
  for (const campaign of arr(campaigns)) {
    if (!isFarmableCampaign(campaign, now)) continue;
    const key = campaignGameKey(campaign);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = { key, game: campaign.game, campaigns: [] };
      groups.set(key, group);
    }
    group.campaigns.push(campaign);
  }
  return [...groups.values()].map((group) => {
    const sorted = sortGroupCampaigns(group.campaigns);
    return {
      key: group.key,
      game: group.game,
      campaigns: sorted,
      endsAt: Math.min(...sorted.map(campaignEnd)),
      // Time needed to finish the slowest campaign in the group: all of them
      // progress simultaneously, so this is the group's total watch time.
      remainingMinutes: sorted.reduce(
        (max, campaign) => Math.max(max, campaign.remainingMinutes || 0),
        0,
      ),
      totalRemainingMinutes: sorted.reduce(
        (sum, campaign) => sum + (campaign.remainingMinutes || 0),
        0,
      ),
      claimableCount: sorted.reduce(
        (sum, campaign) => sum + (campaign.claimableCount || 0),
        0,
      ),
      dropsLeft: sorted.reduce(
        (sum, campaign) =>
          sum + arr(campaign.drops).filter((drop) => !drop.isClaimed).length,
        0,
      ),
    };
  });
}

/**
 * Pick the next group to watch. `deadline` finishes campaigns that expire
 * soonest (safer for limited-time drops), `progress` starts with the shortest
 * remaining watch time (faster rewards).
 */
export function sortFarmGroups(groups, { priority = 'deadline' } = {}) {
  const byDeadline = (a, b) =>
    a.endsAt - b.endsAt ||
    a.remainingMinutes - b.remainingMinutes ||
    a.key.localeCompare(b.key);
  return [...arr(groups)].sort(
    priority === 'progress'
      ? (a, b) => a.remainingMinutes - b.remainingMinutes || byDeadline(a, b)
      : byDeadline,
  );
}

export function pickFarmGroup(campaigns, now = Date.now(), options = {}) {
  return sortFarmGroups(groupFarmableCampaigns(campaigns, now), options)[0] || null;
}

/** Sum of watch marks of every campaign in a simultaneously watched group. */
export function groupWatchMark(campaigns) {
  return arr(campaigns).reduce((total, campaign) => total + campaignWatchMark(campaign), 0);
}

/** Rebuild a group from a stored list of campaign ids (survives restarts). */
export function farmGroupFromIds(campaigns, ids, now = Date.now()) {
  const wanted = new Set(arr(ids).map(String));
  if (wanted.size === 0) return null;
  const matching = arr(campaigns).filter(
    (campaign) => wanted.has(String(campaign.id)) && isFarmableCampaign(campaign, now),
  );
  if (matching.length === 0) return null;
  const key = campaignGameKey(matching[0]);
  const sameGame = matching.filter((campaign) => campaignGameKey(campaign) === key);
  if (sameGame.length === 0) return null;
  const sorted = sortGroupCampaigns(sameGame);
  return { key, game: sorted[0].game, campaigns: sorted };
}

export function pickCandidate(candidates, { strategy = 'random', excludeLogin = '', random = Math.random } = {}) {
  const list = arr(candidates).filter((candidate) => candidate && candidate.login);
  const available = list.filter((candidate) => candidate.login !== excludeLogin);
  const pool = available.length > 0 ? available : list;
  if (pool.length === 0) return null;
  if (strategy === 'top') {
    return [...pool].sort((a, b) => num(b.viewers) - num(a.viewers))[0];
  }
  if (strategy === 'low') {
    return [...pool].sort((a, b) => {
      const aViewers = num(a.viewers) || Number.MAX_SAFE_INTEGER;
      const bViewers = num(b.viewers) || Number.MAX_SAFE_INTEGER;
      return aViewers - bViewers;
    })[0];
  }
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index];
}

export function isActiveOrUpcoming(status) {
  return UPCOMING_OR_ACTIVE.has(String(status || '').toUpperCase());
}
