import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');

function environment(url = 'https://www.twitch.tv/drops_streamer') {
  const messages = [];
  const events = new Map();
  const intervals = [];
  const location = new URL(url);
  const storage = { getItem() { return null; }, setItem() {} };
  const window = {
    localStorage: storage,
    sessionStorage: storage,
    addEventListener(type, handler) { events.set(type, handler); },
  };
  const document = { cookie: '', querySelectorAll() { return []; } };
  const chrome = { runtime: {
    async sendMessage(message) { messages.push(message); return { ok: false }; },
    onMessage: { addListener() {} },
  } };
  new Function('window', 'document', 'location', 'chrome', 'setInterval', source)(
    window, document, location, chrome,
    (handler, delay) => { intervals.push({ handler, delay }); },
  );
  return {
    messages, location,
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
