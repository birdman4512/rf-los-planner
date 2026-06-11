// ─────────────────────────────────────────────────────────────────────────
//  ClearPath clutter proxy — Cloudflare Worker
//
//  Adds CORS headers and forwards HTTP Range requests to the public Meta/WRI
//  canopy-height Cloud-Optimised GeoTIFFs on AWS S3, so the browser
//  (geotiff.js) can do windowed reads directly. This replaces the GFW tile
//  server (titiler), which is down.
//
//  Only /chm/<quadkey>.tif is proxied — a public, read-only open-data bucket —
//  so this is not a general open proxy. Deploy: see README.md.
// ─────────────────────────────────────────────────────────────────────────

const S3_BASE = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float';
const PATH_RE = /^\/chm\/\d+\.tif$/;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',          // public open data; restrict to your origin if preferred
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS')
      return new Response(null, { headers: corsHeaders() });

    const { pathname } = new URL(request.url);
    if (!PATH_RE.test(pathname))
      return new Response('Not found', { status: 404, headers: corsHeaders() });
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });

    const fwd = new Headers();
    const range = request.headers.get('Range');
    if (range) fwd.set('Range', range);

    // NOTE: do NOT set cf.cacheEverything — it makes Cloudflare strip the Range
    // header and return the full ~730 MB object (200) instead of a 206 slice.
    const upstream = await fetch(S3_BASE + pathname, {
      method: request.method,
      headers: fwd,
    });

    const headers = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders())) headers.set(k, v);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
};
