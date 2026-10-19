#!/usr/bin/env node
/**
 * Tiny zero-dependency static server for the interactive popup demo.
 *
 *   npm run preview   -> http://localhost:4173/preview/
 *
 * It serves the repository as-is so the demo can load the real popup CSS, JS
 * and icons. No Twitch requests are made by the demo.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function resolveRequestPath(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://preview.local').pathname);
  } catch {
    return null;
  }
  if (pathname === '/' || pathname === '') pathname = '/preview/';
  if (pathname.endsWith('/')) pathname += 'index.html';
  const filePath = normalize(join(ROOT, pathname));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) return null;
  return filePath;
}

const server = createServer((req, res) => {
  const started = Date.now();
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    send(res, 405, 'Method not allowed');
    return;
  }

  const filePath = resolveRequestPath(req.url || '/');
  if (!filePath) {
    send(res, 400, 'Bad request');
    console.log(`${method} ${req.url} → 400`);
    return;
  }

  let fileStat;
  try {
    fileStat = statSync(filePath);
  } catch {
    send(res, 404, 'Not found', 'text/html; charset=utf-8');
    console.log(`${method} ${req.url} → 404`);
    return;
  }

  if (!fileStat.isFile()) {
    send(res, 404, 'Not found');
    console.log(`${method} ${req.url} → 404 (not a file)`);
    return;
  }

  const type = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': fileStat.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // Deliberately no X-Frame-Options / frame-ancestors: the demo is embedded
    // in the Arena preview iframe.
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    res.destroy();
  });
  stream.pipe(res);
  res.on('finish', () => {
    console.log(`${method} ${req.url} → 200 ${type.split(';')[0]} ${Date.now() - started}ms`);
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`✗ port ${PORT} is already in use (set PORT to another value)`);
  } else {
    console.error('✗ preview server failed:', error.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const demoPath = join(ROOT, 'preview', 'index.html');
  const suffix = existsSync(demoPath) ? '' : ' (preview/index.html is missing!)';
  console.log(`TwitchAutoPilot preview: http://localhost:${PORT}/preview/${suffix}`);
  console.log(`Serving ${ROOT} on ${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
