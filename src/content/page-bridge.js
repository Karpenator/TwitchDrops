/*
 * MAIN-world bridge. Runs inside the Twitch page so it can:
 *  - capture the Client-Integrity token Twitch obtains for its own GQL calls;
 *  - observe the PubSub websocket for "points claim available" / drop events;
 *  - relay a GraphQL request through the page session as a last-resort fallback.
 *
 * Everything is defensive: a failure in one hook must never break Twitch.
 */
(() => {
  if (window.__twitchautopilotPageBridge) return;
  window.__twitchautopilotPageBridge = true;

  const TO_PAGE = '__twitchautopilot_page_event__';
  const TO_CONTENT = '__twitchautopilot_content_event__';
  const INTEGRITY_KEY = '__twitchautopilot_integrity__';
  const GQL_URL = 'https://gql.twitch.tv/gql';

  function emit(type, payload) {
    try {
      window.dispatchEvent(
        new CustomEvent(TO_PAGE, {
          detail: JSON.stringify({ type, payload: payload || null, at: Date.now() }),
        }),
      );
    } catch {
      // Ignore serialization/CustomEvent failures.
    }
  }

  function safeJson(value) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  // --- Client-Integrity capture -------------------------------------------

  try {
    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function twitchautopilotFetch(...args) {
        const result = originalFetch.apply(this, args);
        try {
          const input = args[0];
          const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
          if (url && url.indexOf('gql.twitch.tv/integrity') !== -1 && result && result.then) {
            result
              .then((response) => response.clone().json())
              .then((data) => {
                if (!data || typeof data.token !== 'string' || !data.token) return;
                const integrity = {
                  token: data.token,
                  expiration: typeof data.expiration === 'number' ? data.expiration : 0,
                  requestId: typeof data.request_id === 'string' ? data.request_id : '',
                  source: 'page',
                  capturedAt: Date.now(),
                };
                try {
                  window.sessionStorage.setItem(INTEGRITY_KEY, JSON.stringify(integrity));
                } catch {
                  // sessionStorage can be unavailable in private contexts.
                }
                emit('integrity', integrity);
              })
              .catch(() => {});
          }
        } catch {
          // Never let the observer break the original request.
        }
        return result;
      };
    }
  } catch {
    // Non-fatal.
  }

  // --- PubSub websocket observer ------------------------------------------

  try {
    const NativeWebSocket = window.WebSocket;
    if (typeof NativeWebSocket === 'function') {
      const handler = (event) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : '';
          if (!raw) return;
          const message = safeJson(raw);
          if (!message || message.type !== 'MESSAGE' || !message.data) return;
          const topic = String(message.data.topic || '');
          const body = safeJson(message.data.message);
          if (!body || typeof body !== 'object') return;

          if (topic.indexOf('community-points-user-v1') === 0) {
            if (body.type === 'claim-available') {
              const claim = body.data && body.data.claim;
              if (claim && claim.id) {
                emit('points-claim-available', {
                  channelId: String(claim.channel_id || ''),
                  claimId: String(claim.id),
                });
              }
            }
            return;
          }

          if (topic.indexOf('user-drop-events') === 0) {
            if (body.type === 'drop-progress') {
              const data = body.data || {};
              const current = Number(data.current_progress_min);
              const required = Number(data.required_progress_min);
              if (Number.isFinite(current) && Number.isFinite(required) && current >= required) {
                emit('drop-ready', {
                  dropId: String(data.drop_id || ''),
                  campaignId: String(data.campaign_id || ''),
                });
              }
            }
            return;
          }

          if (topic.indexOf('onsite-notifications') === 0) {
            const notification = body.data && body.data.notification;
            if (
              body.type === 'create-notification' &&
              notification &&
              notification.type === 'user_drop_reward_reminder_notification'
            ) {
              emit('drop-ready', {});
            }
          }
        } catch {
          // Ignore malformed PubSub frames.
        }
      };

      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args) {
          const socket = Reflect.construct(target, args);
          try {
            const url = String(args[0] || '');
            if (url.indexOf('pubsub-edge.twitch.tv') !== -1) {
              socket.addEventListener('message', handler);
            }
          } catch {
            // Some custom WebSocket implementations reject listeners.
          }
          return socket;
        },
      });
    }
  } catch {
    // Non-fatal.
  }

  // --- GQL relay ----------------------------------------------------------

  window.addEventListener(TO_CONTENT, (event) => {
    let message;
    try {
      message = safeJson(event.detail);
    } catch {
      return;
    }
    if (!message || message.type !== 'gql-request' || !message.requestId) return;

    const headers = Object.assign(
      {
        'Content-Type': 'text/plain;charset=UTF-8',
      },
      message.headers && typeof message.headers === 'object' ? message.headers : {},
    );

    let request;
    try {
      request = fetch(GQL_URL, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(message.payload),
      });
    } catch (error) {
      emit('gql-response', {
        requestId: message.requestId,
        ok: false,
        error: String(error && error.message ? error.message : error),
      });
      return;
    }

    request
      .then(async (response) => {
        const text = await response.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        emit('gql-response', {
          requestId: message.requestId,
          ok: response.ok && json != null,
          status: response.status,
          json,
        });
      })
      .catch((error) => {
        emit('gql-response', {
          requestId: message.requestId,
          ok: false,
          error: String(error && error.message ? error.message : error),
        });
      });
  });
})();
