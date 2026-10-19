import {
  GQL_ENDPOINT,
  INTEGRITY_CLIENT_ID,
  INTEGRITY_CLIENT_VERSION,
  INTEGRITY_ENDPOINT,
  TWITCH_CLIENT_ID,
} from '../shared/constants.js';
import {
  ERROR_CODES,
  TwitchApiError,
  errorFromGqlMessage,
  firstGqlError,
} from '../shared/errors.js';

export const GQL_TIMEOUT_MS = 20_000;

export function buildGqlHeaders(session, { auth = true } = {}) {
  if (!session || typeof session !== 'object') {
    throw new TwitchApiError('Twitch session is missing', { code: ERROR_CODES.AUTH });
  }
  const headers = {
    'Content-Type': 'text/plain;charset=UTF-8',
    'Client-Id': TWITCH_CLIENT_ID,
  };
  if (auth) {
    if (!session.token) {
      throw new TwitchApiError('Twitch auth token is missing', { code: ERROR_CODES.AUTH });
    }
    headers.Authorization = `OAuth ${session.token}`;
    headers['X-Device-Id'] = session.deviceId || '';
    headers['Client-Session-Id'] = session.uuid || '';
    if (session.integrity?.token) headers['Client-Integrity'] = session.integrity.token;
  }
  return headers;
}

function isArrayPayload(payload) {
  return Array.isArray(payload);
}

function normalisedPayloads(payload) {
  return isArrayPayload(payload) ? payload : [payload];
}

function gqlErrorCode(message) {
  return errorFromGqlMessage(message).code;
}

/**
 * Thin Twitch GraphQL transport with a single, explicit retry path for
 * rotated persisted-query hashes and integrity tokens.
 */
export class GqlClient {
  constructor({
    getSession,
    refreshSession = async () => null,
    fetchImpl = (...args) => globalThis.fetch(...args),
    timeoutMs = GQL_TIMEOUT_MS,
    relay = null,
    logger = console,
  }) {
    this.getSession = getSession;
    this.refreshSession = refreshSession;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.relay = relay;
    this.logger = logger;
  }

  async #post(payload, { auth = true } = {}) {
    const session = await this.getSession();
    const headers = buildGqlHeaders(session, { auth });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(GQL_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
        credentials: 'omit',
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new TwitchApiError('Twitch GQL request timed out', {
          code: ERROR_CODES.TIMEOUT,
        });
      }
      throw new TwitchApiError(String(error?.message || error), {
        code: ERROR_CODES.NETWORK,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const status = Number(response.status) || 0;
      if (status === 401 || status === 403) {
        throw new TwitchApiError('Twitch rejected the session', {
          code: ERROR_CODES.AUTH,
          status,
        });
      }
      if (status === 429) {
        throw new TwitchApiError('Twitch rate limit reached', {
          code: ERROR_CODES.RATE_LIMIT,
          status,
        });
      }
      if (status === 404) {
        throw new TwitchApiError('Twitch endpoint not found', {
          code: ERROR_CODES.NOT_FOUND,
          status,
        });
      }
      throw new TwitchApiError(`Twitch GQL HTTP ${status}`, {
        code: ERROR_CODES.UNKNOWN,
        status,
      });
    }

    let json;
    try {
      json = await response.json();
    } catch {
      throw new TwitchApiError('Twitch returned non-JSON data', {
        code: ERROR_CODES.PARSE,
      });
    }

    const payloads = normalisedPayloads(json);
    for (const item of payloads) {
      const message = firstGqlError(item);
      if (message) throw errorFromGqlMessage(message, response.status);
    }
    return json;
  }

  /**
   * Execute one or many persisted queries. If Twitch rotated the persisted
   * hash and a readable fallback payload is supplied, retry once with it.
   */
  async request(payload, { rawFallback = null, allowRelay = false } = {}) {
    try {
      return await this.#post(payload);
    } catch (error) {
      if (error instanceof TwitchApiError) {
        if (error.code === ERROR_CODES.NOT_FOUND && rawFallback) {
          return this.#post(rawFallback);
        }
        if ((error.code === ERROR_CODES.AUTH || error.code === ERROR_CODES.INTEGRITY) && this.refreshSession) {
          const refreshed = await this.refreshSession().catch(() => null);
          if (refreshed) {
            try {
              return await this.#post(payload);
            } catch (retryError) {
              error = retryError;
            }
          }
        }
        if ((error.code === ERROR_CODES.AUTH || error.code === ERROR_CODES.INTEGRITY) && allowRelay && this.relay) {
          const relayed = await this.relay(payload).catch(() => null);
          if (relayed) return relayed;
        }
      }
      throw error;
    }
  }

  async data(payload, options) {
    const json = await this.request(payload, options);
    if (isArrayPayload(json)) {
      throw new TwitchApiError('Expected a single GQL response', {
        code: ERROR_CODES.PARSE,
      });
    }
    return json.data || {};
  }

  /**
   * Batch several operations into a single HTTP request. Individual GraphQL
   * errors are returned to the caller instead of discarding the whole batch.
   */
  async batch(payloads) {
    if (!Array.isArray(payloads) || payloads.length === 0) return [];
    let json;
    try {
      json = await this.#post(payloads);
    } catch (error) {
      // A rotated hash on any item invalidates the whole batch. Retry the
      // items one by one so one bad query cannot blank the whole screen.
      if (error instanceof TwitchApiError && error.code === ERROR_CODES.NOT_FOUND) {
        return Promise.all(
          payloads.map(async (payload) => {
            try {
              return await this.#post(payload);
            } catch (itemError) {
              return { errors: [{ message: String(itemError.message || itemError) }], data: null };
            }
          }),
        );
      }
      throw error;
    }
    if (!Array.isArray(json)) {
      throw new TwitchApiError('Expected a batch GQL response', {
        code: ERROR_CODES.PARSE,
      });
    }
    return json;
  }
}

export function parseGqlErrorMessage(payload) {
  const message = firstGqlError(payload);
  return message ? gqlErrorCode(message) : '';
}

/** Token minting used when no Twitch tab has supplied a fresh integrity token. */
export async function fetchIntegrityToken({ session, fetchImpl = (...args) => fetch(...args) }) {
  if (!session?.token || !session?.deviceId) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetchImpl(INTEGRITY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Client-Id': INTEGRITY_CLIENT_ID,
        Authorization: `OAuth ${session.token}`,
        'X-Device-Id': session.deviceId,
        'Client-Session-Id': session.uuid || '',
        'Client-Version': INTEGRITY_CLIENT_VERSION,
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const json = await response.json();
    const token = typeof json?.token === 'string' ? json.token.trim() : '';
    if (!token) return null;
    return {
      token,
      expiration: json?.expiration,
      requestId: json?.request_id || '',
      source: 'minted',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
