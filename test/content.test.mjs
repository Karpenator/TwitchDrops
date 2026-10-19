import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');

function environment(url = 'https://www.twitch.tv/drops_streamer') {
  const messages = [];
  const events = new Map();
  const intervals = [];
  const mediaEvents = new Map();
  let onMessage;
  const location = new URL(url);
  const entries = new Map();
  const storage = { getItem(key) { return entries.get(key) ?? null; }, setItem(key, value) { entries.set(key, value); } };
  const window = {
    localStorage: storage,
    sessionStorage: storage,
    addEventListener(type, handler) { events.set(type, handler); },
    dispatchEvent() {},
  };
  const document = {
    cookie: '', videos: [],
    querySelectorAll(selector) { return selector === 'video' ? this.videos : []; },
    addEventListener(type, handler) { mediaEvents.set(type, handler); },
  };
  const chrome = { runtime: {
    async sendMessage(message) { messages.push(message); return { ok: false }; },
    onMessage: { addListener(listener) { onMessage = listener; } },
  } };
  new Function('window', 'document', 'location', 'chrome', 'setInterval', 'CustomEvent', source)(
    window, document, location, chrome,
    (handler, delay) => { intervals.push({ handler, delay }); },
    class CustomEvent { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
  );
  return {
    messages, location, document,
    message(message) {
      let response;
      onMessage(message, {}, (value) => { response = value; });
      return response;
    },
    canPlay(video) { mediaEvents.get('canplay')({ target: video }); },
    poll() { intervals.find(({ delay }) => delay === 5_000).handler(); },
    navigate(url) {
      location.href = url;
      events.get('__twitchautopilot_page_event__')({ detail: JSON.stringify({ type: 'navigation' }) });
    },
  };
}

test('the content script reports channel changes caused by raid navigation', () => {
  const env = environment();
  env.navigate('https://www.twitch.tv/no_drops?referrer=raid');
  assert.deepEqual(env.messages.filter(({ type }) => type === 'TAB_CHANNEL'), [
    { type: 'TAB_CHANNEL', payload: { login: 'drops_streamer' } },
    { type: 'TAB_CHANNEL', payload: { login: 'no_drops' } },
  ]);
});

test('redirects to non-channel pages also trigger the farm navigation check', () => {
  const env = environment();
  env.navigate('https://www.twitch.tv/directory/category/just-chatting');
  assert.deepEqual(env.messages.at(-1), { type: 'TAB_CHANNEL', payload: { login: '' } });
});

test('the five-second URL poll catches missed SPA events without repeating unchanged URLs', () => {
  const env = environment();
  env.poll();
  assert.equal(env.messages.filter(({ type }) => type === 'TAB_CHANNEL').length, 1);
  env.location.href = 'https://www.twitch.tv/no_drops';
  env.poll();
  env.poll();
  const navigations = env.messages.filter(({ type }) => type === 'TAB_CHANNEL');
  assert.equal(navigations.length, 2);
  assert.equal(navigations[1].payload.login, 'no_drops');
});

function pausedVideo() {
  return {
    tagName: 'VIDEO', readyState: 3, ended: false, paused: true, muted: true, volume: 1, plays: 0,
    play() { this.plays += 1; this.paused = false; return Promise.resolve(); },
  };
}

test('entering farm mode starts the existing player even with the visibility guard disabled', () => {
  const env = environment();
  const video = pausedVideo();
  env.document.videos = [video];
  env.message({ type: 'GUARD_CONFIG', enabled: false, farm: true });
  assert.equal(video.plays, 1);
  assert.equal(video.paused, false);
  assert.equal(video.muted, false);
  assert.equal(video.volume, 0);
});

test('a late player starts on canplay after farm navigation, without waiting for an alarm', () => {
  const env = environment();
  env.message({ type: 'GUARD_CONFIG', enabled: true, farm: true });
  const video = pausedVideo();
  env.document.videos = [video];
  env.canPlay(video);
  assert.equal(video.plays, 1);
  assert.equal(video.paused, false);
  assert.equal(video.volume, 0);
});

test('canplay does not start videos in ordinary tabs or after leaving farm mode', () => {
  const env = environment();
  const video = pausedVideo();
  env.document.videos = [video];
  env.canPlay(video);
  assert.equal(video.plays, 0);
  env.message({ type: 'GUARD_CONFIG', enabled: true, farm: true });
  video.paused = true;
  env.message({ type: 'GUARD_CONFIG', enabled: true, farm: false });
  env.canPlay(video);
  assert.equal(video.plays, 1, 'only the explicit initial farm start plays the video');
  assert.equal(video.paused, true);
});
