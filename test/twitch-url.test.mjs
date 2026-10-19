import test from 'node:test';
import assert from 'node:assert/strict';
import { categorySlug, categoryUrl } from '../src/shared/twitch-url.js';

const CATEGORY_ROOT = 'https://www.twitch.tv/directory/category/';
const examples = [
  ['Arena Breakout: Infinite', 'arena-breakout-infinite'],
  ['Dungeons & Dragons', 'dungeons-and-dragons'],
  ['Dungeons &amp; Dragons', 'dungeons-and-dragons'],
  ['ACE COMBAT 8: WINGS OF THEVE', 'ace-combat-8-wings-of-theve'],
  ['Warhammer 40,000: Space Marine II', 'warhammer-40-000-space-marine-ii'],
];

for (const [name, slug] of examples) {
  test(`category URLs preserve word boundaries: ${name}`, () => {
    assert.equal(categorySlug(name), slug);
    assert.equal(categoryUrl(name), `${CATEGORY_ROOT}${slug}`);
    assert.equal(categoryUrl(name, { dropsOnly: true }), `${CATEGORY_ROOT}${slug}?filter=drops`);
    assert.equal(categoryUrl(slug, { dropsOnly: true }), `${CATEGORY_ROOT}${slug}?filter=drops`);
  });
}

test('canonical slugs are not rewritten and a name fallback handles common separators', () => {
  assert.equal(categorySlug('  arena-breakout-infinite  '), 'arena-breakout-infinite');
  assert.equal(categorySlug('official--slug-2026'), 'official--slug-2026');
  assert.equal(categorySlug('  Arena\tBreakout:\u00a0 Infinite! '), 'arena-breakout-infinite');
  assert.equal(categorySlug('Dungeons &#38; Dragons'), 'dungeons-and-dragons');
  assert.equal(categorySlug('Dungeons &#x26; Dragons'), 'dungeons-and-dragons');
  assert.equal(categorySlug('Dungeons&nbsp;&amp;&nbsp;Dragons'), 'dungeons-and-dragons');
  assert.equal(categorySlug("Tom Clancy’s Rainbow Six® Siege"), 'tom-clancys-rainbow-six-siege');
  assert.equal(categorySlug('Pokémon™ Unite'), 'pokemon-unite');
});

test('empty category names use the directory, and Unicode is safely URL-encoded', () => {
  for (const value of ['', null, undefined, '   ', ' : , --- ']) {
    assert.equal(categoryUrl(value, { dropsOnly: true }), 'https://www.twitch.tv/directory');
  }
  const url = new URL(categoryUrl('Игра: Приключение', { dropsOnly: true }));
  assert.equal(decodeURIComponent(url.pathname), '/directory/category/игра-приключение');
  assert.equal(url.searchParams.get('filter'), 'drops');
});

test('category text cannot introduce a different host, query or fragment', () => {
  const url = new URL(categoryUrl('https://evil.example/Arena?filter=all#x', { dropsOnly: true }));
  assert.equal(url.origin, 'https://www.twitch.tv');
  assert.ok(url.pathname.startsWith('/directory/category/'));
  assert.equal(url.search, '?filter=drops');
  assert.equal(url.hash, '');
});
