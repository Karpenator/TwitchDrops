/**
 * Small, dependency-free date/time helpers.
 * Kept pure so they can be tested with `node --test`.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];

export function nowMs() {
  return Date.now();
}

/** Parse an ISO timestamp-ish value into milliseconds, or null. */
export function toTimestamp(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(value.trim())) {
      return numeric < 1e12 ? Math.round(numeric * 1000) : Math.round(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** "2 д 4 ч", "45 мин", "<1 мин". Never negative. */
export function formatDuration(ms) {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (safe < MINUTE) return '<1 мин';
  const days = Math.floor(safe / DAY);
  const hours = Math.floor((safe % DAY) / HOUR);
  const minutes = Math.floor((safe % HOUR) / MINUTE);
  if (days > 0) {
    return hours > 0 ? `${days} д ${hours} ч` : `${days} д`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours} ч ${minutes} мин` : `${hours} ч`;
  }
  return `${Math.max(1, minutes)} мин`;
}

/** Compact label for a number of minutes. */
export function formatMinutes(minutes) {
  const safe = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  if (safe < 60) return `${safe} мин`;
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (hours < 24) return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} д ${restHours} ч` : `${days} д`;
}

export function formatTimeLeft(endsAt, now = Date.now()) {
  if (!endsAt) return 'без срока';
  const left = toTimestamp(endsAt) - now;
  if (!Number.isFinite(left) || left <= 0) return 'завершено';
  return `осталось ${formatDuration(left)}`;
}

export function formatRelative(timestamp, now = Date.now()) {
  if (!timestamp) return 'ещё не синхронизировано';
  const diff = now - timestamp;
  if (diff < 15_000) return 'только что';
  if (diff < MINUTE) return 'меньше минуты назад';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} мин назад`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} ч назад`;
  return `${Math.floor(diff / DAY)} д назад`;
}

export function formatDateTime(timestamp) {
  const ts = toTimestamp(timestamp);
  if (!ts) return '—';
  const date = new Date(ts);
  const day = date.getDate();
  const month = MONTHS_SHORT[date.getMonth()] ?? '';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${day} ${month}, ${hours}:${minutes}`;
}

/** True when `timestamp` is in the future. */
export function isFuture(timestamp, now = Date.now()) {
  const ts = toTimestamp(timestamp);
  return ts != null && ts > now;
}

/** Milliseconds until `timestamp` (0 if past / invalid). */
export function msUntil(timestamp, now = Date.now()) {
  const ts = toTimestamp(timestamp);
  return ts == null ? 0 : Math.max(0, ts - now);
}
