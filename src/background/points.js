import { MAX_TRACKED_CHANNELS, queries } from '../shared/constants.js';
import {
  buildChannelWatchList,
  claimKey,
  isPointsClaimSuccessful,
  normalizeChannelPoints,
  normalizeTrackedChannels,
} from '../shared/points-model.js';
import { ERROR_CODES, TwitchApiError, describeError, errorFromGqlMessage, firstGqlError } from '../shared/errors.js';
import { channelLoginFromUrl, normalizeLogin } from '../shared/twitch-url.js';
import { addHistory } from './state.js';

const POINTS_BATCH_SIZE = 8;
const RECENT_CLAIM_TTL_MS = 60 * 60_000;

function chunk(list, size) {
  const chunks = [];
  for (let index = 0; index < list.length; index += size) {
    chunks.push(list.slice(index, index + size));
  }
  return chunks;
}

export class PointsService {
  constructor({
    store,
    gql,
    session,
    notify,
    tabsApi = null,
    onUpdate = null,
    logger = console,
  }) {
    this.store = store;
    this.gql = gql;
    this.session = session;
    this.notify = notify;
    this.tabsApi = tabsApi || chrome.tabs;
    this.onUpdate = onUpdate;
    this.logger = logger;
    this.inflight = null;
    this.lastDomClaimAt = new Map();
  }

  async openTabs() {
    try {
      const tabs = await this.tabsApi.query({
        url: ['https://www.twitch.tv/*', 'https://player.twitch.tv/*'],
      });
      return (tabs || [])
        .map((tab) => ({
          tabId: typeof tab.id === 'number' ? tab.id : null,
          login: channelLoginFromUrl(tab.url || ''),
          url: tab.url || '',
        }))
        .filter((tab) => tab.tabId != null && tab.login);
    } catch (error) {
      this.logger.warn?.('[TwitchAutoPilot] could not read open tabs', error);
      return [];
    }
  }

  async #ensureAuth() {
    const session = await this.session.get();
    if (!session?.token) {
      const error = new TwitchApiError('No Twitch auth token', { code: ERROR_CODES.AUTH });
      await this.store.update((state) => {
        state.session = {
          authenticated: false,
          error: describeError(error),
          checkedAt: Date.now(),
        };
        state.points.error = describeError(error);
        return state;
      });
      throw error;
    }
    return session;
  }

  async refresh({ claim = true } = {}) {
    if (this.inflight) return this.inflight;
    this.inflight = this.#refresh(claim).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async #refresh(claim) {
    await this.#ensureAuth();
    const state = await this.store.get();
    const openTabs = await this.openTabs();
    const watchList = buildChannelWatchList({
      tracked: state.points.tracked,
      openLogins: openTabs.map((tab) => tab.login),
      max: MAX_TRACKED_CHANNELS,
    });

    if (watchList.length === 0) {
      await this.store.update((current) => {
        current.points.channels = {};
        current.points.lastSync = Date.now();
        current.points.error = null;
        return current;
      });
      this.onUpdate?.();
      return this.store.get();
    }

    const previousChannels = state.points.channels || {};
    const fetched = {};
    let successful = 0;
    let lastError = null;

    for (const batch of chunk(watchList, POINTS_BATCH_SIZE)) {
      let responses;
      try {
        responses = await this.gql.batch(
          batch.map((item) => queries.channelPointsContext(item.login)),
        );
      } catch (error) {
        if (error?.code === ERROR_CODES.AUTH || error?.code === ERROR_CODES.INTEGRITY) {
          await this.store.update((current) => {
            current.session = {
              authenticated: false,
              error: describeError(error),
              checkedAt: Date.now(),
            };
            current.points.error = describeError(error);
            return current;
          });
          this.onUpdate?.();
          throw error;
        }
        lastError = error;
        for (const item of batch) {
          const previous = previousChannels[item.login];
          if (previous) fetched[item.login] = { ...previous, ...item };
        }
        continue;
      }

      batch.forEach((item, index) => {
        const response = responses[index] || {};
        const message = firstGqlError(response);
        if (message) {
          const gqlError = errorFromGqlMessage(message);
          lastError = gqlError;
          const previous = previousChannels[item.login];
          if (previous) {
            fetched[item.login] = {
              ...previous,
              ...item,
              error: describeError(gqlError),
            };
          } else {
            fetched[item.login] = {
              login: item.login,
              displayName: item.login,
              channelId: '',
              avatarUrl: '',
              balance: 0,
              availableClaimId: '',
              multiplier: 1,
              isLive: false,
              gameName: '',
              streamTitle: '',
              updatedAt: Date.now(),
              tracked: item.tracked,
              open: item.open,
              error: describeError(gqlError),
            };
          }
          return;
        }
        const parsed = normalizeChannelPoints(response, item.login);
        if (!parsed) {
          lastError = new TwitchApiError('Channel points context is empty', {
            code: ERROR_CODES.NOT_FOUND,
          });
          const previous = previousChannels[item.login];
          if (previous) fetched[item.login] = { ...previous, ...item };
          return;
        }
        successful += 1;
        fetched[item.login] = {
          ...parsed,
          tracked: item.tracked,
          open: item.open,
          error: null,
        };
      });
    }

    await this.store.update((current) => {
      current.points.channels = fetched;
      current.points.lastSync = Date.now();
      current.points.error =
        successful === 0 && lastError ? describeError(lastError) : null;
      if (successful > 0) {
        current.session = {
          authenticated: true,
          error: null,
          checkedAt: Date.now(),
        };
      }
      current.points.recentClaims = pruneRecentClaims(current.points.recentClaims);
      return current;
    });

    if (claim) {
      const settings = (await this.store.get()).settings;
      if (settings.autoClaimPoints) {
        const tabByLogin = new Map(openTabs.map((tab) => [tab.login, tab.tabId]));
        for (const item of watchList) {
          const channel = fetched[item.login];
          if (!channel?.availableClaimId) continue;
          try {
            const clicked = await this.tryDomClaim(item.login, tabByLogin.get(item.login));
            if (!clicked) {
              await this.claimPoints({
                login: item.login,
                channelId: channel.channelId,
                claimId: channel.availableClaimId,
                source: 'gql',
              });
            }
          } catch (error) {
            this.logger.warn?.('[TwitchAutoPilot] points claim failed', error);
          }
        }
      }
    }

    this.onUpdate?.();
    return this.store.get();
  }

  async tryDomClaim(login, tabId, { key = '', displayName = '' } = {}) {
    if (!tabId || !login) return false;
    const last = this.lastDomClaimAt.get(login) || 0;
    if (Date.now() - last < 90_000) return false;
    try {
      const response = await this.tabsApi.sendMessage(tabId, { type: 'CHECK_BONUS' });
      if (response?.clicked) {
        this.lastDomClaimAt.set(login, Date.now());
        const bucket = Math.floor(Date.now() / (5 * 60_000));
        await this.recordClaim({
          login,
          displayName: displayName || login,
          key: key || `dom::${login}::${bucket}`,
          source: 'dom',
        });
        return true;
      }
    } catch {
      // Tab is loading, discarded, or has no content script yet.
    }
    return false;
  }

  async tickBonusTabs() {
    const settings = (await this.store.get()).settings;
    if (!settings.autoClaimPoints) return;
    const tabs = await this.openTabs();
    if (tabs.length === 0) return;
    for (const tab of tabs) {
      try {
        const response = await this.tabsApi.sendMessage(tab.tabId, { type: 'CHECK_BONUS' });
        if (response?.clicked) {
          this.lastDomClaimAt.set(tab.login, Date.now());
          const bucket = Math.floor(Date.now() / (5 * 60_000));
          await this.recordClaim({
            login: tab.login,
            displayName: tab.login,
            key: `dom::${tab.login}::${bucket}`,
            source: 'dom',
          });
          await this.refreshChannel(tab.login).catch(() => {});
        }
      } catch {
        // Content script not ready in this tab; the pubsub/GQL path still works.
      }
    }
  }

  async handleClaimAvailable({ channelId, claimId, tabId = null, channelLogin = '' }) {
    if (!claimId || !channelId) return { ok: false };
    const state = await this.store.get();
    const key = claimKey(channelId, claimId);
    if (state.points.recentClaims?.[key]) return { ok: true, deduped: true };

    let login = normalizeLogin(channelLogin);
    if (!login) {
      const match = Object.values(state.points.channels || {}).find(
        (channel) => channel.channelId === String(channelId),
      );
      login = match?.login || '';
    }

    if (tabId != null && login) {
      const clicked = await this.tryDomClaim(login, tabId, { key });
      if (clicked) return { ok: true, source: 'dom' };
    }

    try {
      await this.claimPoints({ login, channelId, claimId, source: 'pubsub' });
      if (login) await this.refreshChannel(login).catch(() => {});
      return { ok: true, source: 'gql' };
    } catch (error) {
      this.logger.warn?.('[TwitchAutoPilot] pubsub points claim failed', error);
      return { ok: false, error: describeError(error) };
    }
  }

  async claimPoints({ login = '', channelId, claimId, source = 'gql' }) {
    if (!channelId || !claimId) {
      throw new TwitchApiError('Missing channel points claim data', {
        code: ERROR_CODES.NOT_FOUND,
      });
    }
    const state = await this.store.get();
    const key = claimKey(channelId, claimId);
    if (state.points.recentClaims?.[key]) return { ok: true, deduped: true };
    const channel =
      (login && state.points.channels[login]) ||
      Object.values(state.points.channels || {}).find(
        (item) => item.channelId === String(channelId),
      );

    const payload = await this.gql.request(queries.claimCommunityPoints(claimId, channelId));
    if (!isPointsClaimSuccessful(payload)) {
      throw new TwitchApiError('Twitch не подтвердил бонус канала', {
        code: ERROR_CODES.UNKNOWN,
      });
    }
    await this.recordClaim({
      login: login || channel?.login || '',
      displayName: channel?.displayName || login || '',
      key,
      source,
    });
    return { ok: true, status: 'claimed' };
  }

  async recordClaim({ login, displayName, key, source = 'gql' }) {
    let recorded = false;
    await this.store.update((state) => {
      if (key && state.points.recentClaims?.[key]) return state;
      state.points.recentClaims = {
        ...pruneRecentClaims(state.points.recentClaims),
        [key]: Date.now(),
      };
      if (login && state.points.channels[login]) {
        state.points.channels[login] = {
          ...state.points.channels[login],
          availableClaimId: '',
          error: null,
        };
      }
      state.points.lastClaimAt = Date.now();
      state.stats.pointsBonuses += 1;
      addHistory(state, {
        type: 'points',
        title: 'Бонус канала',
        subtitle: displayName || login || 'Twitch',
        imageUrl: login ? state.points.channels[login]?.avatarUrl || '' : '',
      });
      recorded = true;
      return state;
    });
    if (recorded) {
      await this.notify?.pointsClaimed({ channelLogin: login, displayName });
      this.onUpdate?.();
    }
    return recorded;
  }

  async refreshChannel(login) {
    const safeLogin = normalizeLogin(login);
    if (!safeLogin) return null;
    try {
      const data = await this.gql.data(queries.channelPointsContext(safeLogin));
      const parsed = normalizeChannelPoints(data, safeLogin);
      if (!parsed) return null;
      await this.store.update((state) => {
        const previous = state.points.channels[safeLogin] || {};
        state.points.channels[safeLogin] = {
          ...previous,
          ...parsed,
          tracked: Boolean(previous.tracked),
          open: Boolean(previous.open),
          error: null,
        };
        return state;
      });
      this.onUpdate?.();
      return parsed;
    } catch (error) {
      this.logger.warn?.('[TwitchAutoPilot] channel refresh failed', error);
      return null;
    }
  }

  async addTracked(rawLogin) {
    const login = normalizeLogin(rawLogin);
    if (!login) {
      throw new TwitchApiError('Некорректное имя канала', { code: ERROR_CODES.NOT_FOUND });
    }
    const state = await this.store.get();
    const tracked = normalizeTrackedChannels(state.points.tracked);
    if (tracked.some((item) => item.login === login)) {
      return { ok: true, alreadyTracked: true };
    }
    if (tracked.length >= MAX_TRACKED_CHANNELS) {
      throw new TwitchApiError(`Можно отслеживать не больше ${MAX_TRACKED_CHANNELS} каналов`, {
        code: ERROR_CODES.UNKNOWN,
      });
    }
    tracked.push({ login, addedAt: Date.now() });
    await this.store.update((current) => {
      current.points.tracked = tracked;
      current.points.channels[login] = {
        ...(current.points.channels[login] || {
          login,
          channelId: '',
          displayName: login,
          avatarUrl: '',
          balance: 0,
          availableClaimId: '',
          multiplier: 1,
          isLive: false,
          gameName: '',
          streamTitle: '',
          updatedAt: 0,
          error: null,
        }),
        tracked: true,
        login,
      };
      return current;
    });
    this.onUpdate?.();
    this.refresh({ claim: true }).catch(() => {});
    return { ok: true };
  }

  async removeTracked(rawLogin) {
    const login = normalizeLogin(rawLogin);
    if (!login) return { ok: true };
    await this.store.update((state) => {
      state.points.tracked = normalizeTrackedChannels(state.points.tracked).filter(
        (item) => item.login !== login,
      );
      if (state.points.channels[login]) {
        state.points.channels[login] = {
          ...state.points.channels[login],
          tracked: false,
        };
        if (!state.points.channels[login].open) delete state.points.channels[login];
      }
      return state;
    });
    this.onUpdate?.();
    return { ok: true };
  }
}

function pruneRecentClaims(map) {
  const now = Date.now();
  const result = {};
  for (const [key, timestamp] of Object.entries(map || {})) {
    if (Number(timestamp) > now - RECENT_CLAIM_TTL_MS) result[key] = timestamp;
  }
  return result;
}
