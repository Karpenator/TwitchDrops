/**
 * URL helpers for Twitch pages and channel logins.
 */

const RESERVED_PATHS = new Set([
  'about',
  'activate',
  'admin',
  'bits',
  'broadcast',
  'collections',
  'communities',
  'community',
  'creatorcamp',
  'dashboard',
  'directory',
  'downloads',
  'drops',
  'embed',
  'following',
  'friends',
  'gift',
  'inventory',
  'jobs',
  'legal',
  'login',
  'logout',
  'messages',
  'moderator',
  'p',
  'payments',
  'popout',
  'privacy',
  'search',
  'security',
  'settings',
  'signup',
  'store',
  'subscriptions',
  'turbo',
  'videos',
  'wallet',
]);

const LOGIN_PATTERN = /^[a-z0-9_]{2,25}$/;

/** Normalize user input such as "@Some_Channel" or a twitch.tv URL. */
export function normalizeLogin(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim().toLowerCase();
  if (!text) return null;
  text = text.replace(/^@/, '');
  const urlMatch = text.match(/(?:twitch\.tv|player\.twitch\.tv)\/(?:#!\/)?([a-z0-9_]{2,25})/);
  if (urlMatch) text = urlMatch[1];
  const queryMatch = text.match(/[?&]channel=([a-z0-9_]{2,25})/);
  if (queryMatch) text = queryMatch[1];
  if (!LOGIN_PATTERN.test(text)) return null;
  if (RESERVED_PATHS.has(text)) return null;
  return text;
}

/** Extract the channel login from a twitch.tv / player.twitch.tv URL. */
export function channelLoginFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host !== 'twitch.tv' && host !== 'player.twitch.tv' && host !== 'm.twitch.tv') {
    return null;
  }
  if (host === 'player.twitch.tv') {
    return normalizeLogin(url.searchParams.get('channel') || '');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const first = decodeURIComponent(segments[0]).toLowerCase();
  if (first === 'popout' && segments[1]) {
    return normalizeLogin(segments[1]);
  }
  if (first === 'embed' && segments[1] === 'channel' && segments[2]) {
    return normalizeLogin(segments[2]);
  }
  return normalizeLogin(first);
}

export function channelUrl(login) {
  const safe = normalizeLogin(login);
  return safe ? `https://www.twitch.tv/${safe}` : 'https://www.twitch.tv/';
}

export function categoryUrl(slug) {
  const safe = String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  return safe
    ? `https://www.twitch.tv/directory/category/${safe}`
    : 'https://www.twitch.tv/directory';
}

export function isTwitchUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, '');
    return url.protocol === 'https:' && (host === 'twitch.tv' || host === 'player.twitch.tv');
  } catch {
    return false;
  }
}
