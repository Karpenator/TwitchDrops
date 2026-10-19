#!/usr/bin/env node
/**
 * Build a Chrome Web Store ready zip without any external dependencies.
 *
 *   npm run package
 *   -> dist/twitchautopilot-<version>.zip
 *
 * The archive contains what Chrome needs at runtime (manifest.json and src/**)
 * plus the LICENSE, as the license requires. Tests, demo pages and build
 * scripts stay out of the package.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time, clamped to the valid ZIP range (1980-2107). */
function dosDateTime(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function listFiles(dir, base = dir, output = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === 'Thumbs.db') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, output);
    else if (entry.isFile()) output.push(full);
  }
  return output;
}

function toArchivePath(file, base) {
  return relative(base, file).split(sep).join('/');
}

/**
 * Minimal ZIP writer: deflate each entry, then a central directory.
 * Chrome only needs standard DEFLATE + CRC32, so no third-party zip library.
 */
function createZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  const now = new Date();

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = readFileSync(file.path);
    const compressed = deflateRawSync(data, { level: 9 });
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(data);
    const { dosTime, dosDate } = dosDateTime(now);
    const flags = 0x0800; // UTF-8 file names

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localChunks.push(local, name, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralChunks.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centralChunks);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralBuffer, end]);
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const files = [
  { path: join(ROOT, 'manifest.json'), name: 'manifest.json' },
  { path: join(ROOT, 'LICENSE'), name: 'LICENSE' },
  ...listFiles(join(ROOT, 'src')).map((path) => ({
    path,
    name: toArchivePath(path, ROOT),
  })),
];

const missing = files.filter((file) => {
  try {
    return !statSync(file.path).isFile();
  } catch {
    return true;
  }
});
if (missing.length) {
  console.error(`✗ missing files: ${missing.map((file) => file.name).join(', ')}`);
  process.exit(1);
}

const zip = createZip(files);
const outputPath = join(DIST, `twitchautopilot-${version}.zip`);
mkdirSync(DIST, { recursive: true });
writeFileSync(outputPath, zip);

const kilobytes = (zip.length / 1024).toFixed(1);
console.log(`✓ packed ${files.length} files into dist/${relative(DIST, outputPath)} (${kilobytes} KiB)`);
for (const file of files) console.log(`  · ${file.name}`);
