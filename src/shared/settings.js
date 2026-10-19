import { clamp } from './time.js';

export const INTERVAL_OPTIONS = [1, 2, 3, 5, 10, 15, 30];
export const FARM_STRATEGIES = ['random', 'low', 'top'];
export const FARM_PRIORITIES = ['deadline', 'progress'];

export const DEFAULT_SETTINGS = Object.freeze({
  /** Автоматически забирать готовые дропсы. */
  autoClaimDrops: true,
  /** Автоматически забирать бонусные очки на каналах. */
  autoClaimPoints: true,
  /** Показывать системные уведомления о наградах. */
  notifyClaims: true,
  /** Как часто обновлять инвентарь дропсов, минуты. */
  dropsIntervalMin: 5,
  /** Как часто обновлять балансы очков, минуты. */
  pointsIntervalMin: 5,
  /** Автоферма: держать реальную вкладку Twitch на канале с дропсами. */
  autoFarm: false,
  /** Мьютить вкладку автофермы. */
  farmMuted: true,
  /** Не давать Twitch ставить плеер на паузу в скрытой вкладке. */
  backgroundWatch: true,
  /** Как выбирать канал для автофермы. */
  farmStrategy: 'random',
  /** Какую игру/группу кампаний брать следующей: дедлайн или быстрый прогресс. */
  farmPriority: 'deadline',
  /** Переключать канал, если прогресс стоит слишком долго. */
  farmAutoSwitch: true,
});

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asInterval(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.round(numeric);
  return INTERVAL_OPTIONS.includes(rounded) ? rounded : fallback;
}

export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const strategy = FARM_STRATEGIES.includes(source.farmStrategy)
    ? source.farmStrategy
    : DEFAULT_SETTINGS.farmStrategy;
  const priority = FARM_PRIORITIES.includes(source.farmPriority)
    ? source.farmPriority
    : DEFAULT_SETTINGS.farmPriority;
  return {
    autoClaimDrops: asBool(source.autoClaimDrops, DEFAULT_SETTINGS.autoClaimDrops),
    autoClaimPoints: asBool(source.autoClaimPoints, DEFAULT_SETTINGS.autoClaimPoints),
    notifyClaims: asBool(source.notifyClaims, DEFAULT_SETTINGS.notifyClaims),
    dropsIntervalMin: asInterval(source.dropsIntervalMin, DEFAULT_SETTINGS.dropsIntervalMin),
    pointsIntervalMin: asInterval(source.pointsIntervalMin, DEFAULT_SETTINGS.pointsIntervalMin),
    autoFarm: asBool(source.autoFarm, DEFAULT_SETTINGS.autoFarm),
    farmMuted: asBool(source.farmMuted, DEFAULT_SETTINGS.farmMuted),
    backgroundWatch: asBool(source.backgroundWatch, DEFAULT_SETTINGS.backgroundWatch),
    farmStrategy: strategy,
    farmPriority: priority,
    farmAutoSwitch: asBool(source.farmAutoSwitch, DEFAULT_SETTINGS.farmAutoSwitch),
  };
}

/**
 * Apply a partial settings patch. Unknown keys are ignored, so messages from
 * the popup can never pollute the stored settings object.
 */
export function applySettingsPatch(current, patch) {
  const base = normalizeSettings(current);
  if (!patch || typeof patch !== 'object') return base;
  const merged = { ...base };
  const allowed = Object.keys(DEFAULT_SETTINGS);
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      merged[key] = patch[key];
    }
  }
  return normalizeSettings(merged);
}

export function areClaimsEnabled(settings) {
  const normalized = normalizeSettings(settings);
  return normalized.autoClaimDrops || normalized.autoClaimPoints;
}

/** Human-readable interval used by the popup selects. */
export function intervalLabel(minutes) {
  const value = clamp(Number(minutes) || 1, 1, 60);
  return value === 1 ? 'каждую минуту' : `каждые ${value} мин`;
}
