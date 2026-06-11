# ClearPath clutter proxy (Cloudflare Worker)

Adds CORS + forwards HTTP Range requests to the public Meta/WRI canopy-height
COGs on AWS S3, so ClearPath can read canopy heights in the browser with
`geotiff.js`. Replaces the GFW tile server (titiler), which is currently down.

The underlying data is a public AWS Open Data bucket
(`dataforgood-fb-data`); this Worker only proxies `/chm/<quadkey>.tif`.

## Deploy (Cloudflare dashboard — no tooling)

1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**.
2. Name it e.g. `clearpath-clutter`. Deploy the default, then **Edit code**.
3. Paste the contents of [`clutter-proxy.js`](clutter-proxy.js), **Save and deploy**.
4. Note the URL, e.g. `https://clearpath-clutter.<your-subdomain>.workers.dev`.
   - Optional: add a custom route like `https://clutter.nbird.com.au/*` under
     the worker's **Settings → Triggers → Custom Domains/Routes**.

## Deploy (wrangler CLI — optional)

```bash
npm i -g wrangler
wrangler login
# from cloudflare-worker/:
wrangler deploy clutter-proxy.js --name clearpath-clutter --compatibility-date 2024-01-01
```

## Verify

A Range request should return **206** with `Access-Control-Allow-Origin: *`
and the TIFF magic bytes (`II*\0` for little-endian):

```bash
curl -sD - -o /dev/null -H "Range: bytes=0-3" \
  https://<your-worker-url>/chm/311211222.tif
# expect: HTTP/2 206, access-control-allow-origin: *, content-range: bytes 0-3/...
```

## Wire into ClearPath

Once deployed, send the Worker URL to set `CANOPY_PROXY_BASE` in `app.js`, add
the origin to the `connect-src` CSP in `index.html`, and flip
`CANOPY_ENABLED = true`.
