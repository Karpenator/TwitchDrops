import { STORAGE } from '../shared/constants.js';
import {
  buildSession,
  cleanToken,
  integrityIsFresh,
  normalizeIntegrityExpiration,
  parseTwilightUser,
} from '../shared/session-utils.js';
import { fetchIntegrityToken } from './gql.js';

const COOKIE_URLS = ['https://www.twitch.tv/', 'https://api.twitch.tv/'];

function isSessionUsable(session) {
  return Boolean(session && session.token && session.deviceId);
}

function normalizePageIntegrity(raw, now = Date.now()) {
  if (!raw || typeof raw.token !== 'string' || !raw.token.trim()) return null;
  return {
    token: raw.token.trim(),
    expiresAt: normalizeIntegrityExpiration(raw.expiration || raw.expiresAt || 0),
    requestId: typeof raw.requestId === 'string' ? raw.requestId : '',
    source: raw.source || 'page',
    capturedAt: Number(raw.capturedAt) || now,
  };
}

export class SessionManager {
  constructor({
    storageArea = null,
    cookieApi = null,
    fetchImpl = (...args) => globalThis.fetch(...args),
    logger = console,
  } = {}) {
    this.storageArea = storageArea || chrome.storage.session;
    this.cookieApi = cookieApi || chrome.cookies;
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.memory = null;
    this.refreshInFlight = null;
  }

  async #readStore(key) {
    try {
      const result = await this.storageArea.get(key);
      return result?.[key] ?? null;
    } catch {
      return null;
    }
  }

  async #writeStore(key, value) {
    try {
      await this.storageArea.set({ [key]: value });
    } catch (error) {
      this.logger.warn?.('[TwitchAutoPilot] session storage write failed', error);
    }
  }

  async #readCookie(name) {
    for (const url of COOKIE_URLS) {
      try {
        const cookie = await this.cookieApi.get({ url, name });
        if (cookie?.value) return cookie.value;
      } catch {
        // Try the next URL/domain.
      }
    }
    for (const domain of ['.twitch.tv', 'twitch.tv']) {
      try {
        const cookie = await this.cookieApi.get({ domain, name });
        if (cookie?.value) return cookie.value;
      } catch {
        // Permission or cookie not found.
      }
    }
    return null;
  }

  async #persist(session) {
    if (!session || typeof session !== 'object') return;
    this.memory = session;
    await this.#writeStore(STORAGE.session, session);
  }

  /** Load the session from session storage or, when needed, from cookies. */
  async get({ force = false } = {}) {
    if (!force && isSessionUsable(this.memory)) return this.memory;
    if (!force) {
      const stored = await this.#readStore(STORAGE.session);
      if (isSessionUsable(stored)) {
        this.memory = stored;
        return stored;
      }
    }
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.#loadFromBrowser({ force }).finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  async #loadFromBrowser({ force = false } = {}) {
    // A forced refresh should re-read the cookies but keep the device/session
    // identifiers stable, otherwise the integrity token becomes invalid.
    const previous = this.memory || (await this.#readStore(STORAGE.session));
    const [authToken, twilightUser, uniqueId] = await Promise.all([
      this.#readCookie('auth-token'),
      this.#readCookie('twilight-user'),
      this.#readCookie('unique_id'),
    ]);
    const session = buildSession({
      authToken,
      twilightUser,
      uniqueId,
      fallbackDeviceId: previous?.deviceId,
      fallbackUuid: previous?.uuid,
      integrity: previous?.integrity || null,
    });
    if (!session.token) {
      const parsedUser = parseTwilightUser(twilightUser);
      session.user = parsedUser
        ? {
            id: parsedUser.id,
            login: parsedUser.login,
            displayName: parsedUser.displayName,
          }
        : previous?.user || null;
    }
    await this.#persist(session);
    return session;
  }

  async clear() {
    this.memory = null;
    await this.#writeStore(STORAGE.session, null);
    await this.#writeStore(STORAGE.pageIntegrity, null);
  }

  /** Merge a session snapshot sent by a Twitch content script. */
  async applyContentSession(payload) {
    if (!payload || typeof payload !== 'object') return this.memory;
    const current = (await this.get()) || {};
    const incomingToken = cleanToken(payload.token || '');
    const incomingUser = parseTwilightUser(payload.twilightUser);
    const next = {
      ...current,
      token: incomingToken || current.token || '',
      deviceId: payload.deviceId || current.deviceId || '',
      uuid: payload.uuid || current.uuid || '',
      updatedAt: Date.now(),
    };
    if (incomingUser) {
      next.user = {
        id: incomingUser.id,
        login: incomingUser.login,
        displayName: incomingUser.displayName,
      };
    } else if (payload.userId || payload.login) {
      next.user = {
        id: payload.userId || current.user?.id || '',
        login: payload.login || current.user?.login || '',
        displayName: current.user?.displayName || payload.login || '',
      };
    }
    await this.#persist(next);
    return next;
  }

  async setUser(user) {
    const current = (await this.get()) || {};
    if (!user || (!user.id && !user.login)) return current;
    const next = {
      ...current,
      user: {
        id: String(user.id || current.user?.id || ''),
        login: String(user.login || current.user?.login || '').toLowerCase(),
        displayName: String(user.displayName || user.login || current.user?.displayName || ''),
      },
    };
    await this.#persist(next);
    return next;
  }

  /** Store the integrity token captured from a real Twitch page. */
  async setPageIntegrity(raw) {
    const integrity = normalizePageIntegrity(raw);
    if (!integrity) return null;
    await this.#writeStore(STORAGE.pageIntegrity, integrity);
    const session = await this.get();
    if (session) {
      session.integrity = integrity;
      await this.#persist(session);
    }
    return integrity;
  }

  async #getPageIntegrity() {
    const stored = await this.#readStore(STORAGE.pageIntegrity);
    const integrity = normalizePageIntegrity(stored);
    return integrityIsFresh(integrity) ? integrity : null;
  }

  /**
   * Ensure a fresh `Client-Integrity` token is present. Preference order:
   * 1) token captured from a real Twitch tab, 2) token minted via /integrity.
   */
  async ensureIntegrity({ force = false } = {}) {
    let session = await this.get({ force });
    if (!force && integrityIsFresh(session?.integrity)) return session;

    const pageIntegrity = await this.#getPageIntegrity();
    if (pageIntegrity && (!force || pageIntegrity.token !== session?.integrity?.token)) {
      session = { ...session, integrity: pageIntegrity };
      await this.#persist(session);
      return session;
    }

    const minted = await fetchIntegrityToken({ session, fetchImpl: this.fetchImpl });
    if (minted) {
      const integrity = {
        token: minted.token,
        expiresAt: normalizeIntegrityExpiration(minted.expiration),
        requestId: minted.requestId || '',
        source: 'minted',
        capturedAt: Date.now(),
      };
      session = { ...session, integrity };
      await this.#persist(session);
    }
    return session;
  }

  async refresh({ force = true } = {}) {
    await this.get({ force });
    return this.ensureIntegrity({ force });
  }
}
