import { HISTORY_LIMIT, LEGACY, STORAGE } from '../shared/constants.js';
import { normalizeSettings } from '../shared/settings.js';
import { normalizeTrackedChannels } from '../shared/points-model.js';
import { randomHex } from '../shared/session-utils.js';

export const STATE_VERSION = 1;

export function createDefaultState() {
  return {
    version: STATE_VERSION,
    settings: normalizeSettings(null),
    user: null,
    session: { authenticated: false, error: null, checkedAt: 0 },
    drops: {
      campaigns: [],
      available: [],
      lastSync: 0,
      error: null,
      claimFailures: {},
      lastClaimAt: 0,
    },
    points: {
      channels: {},
      tracked: [],
      lastSync: 0,
      error: null,
      lastClaimAt: 0,
      recentClaims: {},
    },
    farm: {
      enabled: false,
      tabId: null,
      channelLogin: null,
      channelDisplayName: '',
      campaignId: null,
      campaignName: '',
      campaignIds: [],
      campaignNames: [],
      gameName: '',
      gameSlug: '',
      startedAt: 0,
      lastSwitchAt: 0,
      lastProgressMark: null,
      lastProgressAt: 0,
      error: null,
    },
    history: [],
    stats: {
      dropsClaimed: 0,
      pointsBonuses: 0,
    },
  };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function sanitizeChannelMap(raw) {
  const result = {};
  for (const [login, channel] of Object.entries(asObject(raw))) {
    if (!channel || typeof channel !== 'object') continue;
    if (typeof login !== 'string' || !login) continue;
    result[login] = {
      login,
      channelId: String(channel.channelId || ''),
      displayName: String(channel.displayName || login),
      avatarUrl: typeof channel.avatarUrl === 'string' ? channel.avatarUrl : '',
      balance: Math.max(0, Math.round(asNumber(channel.balance))),
      availableClaimId: String(channel.availableClaimId || ''),
      multiplier: Math.max(1, asNumber(channel.multiplier, 1)),
      isLive: Boolean(channel.isLive),
      gameName: String(channel.gameName || ''),
      streamTitle: String(channel.streamTitle || ''),
      updatedAt: asNumber(channel.updatedAt),
      error: typeof channel.error === 'string' ? channel.error : null,
      tracked: Boolean(channel.tracked),
      open: Boolean(channel.open),
    };
  }
  return result;
}

function sanitizeStringList(raw, fallback = '') {
  const list = asArray(raw)
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .slice(0, 40);
  if (list.length === 0 && typeof fallback === 'string' && fallback.trim()) {
    return [fallback.trim()];
  }
  return list;
}

function sanitizeHistory(raw) {
  return asArray(raw)
    .filter((item) => item && typeof item === 'object')
    .slice(0, HISTORY_LIMIT)
    .map((item) => ({
      id: String(item.id || randomHex(12)),
      type: item.type === 'points' ? 'points' : 'drop',
      title: String(item.title || 'Награда'),
      subtitle: String(item.subtitle || ''),
      imageUrl: typeof item.imageUrl === 'string' ? item.imageUrl : '',
      amount: Math.max(0, Math.round(asNumber(item.amount))),
      at: asNumber(item.at),
    }));
}

export function normalizeState(raw) {
  const base = createDefaultState();
  if (!raw || typeof raw !== 'object' || raw.version !== STATE_VERSION) return base;
  const drops = asObject(raw.drops);
  const points = asObject(raw.points);
  const farm = asObject(raw.farm);
  const stats = asObject(raw.stats);
  return {
    version: STATE_VERSION,
    settings: normalizeSettings(raw.settings),
    user:
      raw.user && typeof raw.user === 'object'
        ? {
            id: String(raw.user.id || ''),
            login: String(raw.user.login || ''),
            displayName: String(raw.user.displayName || raw.user.login || ''),
          }
        : null,
    session: {
      authenticated: Boolean(raw.session?.authenticated),
      error: typeof raw.session?.error === 'string' ? raw.session.error : null,
      checkedAt: asNumber(raw.session?.checkedAt),
    },
    drops: {
      campaigns: asArray(drops.campaigns).filter((c) => c && typeof c === 'object'),
      available: asArray(drops.available).filter((c) => c && typeof c === 'object'),
      lastSync: asNumber(drops.lastSync),
      error: typeof drops.error === 'string' ? drops.error : null,
      claimFailures: asObject(drops.claimFailures),
      lastClaimAt: asNumber(drops.lastClaimAt),
    },
    points: {
      channels: sanitizeChannelMap(points.channels),
      tracked: normalizeTrackedChannels(points.tracked),
      lastSync: asNumber(points.lastSync),
      error: typeof points.error === 'string' ? points.error : null,
      lastClaimAt: asNumber(points.lastClaimAt),
      recentClaims: asObject(points.recentClaims),
    },
    farm: {
      enabled: Boolean(farm.enabled),
      tabId: farm.tabId != null && Number.isFinite(Number(farm.tabId)) ? Number(farm.tabId) : null,
      channelLogin: farm.channelLogin ? String(farm.channelLogin) : null,
      channelDisplayName: String(farm.channelDisplayName || ''),
      campaignId: farm.campaignId ? String(farm.campaignId) : null,
      campaignName: String(farm.campaignName || ''),
      campaignIds: sanitizeStringList(farm.campaignIds, farm.campaignId),
      campaignNames: sanitizeStringList(farm.campaignNames, farm.campaignName),
      gameName: String(farm.gameName || ''),
      gameSlug: String(farm.gameSlug || ''),
      startedAt: asNumber(farm.startedAt),
      lastSwitchAt: asNumber(farm.lastSwitchAt),
      lastProgressMark: farm.lastProgressMark == null ? null : asNumber(farm.lastProgressMark),
      lastProgressAt: asNumber(farm.lastProgressAt),
      error: typeof farm.error === 'string' ? farm.error : null,
    },
    history: sanitizeHistory(raw.history),
    stats: {
      dropsClaimed: Math.max(0, Math.round(asNumber(stats.dropsClaimed))),
      pointsBonuses: Math.max(0, Math.round(asNumber(stats.pointsBonuses))),
    },
  };
}

export function addHistory(state, entry, now = Date.now()) {
  const item = {
    id: `${now.toString(36)}-${randomHex(8)}`,
    at: now,
    type: entry.type === 'points' ? 'points' : 'drop',
    title: String(entry.title || 'Награда'),
    subtitle: String(entry.subtitle || ''),
    imageUrl: typeof entry.imageUrl === 'string' ? entry.imageUrl : '',
    amount: Math.max(0, Math.round(Number(entry.amount) || 0)),
  };
  state.history = [item, ...asArray(state.history)].slice(0, HISTORY_LIMIT);
  return item;
}

/**
 * Serialized state holder. Every mutation goes through one promise chain so
 * alarm handlers and popup messages cannot overwrite each other.
 */
export class StateStore {
  constructor({ area = null, logger = console, onChange = null } = {}) {
    this.area = area || chrome.storage.local;
    this.logger = logger;
    this.onChange = onChange;
    this.state = null;
    this.queue = Promise.resolve();
    this.loaded = null;
  }

  async load() {
    if (this.loaded) return this.loaded;
    this.loaded = (async () => {
      let raw = null;
      let migrated = false;
      try {
        const stored = await this.area.get(STORAGE.state);
        raw = stored?.[STORAGE.state] || null;
        if (!raw) {
          // 1.3.0 renamed the extension: pick up state written by DropPilot.
          const legacy = await this.area.get(LEGACY.state);
          raw = legacy?.[LEGACY.state] || null;
          migrated = Boolean(raw);
        }
      } catch (error) {
        this.logger.warn?.('[TwitchAutoPilot] could not read state', error);
      }
      this.state = normalizeState(raw);
      if (migrated) {
        try {
          await this.area.set({ [STORAGE.state]: this.state });
          if (typeof this.area.remove === 'function') await this.area.remove(LEGACY.state);
        } catch (error) {
          this.logger.warn?.('[TwitchAutoPilot] could not migrate state', error);
        }
      }
      return this.state;
    })();
    return this.loaded;
  }

  async get() {
    if (!this.state) await this.load();
    return this.state;
  }

  async #persist() {
    try {
      await this.area.set({ [STORAGE.state]: this.state });
      this.onChange?.(this.state);
    } catch (error) {
      this.logger.warn?.('[TwitchAutoPilot] could not persist state', error);
    }
  }

  async update(mutator) {
    const run = async () => {
      if (!this.state) await this.load();
      const result = await mutator(this.state);
      if (result && typeof result === 'object') this.state = result;
      await this.#persist();
      return this.state;
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async flush() {
    await this.queue;
  }
}
