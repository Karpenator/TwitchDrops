import { queries, directoryFallbackPayload } from '../shared/constants.js';
import {
  campaignGameKey,
  campaignPool,
  campaignPlayDisabledReason,
  groupFarmableCampaigns,
  groupWatchMark,
  isFarmableCampaign,
  pickCandidate,
  sortFarmGroups,
} from '../shared/drops-model.js';
import { channelLoginFromUrl, channelUrl } from '../shared/twitch-url.js';
import { describeError } from '../shared/errors.js';

const STALE_PROGRESS_MS = 3 * 60_000;
const DROPS_STALE_MS = 60_000;
const SWITCH_COOLDOWN_MS = 3 * 60_000;
const STREAM_BATCH_SIZE = 10;

function chunk(list, size) {
  const chunks = [];
  for (let index = 0; index < list.length; index += size) {
    chunks.push(list.slice(index, index + size));
  }
  return chunks;
}

function parseStreamInfo(payload, fallbackLogin) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload || {};
  const user = data.user && typeof data.user === 'object' ? data.user : null;
  const stream = user?.stream;
  if (!user || !stream?.id) return null;
  const game = stream.game || user.broadcastSettings?.game || null;
  return {
    login: String(user.login || fallbackLogin || '').toLowerCase(),
    displayName: String(user.displayName || user.login || fallbackLogin || ''),
    viewers: Math.max(0, Number(stream.viewersCount) || 0),
    gameName: String(game?.displayName || game?.name || ''),
    gameSlug: String(game?.slug || ''),
    isLive: true,
  };
}

function gameMatches(campaign, candidate) {
  const campaignSlug = String(campaign?.game?.slug || '').toLowerCase();
  const campaignName = String(campaign?.game?.name || '').toLowerCase();
  const slug = String(candidate?.gameSlug || '').toLowerCase();
  const name = String(candidate?.gameName || '').toLowerCase();
  if (campaignSlug && slug) return campaignSlug === slug;
  if (campaignName && name) return campaignName === name;
  return false;
}

function isAllowedChannel(campaign, login) {
  if (!campaign?.allowedChannels?.length) return true;
  return campaign.allowedChannels.some((channel) => channel.login === login);
}

export class FarmService {
  constructor({ store, gql, drops, notify, tabsApi = null, onUpdate = null, logger = console }) {
    this.store = store;
    this.gql = gql;
    this.drops = drops;
    this.notify = notify;
    this.tabsApi = tabsApi || chrome.tabs;
    this.onUpdate = onUpdate;
    this.logger = logger;
    this.queue = Promise.resolve();
  }

  async streamInfos(logins) {
    const result = new Map();
    const valid = [...new Set(logins.filter(Boolean))];
    for (const batch of chunk(valid, STREAM_BATCH_SIZE)) {
      const responses = await this.gql
        .batch(batch.map((login) => queries.streamInfo(login)))
        .catch(() => []);
      batch.forEach((login, index) => {
        const info = parseStreamInfo(responses[index], login);
        if (info && info.isLive) result.set(login, info);
      });
    }
    return result;
  }

  async streamInfo(login) {
    if (!login) return null;
    try {
      const data = await this.gql.data(queries.streamInfo(login));
      return parseStreamInfo(data, login);
    } catch {
      return null;
    }
  }

  /** Campaigns of the group that are eligible on a live channel. */
  #eligibleCampaigns(campaigns, login, info) {
    return campaigns.filter(
      (campaign) => isAllowedChannel(campaign, login) && gameMatches(campaign, info),
    );
  }

  async #directoryCandidates(campaign) {
    const slug = campaign?.game?.slug || '';
    if (!slug && !campaign?.game?.name) return [];
    let response;
    try {
      const fallback = directoryFallbackPayload(campaign.game.name, slug);
      response = await this.gql.request(
        slug ? queries.directoryGame(campaign.game.name, slug) : fallback,
        { rawFallback: fallback },
      );
    } catch (error) {
      this.logger.warn?.('[TwitchAutoPilot] directory query failed', error);
      return [];
    }
    const payload = Array.isArray(response) ? response[0] : response;
    const edges = payload?.data?.game?.streams?.edges || [];
    const candidates = [];
    for (const edge of edges) {
      const node = edge?.node;
      const broadcaster = node?.broadcaster;
      const login = String(broadcaster?.login || '').toLowerCase();
      if (!login) continue;
      const game = node?.game || {};
      const candidate = {
        login,
        displayName: broadcaster?.displayName || login,
        viewers: Math.max(0, Number(node?.viewersCount) || 0),
        gameName: String(game.displayName || game.name || campaign.game.name || ''),
        gameSlug: String(game.slug || payload?.data?.game?.slug || slug),
        isLive: true,
      };
      if (!gameMatches(campaign, candidate)) continue;
      candidates.push(candidate);
    }
    return candidates;
  }

  /**
   * Every live channel that can advance at least one campaign of the group:
   * allow-listed channels plus the game directory for open campaigns.
   */
  async #collectCandidates(group) {
    const candidates = new Map();
    const aclLogins = new Set();
    for (const campaign of group.campaigns) {
      for (const channel of campaign.allowedChannels || []) aclLogins.add(channel.login);
    }
    if (aclLogins.size > 0) {
      const infos = await this.streamInfos([...aclLogins]);
      for (const [login, info] of infos) {
        if (this.#eligibleCampaigns(group.campaigns, login, info).length > 0) {
          candidates.set(login, info);
        }
      }
    }
    const hasOpenCampaign = group.campaigns.some(
      (campaign) => !campaign.allowedChannels?.length,
    );
    if (hasOpenCampaign || aclLogins.size === 0) {
      const directory = await this.#directoryCandidates(group.campaigns[0]);
      for (const candidate of directory) {
        if (!candidates.has(candidate.login)) candidates.set(candidate.login, candidate);
      }
    }
    return [...candidates.values()];
  }

  /**
   * Prefer channels that advance as many campaigns of the group as possible
   * (Twitch credits all campaigns live on a channel), then apply the chosen
   * viewer strategy within that best-overlap set.
   */
  #choose(group, candidates, excludeLogin, { hardExclude = false, requiredCampaignId = '' } = {}) {
    const settings = this.store.state?.settings || {};
    const scored = [];
    for (const candidate of candidates) {
      const eligible = this.#eligibleCampaigns(group.campaigns, candidate.login, candidate);
      if (eligible.length === 0) continue;
      if (requiredCampaignId && !eligible.some((campaign) => campaign.id === requiredCampaignId)) continue;
      scored.push({ ...candidate, campaigns: eligible });
    }
    const pool =
      hardExclude && excludeLogin
        ? scored.filter((candidate) => candidate.login !== excludeLogin)
        : scored;
    if (pool.length === 0) return null;
    const bestOverlap = Math.max(...pool.map((candidate) => candidate.campaigns.length));
    const best = pool.filter((candidate) => candidate.campaigns.length === bestOverlap);
    const choice = pickCandidate(best, {
      strategy: settings.farmStrategy || 'random',
      excludeLogin: excludeLogin || '',
    });
    if (!choice) return null;
    const campaigns = [...choice.campaigns].sort(
      (a, b) =>
        Number(b.id === requiredCampaignId) - Number(a.id === requiredCampaignId) ||
        (a.endsAt || Number.MAX_SAFE_INTEGER) - (b.endsAt || Number.MAX_SAFE_INTEGER) ||
        (a.remainingMinutes || 0) - (b.remainingMinutes || 0),
    );
    return {
      campaigns,
      campaign: campaigns[0],
      channel: {
        login: choice.login,
        displayName: choice.displayName || choice.login,
        viewers: choice.viewers || 0,
        gameName: choice.gameName || group.game?.name || '',
        gameSlug: choice.gameSlug || group.game?.slug || '',
        isLive: true,
      },
    };
  }

  /**
   * Choose the next watch target. Campaigns are grouped by game because only
   * same-game campaigns can progress at the same time; groups are scheduled
   * one after another so every campaign eventually gets its turn.
   */
  async pickTarget({
    excludeLogin = '',
    campaignIds = [],
    allowOtherGroup = true,
    hardExclude = false,
    requiredCampaignId = '',
  } = {}) {
    const state = await this.store.get();
    const manualIds = [requiredCampaignId, state.farm.manualCampaignId].filter(Boolean);
    const groups = sortFarmGroups(groupFarmableCampaigns(campaignPool(state.drops), Date.now(), {
      allowUnlinkedIds: manualIds,
    }), { priority: state.settings.farmPriority });
    const preferred = groups.find((group) =>
      group.campaigns.some((campaign) => campaignIds.includes(campaign.id)),
    );
    // Check the requested/current game first, then every other group in order.
    // One offline category must not starve all the categories after it.
    const ordered = preferred ? [preferred, ...groups.filter((group) => group !== preferred)] : groups;
    const eligibleGroups = allowOtherGroup ? ordered : preferred ? [preferred] : [];
    for (const group of eligibleGroups) {
      const candidates = await this.#collectCandidates(group);
      const target = this.#choose(group, candidates, excludeLogin, { hardExclude, requiredCampaignId });
      if (target) {
        return {
          ...target,
          manualCampaignId: manualIds.find((id) => target.campaigns.some((campaign) => campaign.id === id)) || null,
        };
      }
    }
    return null;
  }

  /** Serialize navigation: an alarm must not undo a Play/Stop/Skip request. */
  #run(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }

  play(campaignId) {
    return this.#run(() => this.#play(String(campaignId || '')));
  }

  /** Force the selected campaign, including its channel restrictions. */
  async #play(campaignId) {
    let state = await this.store.get();
    let campaign = campaignPool(state.drops).find((item) => item.id === campaignId);
    const blocked = campaignPlayDisabledReason(campaign);
    if (blocked) return { ok: false, message: blocked };

    // Account linking is not a playback prerequisite. Refresh only stale or
    // incomplete metadata, including a campaign whose scheduled start passed.
    if (
      !campaign.active || campaign.upcoming ||
      !campaign.drops?.length || Date.now() - state.drops.lastSync > DROPS_STALE_MS
    ) {
      await this.drops.refresh({ claim: false });
      state = await this.store.get();
      campaign = campaignPool(state.drops).find((item) => item.id === campaignId);
    }
    const refreshedBlock = campaignPlayDisabledReason(campaign);
    if (refreshedBlock) return { ok: false, message: refreshedBlock };
    if (!campaign.drops?.length) {
      return { ok: false, message: 'Не удалось загрузить награды кампании. Обновите список и попробуйте снова.' };
    }
    if (!isFarmableCampaign(campaign, Date.now(), { allowUnlinked: true })) {
      return { ok: false, message: 'В этой кампании сейчас нет доступных для просмотра наград' };
    }
    const target = await this.pickTarget({
      campaignIds: [campaignId],
      allowOtherGroup: false,
      requiredCampaignId: campaignId,
    });
    if (!target) {
      return { ok: false, message: 'Для выбранной кампании сейчас нет подходящих каналов в эфире' };
    }
    const wasEnabled = state.settings.autoFarm;
    await this.store.update((current) => {
      current.settings.autoFarm = true;
      return current;
    });
    const tabId = await this.#applyTarget(target, { reuseTabId: state.farm.tabId });
    if (tabId == null) {
      await this.store.update((current) => {
        current.settings.autoFarm = wasEnabled;
        return current;
      });
      return { ok: false, message: 'Не удалось открыть вкладку Twitch' };
    }
    return {
      ok: true,
      channel: target.channel,
      warning: campaign.linked === false
        ? 'Просмотр запущен без привязки игрового аккаунта. Получение наград зависит от привязки.'
        : null,
    };
  }

  start() {
    return this.#run(() => this.#start());
  }

  async #start() {
    await this.store.update((state) => {
      state.farm.enabled = true;
      state.farm.startedAt = state.farm.startedAt || Date.now();
      state.farm.error = null;
      state.settings.autoFarm = true;
      return state;
    });
    await this.#tick();
    return this.store.get();
  }

  stop(options = {}) {
    return this.#run(() => this.#stop(options));
  }

  async #stop({ closeTab = true, reason = null } = {}) {
    const state = await this.store.get();
    const tabId = state.farm.tabId;
    await this.store.update((current) => {
      current.settings.autoFarm = false;
      current.farm = {
        ...current.farm,
        enabled: false,
        tabId: null,
        channelLogin: null,
        channelDisplayName: '',
        campaignId: null,
        manualCampaignId: null,
        campaignName: '',
        campaignIds: [],
        campaignNames: [],
        gameName: '',
        gameSlug: '',
        startedAt: 0,
        lastProgressMark: null,
        lastProgressAt: 0,
        error: reason,
      };
      current.farm.enabled = false;
      return current;
    });
    if (!closeTab && tabId != null && typeof this.tabsApi.sendMessage === 'function') {
      // Drop the farm flag when the tab stays open.
      this.tabsApi
        .sendMessage(tabId, { type: 'GUARD_CONFIG', enabled: true, farm: false })
        .catch(() => {});
    }
    if (closeTab && tabId != null) {
      await this.tabsApi.remove(tabId).catch(() => {});
    }
    this.onUpdate?.();
    return this.store.get();
  }

  handleTabRemoved(tabId) {
    return this.#run(() => this.#handleTabRemoved(tabId));
  }

  async #handleTabRemoved(tabId) {
    const state = await this.store.get();
    if (state.farm.tabId !== tabId) return;
    await this.store.update((current) => {
      current.settings.autoFarm = false;
      current.farm = {
        ...current.farm,
        enabled: false,
        tabId: null,
        channelLogin: null,
        channelDisplayName: '',
        campaignId: null,
        manualCampaignId: null,
        campaignName: '',
        campaignIds: [],
        campaignNames: [],
        gameName: '',
        gameSlug: '',
        startedAt: 0,
        lastProgressMark: null,
        lastProgressAt: 0,
        error: 'Вкладка автофермы закрыта',
      };
      return current;
    });
    await this.notify?.show({
      title: 'Автоферма остановлена',
      message: 'Вкладка Twitch была закрыта. Включите автоферму снова в настройках.',
      url: channelUrl(state.farm.channelLogin || ''),
    });
    this.onUpdate?.();
  }

  tick(options = {}) {
    return this.#run(() => this.#tick(options));
  }

  /** A raid/redirect must not leave the farm watching an unrelated channel. */
  handleNavigation(tabId) {
    return this.#run(async () => {
      const state = await this.store.get();
      if (tabId == null || tabId !== state.farm.tabId || !state.settings.autoFarm ||
          !state.farm.enabled || !state.farm.channelLogin) return;
      const tab = await this.tabsApi.get(tabId).catch(() => null);
      if (!tab) return;
      // Use the browser's actual URL, never a login supplied by a page message.
      const login = channelLoginFromUrl(tab.pendingUrl || tab.url || '');
      if (login === state.farm.channelLogin) return;
      // Revalidate the selected stream: restore it if still eligible, otherwise
      // find another drops channel. The raid destination is never blindly adopted.
      return this.#tick({ refreshDrops: false });
    });
  }

  #currentGameKey(state) {
    const ids = state.farm.campaignIds?.length
      ? state.farm.campaignIds
      : [state.farm.campaignId];
    const campaign = campaignPool(state.drops).find((item) => ids.includes(item.id));
    return campaignGameKey(campaign || { game: { slug: state.farm.gameSlug, name: state.farm.gameName } });
  }

  /** All still-watchable campaigns of the current game on the current channel. */
  #groupFromFarm(state, now) {
    const key = this.#currentGameKey(state);
    const group = groupFarmableCampaigns(campaignPool(state.drops), now, {
      allowUnlinkedIds: [state.farm.manualCampaignId],
    }).find((item) => item.key === key);
    if (!group) return null;
    const campaigns = group.campaigns.filter((campaign) =>
      isAllowedChannel(campaign, state.farm.channelLogin),
    );
    return campaigns.length ? { ...group, campaigns } : null;
  }

  /** Store the chosen target and make sure its tab exists and is muted. */
  async #applyTarget(target, { reuseTabId = null } = {}) {
    const now = Date.now();
    const channel = target.channel;
    const tabId = await this.#ensureTab(reuseTabId, channel.login);
    if (tabId == null) {
      await this.store.update((current) => {
        current.farm.error = 'Не удалось открыть вкладку Twitch для автофермы.';
        return current;
      });
      this.onUpdate?.();
      return null;
    }
    const primary = target.campaigns[0];
    await this.store.update((current) => {
      current.farm = {
        ...current.farm,
        enabled: true,
        tabId,
        channelLogin: channel.login,
        channelDisplayName: channel.displayName || channel.login,
        campaignId: primary.id,
        manualCampaignId: target.manualCampaignId || null,
        campaignName: primary.name,
        campaignIds: target.campaigns.map((campaign) => campaign.id),
        campaignNames: target.campaigns.map((campaign) => campaign.name),
        gameName: primary.game?.name || '',
        gameSlug: primary.game?.slug || '',
        startedAt: current.farm.startedAt || now,
        lastSwitchAt: now,
        lastProgressMark: groupWatchMark(target.campaigns),
        lastProgressAt: now,
        error: null,
      };
      return current;
    });
    await this.#applyTabSettings(tabId);
    this.onUpdate?.();
    return tabId;
  }

  async #tick({ refreshDrops = true } = {}) {
    let state = await this.store.get();
    if (!state.settings.autoFarm) {
      if (state.farm.tabId != null || state.farm.enabled) {
        await this.#stop({ closeTab: true });
      }
      return this.store.get();
    }

    // A running farm should not wait for a long user-configured sync interval.
    // Callers that just refreshed/claimed already have authoritative local state.
    if (refreshDrops && Date.now() - state.drops.lastSync > DROPS_STALE_MS) {
      try {
        await this.drops.refresh({ claim: true });
      } catch (error) {
        await this.store.update((current) => {
          current.farm.error = describeError(error);
          return current;
        });
        this.onUpdate?.();
        return this.store.get();
      }
      state = await this.store.get();
    }

    const now = Date.now();
    let group = null;
    let stale = false;

    if (state.farm.channelLogin && state.farm.tabId != null) {
      group = this.#groupFromFarm(state, now);
      if (group) {
        const info = await this.streamInfo(state.farm.channelLogin);
        const stillValid =
          Boolean(info?.isLive) &&
          group.campaigns.some(
            (campaign) =>
              isAllowedChannel(campaign, state.farm.channelLogin) &&
              gameMatches(campaign, info),
          );
        if (!stillValid) {
          group = null;
        } else {
          // New campaigns of the same game may have appeared while watching.
          const mark = groupWatchMark(group.campaigns);
          if (mark !== state.farm.lastProgressMark) {
            await this.store.update((current) => {
              current.farm.lastProgressMark = mark;
              current.farm.lastProgressAt = now;
              current.farm.campaignIds = group.campaigns.map((campaign) => campaign.id);
              current.farm.campaignNames = group.campaigns.map((campaign) => campaign.name);
              return current;
            });
            state = await this.store.get();
          } else if (
            state.settings.farmAutoSwitch &&
            state.farm.lastProgressAt > 0 &&
            now - state.farm.lastProgressAt >= STALE_PROGRESS_MS
          ) {
            stale = true;
          }
        }
      }
    }

    let target = null;
    const groupIds = group ? group.campaigns.map((campaign) => campaign.id) : [];
    if (!group) {
      // The current group finished or its channel stopped being eligible:
      // pick the next game group (rotation through every campaign).
      const key = this.#currentGameKey(state);
      target = await this.pickTarget({
        excludeLogin: state.farm.channelLogin || '',
        campaignIds: campaignPool(state.drops)
          .filter((campaign) => campaignGameKey(campaign) === key)
          .map((campaign) => campaign.id),
      });
    } else if (stale && now - state.farm.lastSwitchAt >= SWITCH_COOLDOWN_MS) {
      target = await this.pickTarget({
        excludeLogin: state.farm.channelLogin || '',
        campaignIds: groupIds,
        hardExclude: true,
      });
      if (!target) {
        // No alternative channel in any group — keep watching and retry later.
        await this.store.update((current) => {
          current.farm.lastProgressAt = now;
          return current;
        });
      }
    }

    if (target) {
      await this.#applyTarget(target, { reuseTabId: state.farm.tabId });
      return this.store.get();
    }

    if (!group) {
      await this.store.update((current) => {
        current.farm.error = 'Нет доступных каналов с дропсами. Попробуем снова через пару минут.';
        current.farm.campaignId = null;
        current.farm.campaignName = '';
        current.farm.campaignIds = [];
        current.farm.campaignNames = [];
        return current;
      });
      this.onUpdate?.();
      return this.store.get();
    }

    // Current channel/campaigns are still healthy.
    const tabId = await this.#ensureTab(state.farm.tabId, state.farm.channelLogin);
    if (tabId == null) {
      await this.store.update((current) => {
        current.farm.error = 'Вкладка автофермы недоступна.';
        return current;
      });
    } else {
      await this.#applyTabSettings(tabId);
      const health = await this.#tabHealth(tabId);
      let healthError = null;
      if (health?.ok) {
        if (health.hidden && !health.guardEnabled) {
          healthError =
            'Вкладка скрыта, а фоновый просмотр выключен — Twitch может не засчитывать дропсы. Включите «Фоновый просмотр» в настройках.';
        } else if (health.paused && !health.ended) {
          try {
            await this.tabsApi.sendMessage(tabId, { type: 'FARM_RESUME' });
          } catch {
            // Content script unavailable: the next tick retries.
          }
          healthError =
            'Плеер вкладки автофермы на паузе — TwitchAutoPilot возобновляет воспроизведение.';
        }
      }
      await this.store.update((current) => {
        current.farm.error = healthError;
        current.farm.enabled = true;
        current.farm.tabId = tabId;
        current.farm.campaignId = group.campaigns[0].id;
        current.farm.campaignName = group.campaigns[0].name;
        current.farm.campaignIds = group.campaigns.map((campaign) => campaign.id);
        current.farm.campaignNames = group.campaigns.map((campaign) => campaign.name);
        return current;
      });
    }
    this.onUpdate?.();
    return this.store.get();
  }

  async #ensureTab(tabId, login) {
    if (!login) return null;
    const url = channelUrl(login);
    if (tabId != null) {
      try {
        const tab = await this.tabsApi.get(tabId);
        const tabUrl = tab?.pendingUrl || tab?.url || '';
        const currentLogin = channelLoginFromUrl(tabUrl);
        // Also navigate when the tab sits on a non-channel Twitch page (for
        // example a stream that ended and redirected to the directory).
        if (currentLogin !== login) {
          await this.tabsApi.update(tabId, { url, active: false });
        }
        return tabId;
      } catch {
        // Tab was closed; fall through and open a new one.
      }
    }
    try {
      const tab = await this.tabsApi.create({
        url,
        active: false,
        pinned: false,
      });
      return typeof tab?.id === 'number' ? tab.id : null;
    } catch (error) {
      this.logger.warn?.('[TwitchAutoPilot] could not open farm tab', error);
      return null;
    }
  }

  async #applyTabSettings(tabId) {
    const state = await this.store.get();
    try {
      await this.tabsApi.sendMessage(tabId, {
        type: 'GUARD_CONFIG',
        enabled: state.settings.backgroundWatch !== false,
        farm: true,
      });
    } catch {
      // Content script is not ready yet; it asks for GET_GUARD on load and the
      // next tick sends this again.
    }
    try {
      await this.tabsApi.update(tabId, {
        muted: Boolean(state.settings.farmMuted),
        autoDiscardable: false,
      });
    } catch {
      // Tab may have just navigated; not fatal.
    }
  }

  /** Ask the farm tab how the player is doing (hidden? paused?). */
  async #tabHealth(tabId) {
    if (tabId == null) return null;
    try {
      const status = await this.tabsApi.sendMessage(tabId, { type: 'FARM_STATUS' });
      return status && typeof status === 'object' ? status : null;
    } catch {
      return null;
    }
  }

  skip() {
    return this.#run(() => this.#skip());
  }

  async #skip() {
    const state = await this.store.get();
    if (!state.farm.enabled) {
      return { ok: false, message: 'Автоферма выключена' };
    }
    const ids = state.farm.campaignIds?.length
      ? state.farm.campaignIds
      : state.farm.campaignId
        ? [state.farm.campaignId]
        : [];
    // Prefer another channel for the same campaigns, then any other group.
    let target = await this.pickTarget({
      excludeLogin: state.farm.channelLogin || '',
      campaignIds: ids,
      allowOtherGroup: false,
      hardExclude: true,
    });
    if (!target) {
      target = await this.pickTarget({
        excludeLogin: state.farm.channelLogin || '',
        allowOtherGroup: true,
        hardExclude: true,
      });
    }
    if (!target) {
      return { ok: false, message: 'Нет другого доступного канала с дропсами' };
    }
    const tabId = await this.#applyTarget(target, { reuseTabId: state.farm.tabId });
    if (tabId == null) {
      return { ok: false, message: 'Не удалось открыть вкладку Twitch' };
    }
    return { ok: true, campaigns: target.campaigns.map((campaign) => campaign.name) };
  }

  async applyMuteSetting() {
    const state = await this.store.get();
    if (state.farm.tabId == null) return;
    await this.#applyTabSettings(state.farm.tabId);
  }
}
