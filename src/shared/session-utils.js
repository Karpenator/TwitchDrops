/**
 * Pure helpers for extracting/refreshing the Twitch web session.
 */

const UUID_LIKE = /^[a-f0-9-]{8,64}$/i;

function safeJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseCookieHeader(header, name) {
  if (typeof header !== 'string') return null;
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = header.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export function decodeCookieValue(value) {
  if (typeof value !== 'string') return '';
  const decoded = (() => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  })();
  const parsed = safeJson(decoded);
  if (typeof parsed === 'string') return parsed.trim();
  return decoded.trim();
}

export function cleanToken(value) {
  if (typeof value !== 'string') return '';
  let token = decodeCookieValue(value);
  token = token.replace(/^"|"$/g, '').replace(/\\"/g, '"').trim();
  return token;
}

export function parseTwilightUser(rawValue) {
  const decoded = decodeCookieValue(rawValue);
  const parsed = safeJson(decoded) || (typeof rawValue === 'object' ? rawValue : null);
  if (!parsed || typeof parsed !== 'object') return null;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };
  const token = pick('authToken', 'token', 'oauthToken');
  const id = pick('id', 'userID', 'userId');
  const login = pick('login').toLowerCase();
  const displayName = pick('displayName') || login;
  if (!token && !id && !login) return null;
  return { token, id, login, displayName };
}

export function parseDeviceId(value) {
  if (typeof value !== 'string') return '';
  const decoded = decodeCookieValue(value);
  if (UUID_LIKE.test(decoded)) return decoded;
  const parsed = safeJson(decoded);
  if (typeof parsed === 'string' && UUID_LIKE.test(parsed)) return parsed;
  return '';
}

export function normalizeIntegrityExpiration(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  // Twitch has used both seconds and milliseconds here.
  return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
}

export function integrityIsFresh(integrity, now = Date.now(), skewMs = 60_000) {
  if (!integrity || typeof integrity.token !== 'string' || !integrity.token) return false;
  if (!integrity.expiresAt) return true;
  return integrity.expiresAt - skewMs > now;
}

/** Combine cookies + content-script data into one session object. */
export function buildSession({
  authToken,
  twilightUser,
  uniqueId,
  fallbackDeviceId,
  fallbackUuid,
  integrity = null,
  now = Date.now(),
}) {
  const token = cleanToken(authToken);
  const user = parseTwilightUser(twilightUser);
  const deviceId =
    parseDeviceId(uniqueId) || parseDeviceId(fallbackDeviceId) || randomHex(32);
  const uuid = parseDeviceId(fallbackUuid) || randomHex(32, 16);
  return {
    token: token || user?.token || '',
    deviceId,
    uuid,
    user: user
      ? { id: user.id || '', login: user.login || '', displayName: user.displayName || '' }
      : null,
    integrity,
    updatedAt: now,
  };
}

export function randomHex(length = 32, bytes = Math.ceil(length / 2)) {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const data = crypto.getRandomValues(new Uint8Array(bytes));
    return Array.from(data, (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, length);
  }
  let out = '';
  while (out.length < length) out += Math.random().toString(16).slice(2);
  return out.slice(0, length);
}
