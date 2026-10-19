/*
 * Dependency-free icon renderer + PNG encoder.
 *
 * The artwork mirrors src/icons/icon.svg. Rendering it here keeps the build
 * reproducible without ImageMagick/librsvg on the machine.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'src/icons');

const BASE = 512;
const SS = 4; // samples per axis

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function hex(value) {
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

const C = {
  gradA: hex('#a163ff'),
  gradB: hex('#7a2fff'),
  gradC: hex('#43119a'),
  border: hex('#d8c2ff'),
  dropTop: hex('#ffffff'),
  dropBottom: hex('#e9dcff'),
  check: hex('#6d24e8'),
  green: hex('#43e08d'),
};

function roundedRectContains(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  if (x >= x0 + r && x <= x1 - r) return true;
  if (y >= y0 + r && y <= y1 - r) return true;
  const cx = x < x0 + r ? x0 + r : x1 - r;
  const cy = y < y0 + r ? y0 + r : y1 - r;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}

function buildDropPolygon() {
  const points = [];
  const leftStart = [256, 92];
  const leftC1 = [214, 154];
  const leftC2 = [158, 218];
  const leftEnd = [158, 294];
  for (let i = 0; i <= 40; i += 1) {
    points.push(cubic(leftStart, leftC1, leftC2, leftEnd, i / 40));
  }
  const center = [256, 294];
  const radius = 98;
  for (let i = 1; i <= 48; i += 1) {
    const angle = Math.PI - (Math.PI * i) / 48; // left → bottom → right
    points.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
  }
  const rightStart = [354, 294];
  const rightC1 = [354, 218];
  const rightC2 = [298, 154];
  const rightEnd = [256, 92];
  for (let i = 1; i <= 40; i += 1) {
    points.push(cubic(rightStart, rightC1, rightC2, rightEnd, i / 40));
  }
  return points;
}

const DROP = buildDropPolygon();

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / lengthSq, 0, 1);
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

const CHECK_POINTS = [
  [207, 294],
  [242, 329],
  [312, 249],
];

function onCheckStroke(x, y) {
  for (let i = 0; i < CHECK_POINTS.length - 1; i += 1) {
    const a = CHECK_POINTS[i];
    const b = CHECK_POINTS[i + 1];
    if (distanceToSegment(x, y, a[0], a[1], b[0], b[1]) <= 15) return true;
  }
  return false;
}

function sampleColor(x, y) {
  // Coordinates are in the 512x512 design space.
  if (!roundedRectContains(x, y, 18, 18, 494, 494, 116)) return [0, 0, 0, 0];

  const t = clamp((x + y) / (2 * BASE), 0, 1);
  let color = t < 0.55 ? mix(C.gradA, C.gradB, t / 0.55) : mix(C.gradB, C.gradC, (t - 0.55) / 0.45);
  let alpha = 1;

  if (
    roundedRectContains(x, y, 18, 18, 494, 494, 116) &&
    !roundedRectContains(x, y, 26, 26, 486, 486, 108)
  ) {
    color = mix(color, C.border, 0.3);
  }

  // Green "ready" dot.
  if ((x - 390) ** 2 + (y - 120) ** 2 <= 44 * 44) {
    color = mix(color, C.green, 0.9);
  }

  if (pointInPolygon(x, y, DROP)) {
    const dy = clamp((y - 92) / 300, 0, 1);
    color = mix(C.dropTop, C.dropBottom, dy);
  }

  if (onCheckStroke(x, y)) {
    color = C.check.slice();
  }

  return [color[0], color[1], color[2], alpha];
}

function render(size) {
  const scale = BASE / size;
  const pixels = new Uint8Array(size * size * 4);
  const samples = SS * SS;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = (x + (sx + 0.5) / SS) * scale;
          const py = (y + (sy + 0.5) / SS) * scale;
          const [cr, cg, cb, ca] = sampleColor(px, py);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const index = (y * size + x) * 4;
      if (a > 0) {
        pixels[index] = Math.round(r / a);
        pixels[index + 1] = Math.round(g / a);
        pixels[index + 2] = Math.round(b / a);
        pixels[index + 3] = Math.round((a / samples) * 255);
      }
    }
  }
  return pixels;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(size, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const pixels = render(size);
  const png = encodePng(size, pixels);
  const path = resolve(OUT_DIR, `icon${size}.png`);
  writeFileSync(path, png);
  console.log(`wrote ${path} (${png.length} bytes)`);
}
