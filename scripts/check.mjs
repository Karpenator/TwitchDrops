#!/usr/bin/env node
/**
 * Static project check. No browser required:
 *  - manifest/package/README sanity
 *  - every referenced file exists
 *  - icons are real PNGs with matching dimensions
 *  - every JS file parses (`node --check`)
 *  - every relative import resolves
 *  - popup assets resolve and no MV3-illegal code sneaks in
 *  - chrome.* usage is covered by manifest permissions
 *
 * Run with `npm run check` (or `node scripts/check.mjs`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'manifest.json');
const PACKAGE_PATH = join(ROOT, 'package.json');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: typeof detail === 'string' ? detail : '' });
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message || String(error) });
  }
}

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${relative(ROOT, path)} is not valid JSON: ${error.message}`);
  }
}

function toPosix(path) {
  return path.split(sep).join('/');
}

function walk(dir, predicate, output = []) {
  if (!existsSync(dir)) return output;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, output);
    else if (predicate(full)) output.push(full);
  }
  return output;
}

const manifest = readJson(MANIFEST_PATH);
const pkg = readJson(PACKAGE_PATH);

/** 1. Manifest basics */
check('manifest: MV3 basics', () => {
  if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
  if (!manifest.name) fail('manifest.name is missing');
  if (!manifest.short_name) fail('manifest.short_name is missing');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) fail('manifest.version is not semver-like');
  if (!manifest.background?.service_worker) fail('background.service_worker is missing');
  if (manifest.background.type !== 'module') fail('background.type must be "module"');
  if (!manifest.action?.default_popup) fail('action.default_popup is missing');
  for (const permission of ['alarms', 'cookies', 'notifications', 'storage']) {
    if (!manifest.permissions?.includes(permission)) fail(`permissions must include "${permission}"`);
  }
  if (!manifest.host_permissions?.some((host) => host.includes('gql.twitch.tv'))) {
    fail('host_permissions must include gql.twitch.tv');
  }
  if (!manifest.content_scripts?.length) fail('content_scripts is empty');
  const worlds = manifest.content_scripts.map((entry) => entry.world || 'ISOLATED');
  if (!worlds.includes('MAIN')) fail('one content script must run in the MAIN world');
  return `${manifest.permissions.length} permissions, ${manifest.content_scripts.length} content scripts`;
});

/** 2. Every manifest-referenced file exists */
check('manifest: referenced files exist', () => {
  const referenced = new Set();
  for (const path of Object.values(manifest.icons || {})) referenced.add(path);
  for (const path of Object.values(manifest.action?.default_icon || {})) referenced.add(path);
  if (manifest.action?.default_popup) referenced.add(manifest.action.default_popup);
  if (manifest.background?.service_worker) referenced.add(manifest.background.service_worker);
  for (const entry of manifest.content_scripts || []) {
    for (const path of entry.js || []) referenced.add(path);
    for (const path of entry.css || []) referenced.add(path);
  }
  for (const group of manifest.web_accessible_resources || []) {
    for (const resource of group.resources || []) {
      if (!resource.includes('*')) referenced.add(resource);
    }
  }
  const missing = [...referenced].filter((path) => !existsSync(join(ROOT, path)));
  if (missing.length) fail(`missing files: ${missing.join(', ')}`);
  return `${referenced.size} files`;
});

/** 3. Icons are valid PNGs with the declared dimensions */
check('icons: PNG signature and dimensions', () => {
  const icons = { ...(manifest.icons || {}), ...(manifest.action?.default_icon || {}) };
  if (Object.keys(icons).length === 0) fail('no icons declared');
  const summaries = [];
  for (const [size, path] of Object.entries(icons)) {
    const full = join(ROOT, path);
    if (!existsSync(full)) fail(`${path} does not exist`);
    const buffer = readFileSync(full);
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
      fail(`${path} is not a PNG (run "npm run icons")`);
    }
    if (buffer.toString('ascii', 12, 16) !== 'IHDR') fail(`${path} has no IHDR chunk`);
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width !== height) fail(`${path} is ${width}x${height}, expected a square icon`);
    if (Number(size) !== width) fail(`${path} is ${width}px but declared as ${size}`);
    const declared = path.match(/(\d+)\.png$/);
    if (!declared || Number(declared[1]) !== width) {
      fail(`${path} does not match its file name`);
    }
    summaries.push(`${width}px`);
  }
  return summaries.join(', ');
});

/** 4. Versions are in sync */
check('versions: package, manifest, constants', () => {
  const constants = readFileSync(join(ROOT, 'src/shared/constants.js'), 'utf8');
  const match = constants.match(/EXTENSION_VERSION\s*=\s*'([^']+)'/);
  if (!match) fail('EXTENSION_VERSION is missing from src/shared/constants.js');
  if (pkg.version !== manifest.version) {
    fail(`package.json ${pkg.version} !== manifest.json ${manifest.version}`);
  }
  if (match[1] !== manifest.version) {
    fail(`EXTENSION_VERSION ${match[1]} !== manifest.json ${manifest.version}`);
  }
  return manifest.version;
});

/** 5. Syntax-check every JS file */
check('syntax: node --check on every JS file', () => {
  const files = [
    ...walk(join(ROOT, 'src'), (file) => file.endsWith('.js')),
    ...walk(join(ROOT, 'scripts'), (file) => /\.m?js$/.test(file)),
    ...walk(join(ROOT, 'test'), (file) => file.endsWith('.mjs')),
  ].sort();
  if (files.length < 10) fail(`only found ${files.length} JS files`);
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failures.push(`${relative(ROOT, file)}: ${(result.stderr || '').trim().split('\n')[0]}`);
    }
  }
  if (failures.length) fail(failures.join('\n'));
  return `${files.length} files`;
});

/** 6. Relative imports resolve to real files */
check('imports: relative specifiers resolve', () => {
  const files = [
    ...walk(join(ROOT, 'src'), (file) => file.endsWith('.js')),
    ...walk(join(ROOT, 'scripts'), (file) => file.endsWith('.mjs')),
    ...walk(join(ROOT, 'test'), (file) => file.endsWith('.mjs')),
  ];
  const failures = [];
  let count = 0;
  const importPattern = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] || match[2];
      if (!specifier || !specifier.startsWith('.')) continue;
      count += 1;
      const target = resolve(dirname(file), specifier);
      if (!existsSync(target)) failures.push(`${relative(ROOT, file)} -> ${specifier}`);
    }
  }
  if (failures.length) fail(`unresolved imports:\n${failures.join('\n')}`);
  return `${count} relative imports`;
});

/** 7. Popup HTML assets resolve */
check('popup: local assets exist', () => {
  const popupPath = join(ROOT, manifest.action.default_popup);
  const html = readFileSync(popupPath, 'utf8');
  const assets = [
    ...html.matchAll(/<script[^>]+src="([^"]+)"/g),
    ...html.matchAll(/<link[^>]+href="([^"]+)"/g),
    ...html.matchAll(/<img[^>]+src="([^"]+)"/g),
  ]
    .map((match) => match[1])
    .filter((src) => !/^(https?:|data:|\/\/)/.test(src));
  const missing = assets.filter((src) => !existsSync(resolve(dirname(popupPath), src)));
  if (missing.length) fail(`missing popup assets: ${missing.join(', ')}`);
  if (!html.includes('id="panel-drops"')) fail('popup is missing the drops panel');
  if (!html.includes('id="panel-points"')) fail('popup is missing the points panel');
  if (!html.includes('id="panel-settings"')) fail('popup is missing the settings panel');
  if (/\son\w+\s*=/.test(html)) fail('inline event handlers are blocked by the MV3 CSP');
  return `${assets.length} assets`;
});

/** 8. No MV3-violating constructs */
check('csp: no eval, no inline scripts', () => {
  const files = walk(join(ROOT, 'src'), (file) => file.endsWith('.js'));
  const failures = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (/\beval\s*\(/.test(source)) failures.push(`${relative(ROOT, file)} uses eval()`);
    if (/\bnew\s+Function\s*\(/.test(source)) failures.push(`${relative(ROOT, file)} uses new Function()`);
    if (/document\.write\s*\(/.test(source)) failures.push(`${relative(ROOT, file)} uses document.write()`);
  }
  if (failures.length) fail(failures.join('\n'));
  return `${files.length} files`;
});

/** 9. chrome.* APIs are covered by manifest permissions */
check('permissions: chrome.* usage is declared', () => {
  const required = {
    alarms: 'alarms',
    cookies: 'cookies',
    notifications: 'notifications',
    storage: 'storage',
  };
  const used = new Map();
  for (const file of walk(join(ROOT, 'src'), (f) => f.endsWith('.js'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/\bchrome\.([a-zA-Z]+)/g)) {
      const api = match[1];
      if (!used.has(api)) used.set(api, new Set());
      used.get(api).add(toPosix(relative(ROOT, file)));
    }
  }
  const missing = [];
  for (const [api, permission] of Object.entries(required)) {
    if (used.has(api) && !manifest.permissions.includes(permission)) {
      missing.push(`chrome.${api} needs "${permission}" (used in ${[...used.get(api)].join(', ')})`);
    }
  }
  if (missing.length) fail(missing.join('\n'));
  return [...used.keys()].sort().join(', ');
});

/** 10. Persisted hashes look sane */
check('gql: persisted hashes are 64 hex chars', () => {
  const constants = readFileSync(join(ROOT, 'src/shared/constants.js'), 'utf8');
  const hashes = [...constants.matchAll(/:\s*'([a-f0-9]{20,})'/g)].map((match) => match[1]);
  if (hashes.length < 8) fail(`expected at least 8 hashes, found ${hashes.length}`);
  const bad = hashes.filter((hash) => !/^[a-f0-9]{64}$/.test(hash));
  if (bad.length) fail(`invalid hashes: ${bad.join(', ')}`);
  return `${hashes.length} hashes`;
});

/** 11. README is present and explains the install */
check('docs: README', () => {
  const readme = join(ROOT, 'README.md');
  if (!existsSync(readme)) fail('README.md is missing');
  const text = readFileSync(readme, 'utf8');
  for (const needle of ['TwitchAutoPilot', 'chrome://extensions', 'npm test']) {
    if (!text.includes(needle)) fail(`README.md does not mention "${needle}"`);
  }
  return `${text.split('\n').length} lines`;
});

/** 12. Background playback guard is wired into both worlds */
check('guard: background playback wiring', () => {
  const guardPath = join(ROOT, 'src/content/visibility-guard.js');
  if (!existsSync(guardPath)) fail('src/content/visibility-guard.js is missing');
  const main = (manifest.content_scripts || []).find((entry) => entry.world === 'MAIN');
  if (!main) fail('no MAIN-world content script');
  if (main.run_at !== 'document_start') fail('the MAIN-world script must run at document_start');
  if (main.js?.[0] !== 'src/content/visibility-guard.js') {
    fail('visibility-guard.js must be the first MAIN-world script (before page-bridge.js)');
  }
  const guard = readFileSync(guardPath, 'utf8');
  const content = readFileSync(join(ROOT, 'src/content/content.js'), 'utf8');
  const worker = readFileSync(join(ROOT, 'src/background/service-worker.js'), 'utf8');
  const farm = readFileSync(join(ROOT, 'src/background/farm.js'), 'utf8');
  for (const needle of ['__twitchautopilot_guard_event__', 'visibilitychange', 'documentProto']) {
    if (!guard.includes(needle)) fail(`visibility-guard.js does not use ${needle}`);
  }
  if (!content.includes("__twitchautopilot_guard_event__")) fail('content.js does not dispatch guard config');
  if (!worker.includes('GET_GUARD')) fail('service-worker.js does not answer GET_GUARD');
  if (!content.includes('GET_GUARD')) fail('content.js does not request GET_GUARD');
  if (!farm.includes('FARM_STATUS')) fail('farm.js does not read FARM_STATUS');
  if (!farm.includes('FARM_RESUME')) fail('farm.js does not send FARM_RESUME');
  return 'guard first in MAIN, 3 messages';
});

/** 13. License matches the project terms */
check('license: source-available, restricted', () => {
  const path = join(ROOT, 'LICENSE');
  if (!existsSync(path)) fail('LICENSE is missing');
  const text = readFileSync(path, 'utf8');
  if (!text.startsWith('TwitchAutoPilot License')) fail('LICENSE must be the TwitchAutoPilot License');
  for (const needle of ['All rights reserved', '@Karpenator', 'modify, adapt, translate', 'sell, resell']) {
    if (!text.includes(needle)) fail(`LICENSE does not contain "${needle}"`);
  }
  const pkg = readJson(PACKAGE_PATH);
  if (!String(pkg.license || '').includes('LICENSE')) {
    fail('package.json license must reference the LICENSE file');
  }
  return 'modification and sale reserved to @Karpenator';
});

/** 14. Tests exist */
check('tests: test files present', () => {
  const files = walk(join(ROOT, 'test'), (file) => file.endsWith('.test.mjs'));
  if (files.length < 5) fail(`expected at least 5 test files, found ${files.length}`);
  return `${files.length} files`;
});

for (const result of results) {
  const label = result.ok ? 'ok  ' : 'FAIL';
  console.log(`${label} ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
}

const failed = results.filter((result) => !result.ok);
console.log('');
if (failed.length) {
  console.error(`✗ ${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`✓ all ${results.length} checks passed`);
