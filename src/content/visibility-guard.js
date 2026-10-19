/*
 * Background playback guard (MAIN world, runs at document_start).
 *
 * Browsers mark background tabs/occluded windows as hidden, and Twitch pauses
 * its player when that happens. Chrome 145+ additionally pauses muted media
 * when the tab loses visibility. Drop progress stops with the player.
 *
 * This guard keeps the page "visible" for Twitch's own scripts, swallows the
 * visibilitychange event so the player never pauses, and resumes playback if
 * it was paused anyway. On the auto-farm tab it also un-mutes the <video>
 * element (the tab itself is muted by the extension) with volume 0, which is
 * the documented workaround for Chrome's muted-media suspension.
 *
 * It is controlled from the isolated content script through a CustomEvent:
 *   { enabled: boolean, farm: boolean }
 * The setting is mirrored to localStorage and the farm flag to sessionStorage,
 * so a freshly loaded (or reloaded) tab applies the right mode before the
 * content script wakes up, without leaking the farm flag to other tabs.
 */
(() => {
  if (window.__twitchautopilotGuard) return;

  const CONFIG_EVENT = '__twitchautopilot_guard_event__';
  const ENABLED_KEY = 'twitchautopilot:bg-watch';
  const FARM_KEY = 'twitchautopilot:farm-tab';
  const RESUME_DELAYS = [0, 400, 1200, 3000, 8000];
  const PAUSE_GRACE_MS = 8_000;

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
      // Private mode or storage disabled: the in-memory state still works.
    }
  }

  // The setting is global, the farm flag is per tab: sessionStorage survives a
  // reload of this tab but is never shared with the user's other Twitch tabs.
  function safeStorage(getter) {
    try {
      return getter();
    } catch {
      return null;
    }
  }

  const flags = {
    enabled: safeStorage(() => window.localStorage),
    farm: safeStorage(() => window.sessionStorage),
  };

  const config = {
    enabled: readFlag(flags.enabled, ENABLED_KEY, true),
    farm: readFlag(flags.farm, FARM_KEY, false),
  };
  let lastAwayAt = 0;
  let lastResumeAt = 0;

  // --- Page Visibility API override ---------------------------------------

  const documentProto = typeof Document !== 'undefined' ? Document.prototype : null;
  const native = {};

  function nativeGetter(name) {
    // Walk the prototype chain: engines define some of these further up
    // (and test doubles may subclass Document).
    let proto = documentProto;
    while (proto) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name);
        if (descriptor && typeof descriptor.get === 'function') return descriptor.get;
      } catch {
        return null;
      }
      proto = Object.getPrototypeOf(proto);
    }
    return null;
  }

  native.hidden = nativeGetter('hidden');
  native.visibilityState = nativeGetter('visibilityState');
  native.webkitHidden = nativeGetter('webkitHidden');
  native.webkitVisibilityState = nativeGetter('webkitVisibilityState');
  native.hasFocus =
    documentProto && typeof documentProto.hasFocus === 'function' ? documentProto.hasFocus : null;

  function defineAccessor(name, getter) {
    if (!documentProto) return;
    try {
      Object.defineProperty(documentProto, name, {
        configurable: true,
        enumerable: true,
        get: getter,
      });
    } catch {
      // Older engines may lock the descriptor; the event suppression still helps.
    }
  }

  defineAccessor('hidden', function hidden() {
    return config.enabled ? false : native.hidden ? native.hidden.call(this) : false;
  });
  defineAccessor('visibilityState', function visibilityState() {
    return config.enabled
      ? 'visible'
      : native.visibilityState
        ? native.visibilityState.call(this)
        : 'visible';
  });
  if (native.webkitHidden) {
    defineAccessor('webkitHidden', function webkitHidden() {
      return config.enabled ? false : native.webkitHidden.call(this);
    });
  }
  if (native.webkitVisibilityState) {
    defineAccessor('webkitVisibilityState', function webkitVisibilityState() {
      return config.enabled ? 'visible' : native.webkitVisibilityState.call(this);
    });
  }
  if (native.hasFocus) {
    try {
      // hasFocus() is a method, not an accessor.
      Object.defineProperty(documentProto, 'hasFocus', {
        configurable: true,
        writable: true,
        value: function hasFocus() {
          return config.enabled ? true : native.hasFocus.call(this);
        },
      });
    } catch {
      // Descriptor is locked on some engines.
    }
  }

  // --- Playback keep-alive -------------------------------------------------

  function videos() {
    try {
      return Array.from(document.querySelectorAll('video'));
    } catch {
      return [];
    }
  }

  // Original sound state of every element we silenced, so leaving farm mode
  // gives the user their volume back.
  const originalAudio = new WeakMap();

  /** Silent playback on the farm tab: the tab itself is muted by the extension. */
  function silenceFarmVideo(video) {
    if (!config.farm || !video) return;
    try {
      if (!originalAudio.has(video)) {
        originalAudio.set(video, { muted: video.muted, volume: video.volume });
      }
      // An unmuted element at volume 0 is not "muted media" for Chrome 145+,
      // which would otherwise pause it in a hidden tab.
      if (video.muted) video.muted = false;
      if (video.volume > 0) video.volume = 0;
    } catch {
      // Media element may be detached while Twitch swaps players.
    }
  }

  function restoreFarmVideo(video) {
    const saved = originalAudio.get(video);
    if (!saved) return;
    originalAudio.delete(video);
    try {
      video.muted = saved.muted;
      video.volume = saved.volume;
    } catch {
      // Element is gone.
    }
  }

  function resume() {
    if (!config.enabled) return;
    lastResumeAt = Date.now();
    for (const video of videos()) {
      silenceFarmVideo(video);
      try {
        if (video.paused && !video.ended) {
          const promise = video.play();
          if (promise && typeof promise.catch === 'function') promise.catch(() => {});
        }
      } catch {
        // play() can reject while the player is re-buffering; retries follow.
      }
    }
  }

  function resumeThrottled() {
    if (!config.enabled) return;
    if (Date.now() - lastResumeAt < 1_500) return;
    resume();
  }

  function scheduleResume(reason) {
    if (!config.enabled) return;
    if (reason) lastAwayAt = Date.now();
    for (const delay of RESUME_DELAYS) {
      try {
        window.setTimeout(resume, delay);
      } catch {
        // Ignore timer failures (page is unloading).
      }
    }
  }

  function suppressVisibilityChange(event) {
    if (!config.enabled) return;
    lastAwayAt = Date.now();
    try {
      event.stopImmediatePropagation();
    } catch {
      // Non-standard event object.
    }
    scheduleResume();
  }

  for (const type of ['visibilitychange', 'webkitvisibilitychange']) {
    try {
      window.addEventListener(type, suppressVisibilityChange, true);
    } catch {
      // Non-fatal.
    }
    try {
      document.addEventListener(type, suppressVisibilityChange, true);
    } catch {
      // Non-fatal.
    }
  }

  try {
    // Losing focus is not the same as being hidden, but Twitch may still pause.
    window.addEventListener('blur', () => scheduleResume(true), true);
    window.addEventListener('focus', () => resumeThrottled(), true);
  } catch {
    // Non-fatal.
  }

  // If the page pauses the player right after an away event, resume it. A pause
  // later than the grace period is treated as a deliberate user action.
  try {
    document.addEventListener(
      'pause',
      (event) => {
        if (!config.enabled) return;
        const target = event.target;
        if (!target || String(target.tagName || '').toUpperCase() !== 'VIDEO') return;
        if (!lastAwayAt || Date.now() - lastAwayAt > PAUSE_GRACE_MS) return;
        window.setTimeout(resume, 250);
      },
      true,
    );
  } catch {
    // Non-fatal.
  }

  // Farm mode: keep silence applied when Twitch replaces the player element.
  // The observer is installed in every mode so entering farm mode later works.
  if (typeof MutationObserver === 'function' && document.documentElement) {
    try {
      const observer = new MutationObserver(() => {
        if (config.farm) resumeThrottled();
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch {
      // Non-fatal.
    }
  }

  // --- Configuration from the isolated content script ---------------------

  function applyConfig(enabled, farm) {
    if (typeof enabled === 'boolean') {
      config.enabled = enabled;
      writeFlag(flags.enabled, ENABLED_KEY, enabled);
    }
    if (typeof farm === 'boolean') {
      const leavingFarm = config.farm && !farm;
      config.farm = farm;
      writeFlag(flags.farm, FARM_KEY, farm);
      if (leavingFarm) {
        for (const video of videos()) restoreFarmVideo(video);
      }
    }
    if (config.enabled) scheduleResume();
  }

  try {
    window.addEventListener(
      CONFIG_EVENT,
      (event) => {
        let detail = null;
        try {
          detail = JSON.parse(event.detail);
        } catch {
          return;
        }
        if (!detail || typeof detail !== 'object') return;
        applyConfig(detail.enabled, detail.farm);
      },
      true,
    );
  } catch {
    // Non-fatal.
  }

  window.__twitchautopilotGuard = {
    get enabled() {
      return config.enabled;
    },
    get farm() {
      return config.farm;
    },
    setConfig(enabled, farm) {
      applyConfig(enabled, farm);
    },
    resume: resumeThrottled,
  };

  if (config.enabled) scheduleResume(false);
})();
