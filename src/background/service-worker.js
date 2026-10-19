import {
  ALARMS,
  DROPS_URL,
  EXTENSION_VERSION,
  LEGACY,
} from '../shared/constants.js';
import { applySettingsPatch } from '../shared/settings.js';
import { describeError } from '../shared/errors.js';
import { isTwitchUrl, channelLoginFromUrl, channelUrl } from '../shared/twitch-url.js';
import { StateStore } from './state.js';
import { SessionManager } from './session.js';
import { GqlClient, buildGqlHeaders } from './gql.js';
import { NotificationService } from './notifications.js';
import { DropsService } from './drops.js';
import { PointsService } from './points.js';
import { FarmService } from './farm.js';

const CONTENT_MESSAGE_TYPES = new Set([
  'SYNC_SESSION',
  'PAGE_INTEGRITY',
  'PAGE_CLAIM_AVAILABLE',
  'PAGE_DROP_PROGRESS',
  'TAB_CHANNEL',
  'GET_GUARD',
]);

let ready = null;
let store = null;
let sessionManager = null;
let gql = null;
let notify = null;
let drops = null;
let points = null;
let farm = null;
let badgeTimer = null;
let broadcastTimer = null;
let dropProgressTimer = null;

async function relayGqlPayload(payload) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: ['https://www.twitch.tv/*'] });
  } catch {
    return null;
  }
  let headers = null;
  try {
    headers = buildGqlHeaders(await sessionManager.ensureIntegrity());
  } catch {
    return null;
  }
  for (const tab of tabs.slice(0, 4)) {
    if (typeof tab.id !== 'number') continue;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'GQL_RELAY',
        payload,
        headers,
      });
      if (response?.ok && response.json) return response.json;
    } catch {
      // No content script in this tab; try the next one.
    }
  }
  return null;
}

async function init() {
  store = new StateStore({ onChange: () => scheduleBadge() });
  await store.load();
  // Alarms created by DropPilot <= 1.2.0 would linger after the rename.
  for (const alarm of LEGACY.alarms) {
    try {
      await chrome.alarms.clear(alarm);
    } catch {
      // Alarms API is unavailable in the popup/test harness.
    }
  }
  sessionManager = new SessionManager();
  notify = new NotificationService({
    getSettings: async () => (await store.get()).settings,
  });
  gql = new GqlClient({
    getSession: () => sessionManager.ensureIntegrity(),
    refreshSession: async () => {
      try {
        return await sessionManager.refresh({ force: true });
      } catch {
        return null;
      }
    },
    relay: relayGqlPayload,
    logger: console,
  });
  drops = new DropsService({
    store,
    gql,
    session: sessionManager,
    notify,
    onUpdate: notifyStateChanged,
  });
  points = new PointsService({
    store,
    gql,
    session: sessionManager,
    notify,
    onUpdate: notifyStateChanged,
  });
  farm = new FarmService({
    store,
    gql,
    drops,
    notify,
    onUpdate: notifyStateChanged,
  });
  await scheduleAlarms();
  scheduleBadge();
  return { store, sessionManager, gql, drops, points, farm };
}

function ensureReady() {
  if (!ready) {
    ready = init().catch((error) => {
      ready = null;
      console.error('[TwitchAutoPilot] initialization failed', error);
      throw error;
    });
  }
  return ready;
}

function scheduleBadge() {
  if (badgeTimer) return;
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    updateBadge().catch(() => {});
  }, 120);
}

async function updateBadge() {
  if (!store) return;
  const state = await store.get();
  const dropCount = (state.drops.campaigns || []).reduce(
    (sum, campaign) => sum + (campaign.claimableCount || 0),
    0,
  );
  const pointsCount = Object.values(state.points.channels || {}).filter(
    (channel) => channel.availableClaimId && !channel.error,
  ).length;
  const total = dropCount + pointsCount;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#9146ff' });
    await chrome.action.setBadgeText({ text: total > 0 ? String(Math.min(total, 99)) : '' });
    await chrome.action.setTitle({
      title:
        total > 0
          ? `TwitchAutoPilot — готово наград: ${total}`
          : 'TwitchAutoPilot — дропсы и очки Twitch',
    });
  } catch {
    // Toolbar APIs can be unavailable in some embeddings.
  }
}

/**
 * Tell every Twitch tab whether the background-playback guard should be active
 * and whether it belongs to the auto-farm.
 */
async function broadcastGuardConfig() {
  let state;
  try {
    state = await store.get();
  } catch {
    return;
  }
  const enabled = state.settings.backgroundWatch !== false;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({
      url: ['https://www.twitch.tv/*', 'https://player.twitch.tv/*'],
    });
  } catch {
    return;
  }
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    chrome.tabs
      .sendMessage(tab.id, {
        type: 'GUARD_CONFIG',
        enabled,
        farm: tab.id === state.farm.tabId,
      })
      .catch(() => {});
  }
}

function notifyStateChanged() {
  scheduleBadge();
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    chrome.runtime.sendMessage({ type: 'STATE_UPDATED' }).catch(() => {});
  }, 180);
}

async function scheduleAlarms() {
  const state = await store.get();
  const settings = state.settings;
  await chrome.alarms.create(ALARMS.drops, {
    periodInMinutes: settings.dropsIntervalMin,
    delayInMinutes: Math.min(settings.dropsIntervalMin, 2),
  });
  await chrome.alarms.create(ALARMS.points, {
    periodInMinutes: settings.pointsIntervalMin,
    delayInMinutes: Math.min(settings.pointsIntervalMin, 2),
  });
  if (settings.autoClaimPoints) {
    await chrome.alarms.create(ALARMS.bonus, {
      periodInMinutes: 1,
      delayInMinutes: 1,
    });
  } else {
    await chrome.alarms.clear(ALARMS.bonus);
  }
  if (settings.autoFarm) {
    await chrome.alarms.create(ALARMS.farm, {
      periodInMinutes: 2,
      delayInMinutes: 1,
    });
  } else {
    await chrome.alarms.clear(ALARMS.farm);
  }
}

/** Re-evaluate rotation immediately after a sync/claim, without re-fetching it. */
async function reconcileFarm() {
  if ((await store.get()).settings.autoFarm) {
    await farm.tick({ refreshDrops: false });
  }
}

async function refreshDropsAndFarm() {
  await drops.refresh({ claim: true });
  await reconcileFarm();
}

async function refreshScopes(scope = 'all') {
  const errors = {};
  const tasks = [];
  if (scope === 'all' || scope === 'drops') {
    tasks.push(
      refreshDropsAndFarm().catch((error) => {
        errors.drops = describeError(error);
      }),
    );
  }
  if (scope === 'all' || scope === 'points') {
    tasks.push(
      points.refresh({ claim: true }).catch((error) => {
        errors.points = describeError(error);
      }),
    );
  }
  await Promise.all(tasks);
  scheduleBadge();
  return errors;
}

async function initialSync() {
  const session = await sessionManager.get();
  if (!session?.token) {
    await store.update((state) => {
      state.session = {
        authenticated: false,
        error: null,
        checkedAt: Date.now(),
      };
      return state;
    });
    notifyStateChanged();
    return;
  }
  await refreshScopes('all');
}

async function setSettings(patch) {
  const before = { ...(await store.get()).settings };
  const previousAutoFarm = before.autoFarm;
  await store.update((state) => {
    state.settings = applySettingsPatch(state.settings, patch);
    return state;
  });
  const after = await store.get();

  if (after.settings.autoFarm) {
    if (!previousAutoFarm) {
      await farm.start();
    } else {
      await farm.applyMuteSetting();
    }
  } else if (previousAutoFarm || patch.autoFarm === false) {
    await farm.stop({ closeTab: true });
  }
  await scheduleAlarms();

  notifyStateChanged();
  broadcastGuardConfig().catch(() => {});

  // Turning a claim toggle on should show results immediately.
  if (!before.autoClaimDrops && after.settings.autoClaimDrops) {
    refreshDropsAndFarm().catch(() => {});
  }
  if (!before.autoClaimPoints && after.settings.autoClaimPoints) {
    points.refresh({ claim: true }).catch(() => {});
  }
  return { settings: after.settings };
}

async function statePayload() {
  const state = await store.get();
  let openTabs = [];
  try {
    openTabs = (await points.openTabs()).map((tab) => ({
      login: tab.login,
      tabId: tab.tabId,
    }));
  } catch {
    openTabs = [];
  }
  return {
    ok: true,
    state,
    openTabs,
    version: EXTENSION_VERSION,
    now: Date.now(),
  };
}

async function handleContentMessage(message, sender) {
  const tabUrl = sender?.tab?.url || '';
  if (!isTwitchUrl(tabUrl)) {
    return { ok: false, error: 'Недоступный источник сообщения' };
  }
  const tabId = typeof sender?.tab?.id === 'number' ? sender.tab.id : null;
  switch (message.type) {
    case 'SYNC_SESSION': {
      const before = await store.get();
      const wasAuthenticated = before.session?.authenticated;
      const session = await sessionManager.applyContentSession(message.payload || {});
      if (session?.user) {
        await store.update((state) => {
          state.user = {
            id: session.user.id || '',
            login: session.user.login || '',
            displayName: session.user.displayName || session.user.login || '',
          };
          return state;
        });
      }
      if (session?.token && !wasAuthenticated) {
        initialSync().catch(() => {});
      }
      notifyStateChanged();
      return { ok: true };
    }
    case 'PAGE_INTEGRITY': {
      const token = typeof message.payload?.token === 'string' ? message.payload.token : '';
      if (!token || token.length > 8192) return { ok: false };
      await sessionManager.setPageIntegrity({
        token,
        expiration: message.payload?.expiration,
        requestId: message.payload?.requestId,
        source: 'page',
      });
      return { ok: true };
    }
    case 'PAGE_CLAIM_AVAILABLE': {
      const channelId = String(message.payload?.channelId || '').slice(0, 128);
      const claimId = String(message.payload?.claimId || '').slice(0, 256);
      if (!channelId || !claimId) return { ok: false };
      const result = await points.handleClaimAvailable({
        channelId,
        claimId,
        tabId,
        channelLogin: channelLoginFromUrl(tabUrl) || '',
      });
      return { ok: true, result };
    }
    case 'PAGE_DROP_PROGRESS': {
      const state = await store.get();
      if ((state.settings.autoClaimDrops || state.settings.autoFarm) && !dropProgressTimer) {
        dropProgressTimer = setTimeout(() => {
          dropProgressTimer = null;
          refreshDropsAndFarm().catch(() => {});
        }, 4_000);
      }
      return { ok: true };
    }
    case 'GET_GUARD': {
      const state = await store.get();
      return {
        ok: true,
        enabled: state.settings.backgroundWatch !== false,
        farm: tabId != null && state.farm.tabId === tabId,
      };
    }
    case 'TAB_CHANNEL':
      await farm.handleNavigation(tabId);
      return { ok: true };
    default:
      return { ok: false, error: 'Неизвестное сообщение' };
  }
}

async function handleMessage(message, sender) {
  await ensureReady();
  const type = message?.type;
  if (typeof type !== 'string') return { ok: false, error: 'Некорректный запрос' };
  if (CONTENT_MESSAGE_TYPES.has(type)) {
    return handleContentMessage(message, sender);
  }
  if (sender?.tab) {
    // Extension pages do not have a sender.tab. Runtime messages from a tab
    // are content-script messages and must be on the allow-list above.
    return { ok: false, error: 'Недоступное сообщение' };
  }

  switch (type) {
    case 'GET_STATE':
      return statePayload();

    case 'REFRESH': {
      const scope = ['all', 'drops', 'points'].includes(message.scope) ? message.scope : 'all';
      const errors = await refreshScopes(scope);
      return { ...(await statePayload()), errors };
    }

    case 'SET_SETTINGS': {
      const result = await setSettings(message.patch || {});
      return { ...(await statePayload()), settings: result.settings };
    }

    case 'CLAIM_DROP': {
      const campaignId = String(message.campaignId || '');
      const dropId = String(message.dropId || '');
      if (!campaignId || !dropId) return { ok: false, error: 'Не указана награда' };
      await drops.claimDrop(campaignId, dropId, { manual: true });
      await reconcileFarm();
      scheduleBadge();
      return { ...(await statePayload()) };
    }

    case 'CLAIM_ALL_DROPS': {
      const result = await drops.claimAllReady();
      await reconcileFarm();
      scheduleBadge();
      return { ...(await statePayload()), result };
    }

    case 'CLAIM_POINTS': {
      const login = String(message.login || '').toLowerCase();
      if (!login) return { ok: false, error: 'Не указан канал' };
      let state = await store.get();
      let channel = state.points.channels[login];
      if (!channel?.availableClaimId || !channel?.channelId) {
        channel = await points.refreshChannel(login);
      }
      if (channel?.availableClaimId && channel?.channelId) {
        await points.claimPoints({
          login,
          channelId: channel.channelId,
          claimId: channel.availableClaimId,
          source: 'manual',
        });
        await points.refreshChannel(login).catch(() => {});
      } else {
        const openTab = (await points.openTabs()).find((tab) => tab.login === login);
        const clicked = await points.tryDomClaim(login, openTab?.tabId);
        if (!clicked) {
          return { ok: false, error: 'Бонус пока недоступен. Загляните чуть позже.' };
        }
      }
      scheduleBadge();
      return { ...(await statePayload()) };
    }

    case 'ADD_CHANNEL': {
      await points.addTracked(message.login);
      return { ...(await statePayload()) };
    }

    case 'REMOVE_CHANNEL': {
      await points.removeTracked(message.login);
      return { ...(await statePayload()) };
    }

    case 'OPEN_CHANNEL': {
      const url = channelUrl(message.login);
      if (!isTwitchUrl(url)) return { ok: false, error: 'Некорректный канал' };
      await chrome.tabs.create({ url });
      return { ok: true };
    }

    case 'OPEN_URL': {
      const url = String(message.url || '');
      if (!isTwitchUrl(url) || !url.startsWith('https://')) {
        return { ok: false, error: 'Можно открывать только ссылки Twitch' };
      }
      await chrome.tabs.create({ url });
      return { ok: true };
    }

    case 'OPEN_TWITCH': {
      await chrome.tabs.create({ url: DROPS_URL });
      return { ok: true };
    }

    case 'START_FARM': {
      await setSettings({ autoFarm: true });
      const state = await store.get();
      return {
        ...(await statePayload()),
        warning: state.farm.error || null,
      };
    }

    case 'STOP_FARM':
      await setSettings({ autoFarm: false });
      return { ...(await statePayload()) };

    case 'FARM_PLAY': {
      const campaignId = String(message.campaignId || '');
      if (!campaignId) return { ok: false, error: 'Не указана кампания' };
      const result = await farm.play(campaignId);
      if (!result.ok) {
        return { ok: false, error: result.message || 'Не удалось запустить просмотр' };
      }
      await scheduleAlarms();
      notifyStateChanged();
      return { ...(await statePayload()), warning: result.warning || null };
    }

    case 'FARM_SKIP': {
      const result = await farm.skip();
      return { ...(await statePayload()), warning: result.ok ? null : result.message };
    }

    case 'CLEAR_HISTORY': {
      await store.update((state) => {
        state.history = [];
        return state;
      });
      notifyStateChanged();
      return { ...(await statePayload()) };
    }

    case 'RESET_STATS': {
      await store.update((state) => {
        state.stats = { dropsClaimed: 0, pointsBonuses: 0 };
        return state;
      });
      notifyStateChanged();
      return { ...(await statePayload()) };
    }

    default:
      return { ok: false, error: 'Неизвестное действие' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'STATE_UPDATED') return false;
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error('[TwitchAutoPilot] message failed', message?.type, error);
      sendResponse({ ok: false, error: describeError(error) });
    });
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  return ensureReady()
    .then(async () => {
      switch (alarm.name) {
        case ALARMS.drops:
          await refreshDropsAndFarm();
          break;
        case ALARMS.points:
          await points.refresh({ claim: true });
          break;
        case ALARMS.bonus:
          await points.tickBonusTabs();
          break;
        case ALARMS.farm:
          await farm.tick();
          break;
        default:
          break;
      }
      scheduleBadge();
    })
    .catch((error) => {
      console.warn('[TwitchAutoPilot] alarm failed', alarm.name, error);
    });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.url !== 'string') return;
  return ensureReady()
    .then(() => farm.handleNavigation(tabId))
    .catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ensureReady()
    .then(() => farm.handleTabRemoved(tabId))
    .catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  ensureReady()
    .then(() => initialSync())
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureReady()
    .then(() => initialSync())
    .catch(() => {});
});

// Keep the service worker warm long enough to finish a single operation when
// it was started by the popup or a content script.
ensureReady().catch(() => {});
