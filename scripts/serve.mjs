// Minimal zero-dependency static file server for local + CI test runs.
// Serves the repo root so the planner is reachable over http:// (matching how
// GitHub Pages serves it), which keeps the Content-Security-Policy behaviour
// realistic. Usage: node scripts/serve.mjs [port]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const port = Number(process.argv[2]) || 8080;
const root = resolve(process.cwd());

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    if (pathname === '/') pathname = '/index.html';
    // Containment check: resolve the requested path against root and refuse
    // anything that escapes it (more robust than stripping ../ prefixes).
    const filePath = resolve(root, '.' + pathname);
    if (filePath !== root && !filePath.startsWith(root + sep)) throw new Error('outside root');
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
