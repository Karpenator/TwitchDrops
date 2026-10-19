/*
 * Isolated-world content script. Relays page events to the service worker,
 * keeps the Twitch session in sync and clicks the channel points chest.
 */
(() => {
  if (window.__twitchautopilotContent) return;
  window.__twitchautopilotContent = true;

  const PAGE_EVENT = '__twitchautopilot_page_event__';
  const CONTENT_EVENT = '__twitchautopilot_content_event__';
  const GUARD_EVENT = '__twitchautopilot_guard_event__';
  const GUARD_KEY = 'twitchautopilot:bg-watch';
  const FARM_KEY = 'twitchautopilot:farm-tab';
  const INTEGRITY_KEY = '__twitchautopilot_integrity__';
  const pendingRelays = new Map();
  let lastUrl = '';

  function safeSend(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  function readCookie(name) {
    try {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
      if (!match) return '';
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    } catch {
      return '';
    }
  }

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key) || '';
    } catch {
      return '';
    }
  }

  function storageArea(kind) {
    try {
      return kind === 'session' ? window.sessionStorage : window.localStorage;
    } catch {
      return null;
    }
  }

  function readFlag(storage, key, fallback) {
    if (!storage) return fallback;
    try {
      const value = storage.getItem(key);
      if (value == null) return fallback;
      return value !== '0';
    } catch {
      return fallback;
    }
  }

  function writeFlag(storage, key, value) {
    if (!storage) return;
    try {
      storage.setItem(key, value ? '1' : '0');
    } catch {
      // Private mode: the in-page guard still works through the event below.
    }
  }

  /** Push the background-watch mode into the MAIN-world visibility guard. */
  function applyGuardConfig(config) {
    if (!config || typeof config !== 'object') return;
    const enabled = config.enabled !== false;
    const farm = Boolean(config.farm);
    writeFlag(storageArea('local'), GUARD_KEY, enabled);
    // Per tab: sessionStorage survives this tab's reloads and does not leak the
    // farm flag into the user's other Twitch tabs.
    writeFlag(storageArea('session'), FARM_KEY, farm);
    try {
      window.dispatchEvent(
        new CustomEvent(GUARD_EVENT, {
          detail: JSON.stringify({ enabled, farm }),
        }),
      );
    } catch {
      // Ignore dispatcher failures; the guard also reads the stored flags on boot.
    }
  }

  function pickVideo() {
    try {
      const videos = Array.from(document.querySelectorAll('video'));
      return videos.find((video) => !video.ended && video.readyState > 0) || videos[0] || null;
    } catch {
      return null;
    }
  }

  /** Current playback/visibility state, used by the farm watchdog. */
  function mediaStatus() {
    const video = pickVideo();
    return {
      ok: true,
      hidden: document.visibilityState === 'hidden' || document.hidden === true,
      visibility: document.visibilityState,
      videoFound: Boolean(video),
      paused: video ? video.paused : null,
      ended: video ? video.ended : null,
      muted: video ? video.muted : null,
      readyState: video ? video.readyState : 0,
      guardEnabled: readFlag(storageArea('local'), GUARD_KEY, true),
      farm: readFlag(storageArea('session'), FARM_KEY, false),
    };
  }

  /** Ask the player to continue; used when a hidden tab still paused itself. */
  function resumePlayback() {
    const video = pickVideo();
    if (!video) return { ok: false, reason: 'no-video' };
    if (readFlag(storageArea('session'), FARM_KEY, false)) {
      try {
        if (video.muted) video.muted = false;
        if (video.volume > 0) video.volume = 0;
      } catch {
        // Detached media element.
      }
    }
    try {
      const promise = video.play();
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch {
      // Playback may need the guard to handle a later retry.
    }
    return { ok: true, paused: video.paused, muted: video.muted };
  }

  function requestGuardConfig() {
    safeSend({ type: 'GET_GUARD' }).then((response) => {
      if (response?.ok) applyGuardConfig(response);
    });
  }

  function parseQuotedJson(value) {
    if (!value) return '';
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Not JSON; use the raw value.
    }
    return String(value).replace(/^"|"$/g, '');
  }

  function getChannelLogin() {
    try {
      const host = location.hostname.replace(/^www\./, '');
      if (host === 'player.twitch.tv') {
        return (new URLSearchParams(location.search).get('channel') || '').toLowerCase();
      }
      const segments = location.pathname.split('/').filter(Boolean);
      if (!segments.length) return '';
      const reserved = new Set([
        'directory',
        'drops',
        'settings',
        'search',
        'videos',
        'subscriptions',
        'friends',
        'messages',
        'wallet',
        'inventory',
        'bits',
        'broadcast',
        'collections',
        'communities',
        'community',
        'creatorcamp',
        'dashboard',
        'embed',
        'following',
        'gift',
        'legal',
        'moderator',
        'p',
        'payments',
        'popout',
        'privacy',
        'security',
        'turbo',
        'login',
        'logout',
        'signup',
        'store',
        'about',
        'activate',
        'downloads',
        'jobs',
      ]);
      const first = decodeURIComponent(segments[0]).toLowerCase();
      if (reserved.has(first)) return '';
      return /^[a-z0-9_]{2,25}$/.test(first) ? first : '';
    } catch {
      return '';
    }
  }

  function syncSession() {
    let twilightUser = readCookie('twilight-user');
    if (!twilightUser) {
      twilightUser = readStorage('twilight-user') || readStorage('twilight-user-data');
    }
    const uniqueId =
      readCookie('unique_id') ||
      readStorage('local_copy_unique_id') ||
      readStorage('device_id');
    const uuid = readStorage('client-session-id') || readStorage('clientSessionId');
    const payload = {
      token: readCookie('auth-token') || readCookie('__Secure-auth-token'),
      twilightUser,
      deviceId: parseQuotedJson(uniqueId),
      uuid: parseQuotedJson(uuid),
    };
    if (payload.token || payload.twilightUser || payload.deviceId) {
      safeSend({ type: 'SYNC_SESSION', payload });
    }
  }

  function syncIntegrity() {
    try {
      const raw = window.sessionStorage.getItem(INTEGRITY_KEY);
      if (!raw) return;
      const integrity = JSON.parse(raw);
      if (integrity && typeof integrity.token === 'string' && integrity.token) {
        safeSend({
          type: 'PAGE_INTEGRITY',
          payload: {
            token: integrity.token,
            expiration: integrity.expiration,
            requestId: integrity.requestId,
          },
        });
      }
    } catch {
      // Ignore storage parse errors.
    }
  }

  function findBonusButton() {
    const selectors = [
      '.claimable-bonus__icon',
      '[class*="claimable-bonus__icon"]',
      '[data-test-selector*="claimable-bonus"]',
    ];
    const seen = new Set();
    for (const selector of selectors) {
      let icons = [];
      try {
        icons = Array.from(document.querySelectorAll(selector));
      } catch {
        icons = [];
      }
      for (const icon of icons) {
        const target = icon.closest('button, [role="button"]') || icon;
        if (seen.has(target)) continue;
        seen.add(target);
        const rect = target.getBoundingClientRect();
        const style = window.getComputedStyle(target);
        const hidden =
          rect.width < 2 ||
          rect.height < 2 ||
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          target.getAttribute('aria-hidden') === 'true';
        const disabled =
          target.disabled ||
          target.getAttribute('disabled') !== null ||
          target.getAttribute('aria-disabled') === 'true';
        if (!hidden && !disabled) return target;
      }
    }
    return null;
  }

  function clickBonus() {
    const button = findBonusButton();
    if (!button) return { found: false, clicked: false };
    try {
      button.click();
      return { found: true, clicked: true };
    } catch {
      return { found: true, clicked: false };
    }
  }

  function requestPageRelay(payload, headers) {
    return new Promise((resolve) => {
      const requestId = `relay-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        pendingRelays.delete(requestId);
        resolve(null);
      }, 18_000);
      pendingRelays.set(requestId, { resolve, timer });
      try {
        window.dispatchEvent(
          new CustomEvent(CONTENT_EVENT, {
            detail: JSON.stringify({
              type: 'gql-request',
              requestId,
              payload,
              headers,
            }),
          }),
        );
      } catch {
        clearTimeout(timer);
        pendingRelays.delete(requestId);
        resolve(null);
      }
    });
  }

  window.addEventListener(PAGE_EVENT, (event) => {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'integrity') {
      safeSend({ type: 'PAGE_INTEGRITY', payload: message.payload });
      return;
    }
    if (message.type === 'points-claim-available') {
      const payload = message.payload || {};
      if (payload.claimId && payload.channelId) {
        safeSend({
          type: 'PAGE_CLAIM_AVAILABLE',
          payload: {
            channelId: String(payload.channelId),
            claimId: String(payload.claimId),
          },
        });
      }
      return;
    }
    if (message.type === 'drop-ready') {
      safeSend({ type: 'PAGE_DROP_PROGRESS', payload: message.payload || {} });
      return;
    }
    if (message.type === 'navigation') {
      reportChannel();
      return;
    }
    if (message.type === 'gql-response') {
      const pending = pendingRelays.get(message.payload?.requestId);
      if (!pending) return;
      pendingRelays.delete(message.payload.requestId);
      clearTimeout(pending.timer);
      pending.resolve(message.payload);
    }
  });

  function reportChannel() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const login = getChannelLogin();
    safeSend({ type: 'TAB_CHANNEL', payload: { login } });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    if (message.type === 'CHECK_BONUS') {
      const result = clickBonus();
      sendResponse({ ok: true, ...result, channel: getChannelLogin() });
      return false;
    }

    if (message.type === 'GQL_RELAY') {
      requestPageRelay(message.payload, message.headers)
        .then((response) => sendResponse(response))
        .catch(() => sendResponse(null));
      return true;
    }

    if (message.type === 'GUARD_CONFIG') {
      applyGuardConfig(message);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'FARM_STATUS') {
      sendResponse(mediaStatus());
      return false;
    }

    if (message.type === 'FARM_RESUME') {
      sendResponse(resumePlayback());
      return false;
    }

    if (message.type === 'PING') {
      sendResponse({ ok: true, channel: getChannelLogin() });
      return false;
    }

    return false;
  });

  syncSession();
  syncIntegrity();
  requestGuardConfig();
  reportChannel();
  setInterval(() => {
    reportChannel();
    syncIntegrity();
  }, 5_000);

  window.addEventListener('load', () => {
    syncSession();
    syncIntegrity();
  });
})();
