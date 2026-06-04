// Minimal zero-dependency static file server for local + CI test runs.
// Serves the repo root so the planner is reachable over http:// (matching how
// GitHub Pages serves it), which keeps the Content-Security-Policy behaviour
// realistic. Usage: node scripts/serve.mjs [port]

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const port = Number(process.argv[2]) || 8080;
const root = process.cwd();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent((req.url || '/').split('?')[0]);
    if (pathname === '/') pathname = '/index.html';
    // Strip any leading ../ to keep the server inside root.
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = join(root, safe);
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': TYPES[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}`));
