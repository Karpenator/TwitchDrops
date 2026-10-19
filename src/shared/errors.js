export const ERROR_CODES = Object.freeze({
  AUTH: 'auth',
  INTEGRITY: 'integrity',
  RATE_LIMIT: 'rate-limit',
  NOT_FOUND: 'not-found',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  PARSE: 'parse',
  UNKNOWN: 'unknown',
});

export class TwitchApiError extends Error {
  constructor(message, { code = ERROR_CODES.UNKNOWN, status = 0, details = null } = {}) {
    super(message);
    this.name = 'TwitchApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function isAuthError(error) {
  return error instanceof TwitchApiError && error.code === ERROR_CODES.AUTH;
}

export function isIntegrityError(error) {
  return error instanceof TwitchApiError && error.code === ERROR_CODES.INTEGRITY;
}

/** Classify an arbitrary thrown value into a stable code. */
export function classifyError(error) {
  if (error instanceof TwitchApiError) return error.code;
  const message = String(error?.message || error || '').toLowerCase();
  if (error?.name === 'AbortError' || message.includes('timed out')) return ERROR_CODES.TIMEOUT;
  if (message.includes('failed to fetch') || message.includes('networkerror')) {
    return ERROR_CODES.NETWORK;
  }
  return ERROR_CODES.UNKNOWN;
}

const MESSAGES = {
  [ERROR_CODES.AUTH]: 'Сессия Twitch не найдена или истекла. Откройте Twitch и войдите в аккаунт.',
  [ERROR_CODES.INTEGRITY]: 'Twitch отклонил проверку клиента. Откройте любую страницу Twitch и повторите.',
  [ERROR_CODES.RATE_LIMIT]: 'Twitch временно ограничил запросы. Попробуем ещё через несколько минут.',
  [ERROR_CODES.NOT_FOUND]: 'Twitch не нашёл эти данные. Возможно, кампания уже завершилась.',
  [ERROR_CODES.NETWORK]: 'Нет связи с Twitch. Проверьте интернет и повторите.',
  [ERROR_CODES.TIMEOUT]: 'Twitch не ответил вовремя. Попробуйте обновить ещё раз.',
  [ERROR_CODES.PARSE]: 'Twitch вернул неожиданный ответ. Попробуйте позже.',
  [ERROR_CODES.UNKNOWN]: 'Не удалось получить данные от Twitch.',
};

/** Short, user-facing Russian message. */
export function describeError(error) {
  if (error instanceof TwitchApiError && error.message) {
    if (error.code === ERROR_CODES.UNKNOWN) return error.message;
    return MESSAGES[error.code] || error.message;
  }
  const code = classifyError(error);
  return MESSAGES[code] || MESSAGES[ERROR_CODES.UNKNOWN];
}

/** Extract the first GraphQL error message from a response. */
export function firstGqlError(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  for (const item of errors) {
    if (item && typeof item.message === 'string' && item.message.trim()) {
      return item.message.trim();
    }
  }
  if (typeof payload?.error === 'string') {
    return payload.error;
  }
  return '';
}

export function errorFromGqlMessage(message, status = 200) {
  const lower = message.toLowerCase();
  if (lower.includes('persistedquerynotfound')) {
    return new TwitchApiError(message, { code: ERROR_CODES.NOT_FOUND, status });
  }
  if (lower.includes('integrity') || lower.includes('failed integrity check')) {
    return new TwitchApiError(message, { code: ERROR_CODES.INTEGRITY, status });
  }
  if (lower.includes('unauthorized') || lower.includes('oauth') || lower.includes('login')) {
    return new TwitchApiError(message, { code: ERROR_CODES.AUTH, status });
  }
  if (lower.includes('rate limit') || lower.includes('slow down')) {
    return new TwitchApiError(message, { code: ERROR_CODES.RATE_LIMIT, status });
  }
  if (lower.includes('not found')) {
    return new TwitchApiError(message, { code: ERROR_CODES.NOT_FOUND, status });
  }
  return new TwitchApiError(message, { code: ERROR_CODES.UNKNOWN, status });
}
