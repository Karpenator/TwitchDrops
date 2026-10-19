import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The visibility guard is a MAIN-world content script (plain IIFE, no imports).
 * Run it in a small DOM fake and check the Page Visibility override, the
 * visibilitychange suppression and the playback watchdog.
 */
const source = readFileSync(
  fileURLToPath(new URL('../src/content/visibility-guard.js', import.meta.url)),
  'utf8',
);

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, handler, options) {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ handler, capture });
  }

  listenersFor(type, capture) {
    return (this.listeners.get(type) || []).filter((item) => item.capture === capture);
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.visibility = 'hidden';
    this.focused = false;
    this.videos = [];
  }

  get hidden() {
    return this.visibility === 'hidden';
  }

  get visibilityState() {
    return this.visibility;
  }

  get webkitHidden() {
    return this.hidden;
  }

  get webkitVisibilityState() {
    return this.visibility;
  }

  hasFocus() {
    return this.focused;
  }

  querySelectorAll(selector) {
    return selector === 'video' ? this.videos : [];
  }

  dispatch(event, target = this) {
    return this.ownerWindow.dispatchEvent(event, target);
  }
}

class FakeWindow extends FakeEventTarget {
  constructor(document, clock) {
    super();
    this.document = document;
    this.clock = clock;
    this.localStorage = makeStorage();
    this.sessionStorage = makeStorage();
    this.setTimeout = (fn, delay) => clock.setTimeout(fn, delay);
  }

  dispatchEvent(event, target = this) {
    event.target = target;
    // Capture phase: window listeners first, then the document ones.
    for (const { handler } of this.listenersFor(event.type, true)) {
      if (event.stopped) break;
      handler.call(this, event);
    }
    if (target !== this) {
      // Capture down to the document, then target capture/bubble, then the
      // document bubble listeners (the guard only uses capture).
      const document = this.document;
      if (document && document !== target) {
        for (const { handler } of document.listenersFor(event.type, true)) {
          if (event.stopped) break;
          handler.call(document, event);
        }
      }
      for (const { handler } of target.listenersFor(event.type, true)) {
        if (event.stopped) break;
        handler.call(target, event);
      }
      for (const { handler } of target.listenersFor(event.type, false)) {
        if (event.stopped) break;
        handler.call(target, event);
      }
      if (document && document !== target) {
        for (const { handler } of document.listenersFor(event.type, false)) {
          if (event.stopped) break;
          handler.call(document, event);
        }
      }
    }
    return !event.stopped;
  }
}

class FakeEvent {
  constructor(type) {
    this.type = type;
    this.stopped = false;
    this.defaultPrevented = false;
  }

  stopImmediatePropagation() {
    this.stopped = true;
  }

  stopPropagation() {
    this.stopped = true;
  }
}

class FakeCustomEvent extends FakeEvent {
  constructor(type, options = {}) {
    super(type);
    this.detail = options.detail;
  }
}

/** Deterministic timers: the guard schedules retries up to 8 s ahead. */
function makeClock() {
  // Start at a real epoch: the guard treats a zero timestamp as "never away".
  let now = 1_700_000_000_000;
  let seq = 0;
  const timers = new Map();
  return {
    get now() {
      return now;
    },
    setTimeout(fn, delay = 0) {
      seq += 1;
      timers.set(seq, { at: now + Math.max(0, Number(delay) || 0), fn, seq });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    get size() {
      return timers.size;
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq);
        if (!due.length) break;
        const [id, timer] = due[0];
        timers.delete(id);
        now = timer.at;
        timer.fn();
      }
      now = end;
    },
  };
}

function makeStorage() {
  return {
    data: new Map(),
    getItem(key) {
      return this.data.has(key) ? this.data.get(key) : null;
    },
    setItem(key, value) {
      this.data.set(key, String(value));
    },
  };
}

function makeEnvironment({ visibility = 'hidden', enabled = null, farm = null, videos = [] } = {}) {
  // Every environment needs its own prototype: the guard installs accessors
  // on Document.prototype and a shared class would leak them into the next test.
  class TestDocument extends FakeDocument {}
  const document = new TestDocument();
  document.visibility = visibility;
  const clock = makeClock();
  const window = new FakeWindow(document, clock);
  document.ownerWindow = window;
  document.videos = videos;
  if (enabled != null) window.localStorage.data.set('twitchautopilot:bg-watch', enabled ? '1' : '0');
  if (farm != null) window.sessionStorage.data.set('twitchautopilot:farm-tab', farm ? '1' : '0');

  const fakeDate = { now: () => clock.now };
  const run = new Function(
    'window',
    'document',
    'Document',
    'CustomEvent',
    'MutationObserver',
    'Date',
    'setTimeout',
    source,
  );
  run(
    window,
    document,
    TestDocument,
    FakeCustomEvent,
    undefined,
    fakeDate,
    (fn, delay) => clock.setTimeout(fn, delay),
  );
  return { window, document, clock, guard: window.__twitchautopilotGuard };
}

function fakeVideo({ paused = true, muted = true, volume = 0.5, readyState = 4 } = {}) {
  const video = {
    tagName: 'VIDEO',
    addEventListener() {},
    removeEventListener() {},
    listenersFor() {
      return [];
    },
    paused,
    muted,
    volume,
    ended: false,
    readyState,
    plays: 0,
    play() {
      video.plays += 1;
      video.paused = false;
      return Promise.resolve();
    },
    pause() {
      video.paused = true;
    },
  };
  return video;
}


test('the guard is enabled by default and reports a visible page', async () => {
  const { document, guard, clock } = makeEnvironment({ visibility: 'hidden' });
  assert.equal(guard.enabled, true);
  assert.equal(guard.farm, false);
  assert.equal(document.hidden, false);
  assert.equal(document.visibilityState, 'visible');
  assert.equal(document.webkitHidden, false);
  assert.equal(document.webkitVisibilityState, 'visible');
  assert.equal(document.hasFocus(), true);
  clock.advance(10);
});

test('the guard can be disabled and then exposes native values', async () => {
  const { document, guard, clock } = makeEnvironment({ visibility: 'hidden', enabled: false });
  assert.equal(guard.enabled, false);
  assert.equal(document.hidden, true);
  assert.equal(document.visibilityState, 'hidden');
  assert.equal(document.hasFocus(), false);

  guard.setConfig(true, false);
  assert.equal(document.hidden, false);
  assert.equal(document.visibilityState, 'visible');

  guard.setConfig(false, false);
  assert.equal(document.hidden, true);
  assert.equal(document.visibilityState, 'hidden');
  clock.advance(10);
});

test('a CustomEvent from the content script reconfigures the guard', async () => {
  const { window, document, guard, clock } = makeEnvironment({ enabled: false });
  assert.equal(guard.enabled, false);
  window.dispatchEvent(
    new FakeCustomEvent('__twitchautopilot_guard_event__', {
      detail: JSON.stringify({ enabled: true, farm: true }),
    }),
  );
  assert.equal(guard.enabled, true);
  assert.equal(guard.farm, true);
  assert.equal(document.visibilityState, 'visible');
  assert.equal(window.localStorage.getItem('twitchautopilot:bg-watch'), '1');
  assert.equal(window.sessionStorage.getItem('twitchautopilot:farm-tab'), '1');
  assert.equal(window.localStorage.getItem('twitchautopilot:farm-tab'), null, 'farm stays per tab');
  clock.advance(10);
});

test('visibilitychange listeners never see the event while the guard is on', async () => {
  const { document, window, guard, clock } = makeEnvironment({ visibility: 'visible' });
  let documentEvents = 0;
  let windowEvents = 0;
  document.addEventListener('visibilitychange', () => {
    documentEvents += 1;
  });
  window.addEventListener('visibilitychange', () => {
    windowEvents += 1;
  });

  document.dispatch(new FakeEvent('visibilitychange'));
  assert.equal(documentEvents, 0);
  assert.equal(windowEvents, 0);

  guard.setConfig(false, false);
  document.dispatch(new FakeEvent('visibilitychange'));
  assert.equal(documentEvents, 1, 'the event is delivered when the guard is off');
  clock.advance(10);
});

test('a paused video is resumed after the tab becomes hidden', async () => {
  const video = fakeVideo({ paused: true, muted: true });
  const { document, clock } = makeEnvironment({ visibility: 'hidden', videos: [video] });
  document.dispatch(new FakeEvent('visibilitychange'));
  clock.advance(5);
  assert.equal(video.paused, false, 'the first retry starts playback');
});

test('farm mode unmutes the player element and keeps it silent', async () => {
  const video = fakeVideo({ paused: false, muted: true, volume: 0.8 });
  const { document, guard, clock } = makeEnvironment({
    visibility: 'hidden',
    farm: true,
    videos: [video],
  });
  assert.equal(guard.farm, true);
  document.dispatch(new FakeEvent('visibilitychange'));
  clock.advance(5);
  assert.equal(video.muted, false, 'media element must not be muted for Chrome');
  assert.equal(video.volume, 0, 'sound is muted at the tab level instead');

  guard.setConfig(true, false);
  assert.equal(video.muted, true, 'leaving farm mode restores mute');
  assert.equal(video.volume, 0.8, 'leaving farm mode restores volume');
});

test('non-farm tabs keep the user volume and mute state', async () => {
  const video = fakeVideo({ paused: false, muted: true, volume: 0.8 });
  const { document, clock } = makeEnvironment({ visibility: 'hidden', videos: [video] });
  document.dispatch(new FakeEvent('visibilitychange'));
  clock.advance(5);
  assert.equal(video.muted, true);
  assert.equal(video.volume, 0.8);
});

test('a pause right after an away event is undone, a later pause is respected', async () => {
  const video = fakeVideo({ paused: false });
  const { document, clock } = makeEnvironment({ visibility: 'visible', videos: [video] });
  document.dispatch(new FakeEvent('blur'));
  clock.advance(10);
  video.pause();
  document.dispatch(new FakeEvent('pause'), video);
  clock.advance(250);
  assert.equal(video.paused, false, 'page-initiated pause while away is reverted');

  // Let the grace period expire, then pause deliberately.
  clock.advance(10_000);
  video.pause();
  document.dispatch(new FakeEvent('pause'), video);
  clock.advance(1_000);
  assert.equal(video.paused, true, 'a deliberate pause is not fought');
});
