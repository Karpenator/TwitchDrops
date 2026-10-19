import { normalizeLogin } from './twitch-url.js';
import { sanitizeImageUrl } from './drops-model.js';
import { MAX_TRACKED_CHANNELS } from './constants.js';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function num(value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function unwrapGqlData(payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.data && typeof payload.data === 'object') return payload.data;
  return payload;
}

/**
 * Parse a ChannelPointsContext response.
 * Returns null when Twitch says the channel/community doesn't exist.
 */
export function normalizeChannelPoints(payload, fallbackLogin = '', now = Date.now()) {
  const data = unwrapGqlData(payload);
  const channel = data?.community?.channel;
  if (!channel || typeof channel !== 'object') return null;
  const broadcaster =
    channel.broadcaster && typeof channel.broadcaster === 'object' ? channel.broadcaster : {};
  const stream = broadcaster.stream && typeof broadcaster.stream === 'object' ? broadcaster.stream : null;
  const self = channel.self && typeof channel.self === 'object' ? channel.self : {};
  const points = self.communityPoints && typeof self.communityPoints === 'object' ? self.communityPoints : {};
  const multipliers = Array.isArray(points.activeMultipliers) ? points.activeMultipliers : [];
  const factor = multipliers.reduce((max, item) => Math.max(max, num(item?.factor, 1)), 1);
  const login = text(broadcaster.login).toLowerCase() || normalizeLogin(fallbackLogin) || '';
  if (!login) return null;
  const avatarUrl = sanitizeImageUrl(
    broadcaster.profileImageURL || broadcaster.profileImageUrl || channel.profileImageURL,
  );
  return {
    login,
    channelId: text(channel.id || broadcaster.id),
    displayName: text(broadcaster.displayName || channel.displayName) || login,
    avatarUrl,
    balance: Math.max(0, Math.round(num(points.balance, 0))),
    availableClaimId: text(points.availableClaim?.id),
    multiplier: Math.max(1, factor),
    isLive: Boolean(stream?.id),
    gameName: text(stream?.game?.displayName || stream?.game?.name),
    streamTitle: text(stream?.title),
    updatedAt: now,
  };
}

export function claimKey(channelId, claimId) {
  return `${text(channelId)}::${text(claimId)}`;
}

/** Assume success when Twitch doesn't send an explicit failure. */
export function isPointsClaimSuccessful(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) return false;
  const data = unwrapGqlData(payload);
  const claim = data?.claimCommunityPoints;
  if (claim && typeof claim === 'object' && claim.error?.message) return false;
  return true;
}

export function normalizeTrackedChannels(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const rawLogin = typeof item === 'string' ? item : item?.login;
    const login = normalizeLogin(rawLogin);
    if (!login || seen.has(login)) continue;
    seen.add(login);
    result.push({
      login,
      addedAt: num(typeof item === 'object' ? item?.addedAt : 0, 0),
    });
    if (result.length >= MAX_TRACKED_CHANNELS) break;
  }
  return result;
}

/**
 * Merge manually tracked channels with channels that are currently open in
 * Twitch tabs. Open channels get their balance refreshed too, but are not
 * persisted as tracked unless the user adds them.
 */
export function buildChannelWatchList({ tracked = [], openLogins = [], max = MAX_TRACKED_CHANNELS } = {}) {
  const map = new Map();
  for (const item of normalizeTrackedChannels(tracked)) {
    map.set(item.login, { login: item.login, tracked: true, open: false, addedAt: item.addedAt });
  }
  for (const raw of openLogins || []) {
    const login = normalizeLogin(raw);
    if (!login) continue;
    const existing = map.get(login);
    if (existing) {
      existing.open = true;
    } else {
      map.set(login, { login, tracked: false, open: true, addedAt: 0 });
    }
  }
  const list = [...map.values()];
  list.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    if (a.tracked !== b.tracked) return a.tracked ? -1 : 1;
    return a.login.localeCompare(b.login);
  });
  return list.slice(0, max);
}

export function totalPoints(channels) {
  return Object.values(channels || {}).reduce((sum, channel) => {
    if (!channel || channel.error) return sum;
    return sum + Math.max(0, num(channel.balance, 0));
  }, 0);
}

export function formatPoints(value) {
  const safe = Math.max(0, Math.round(num(value, 0)));
  return String(safe).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
}
