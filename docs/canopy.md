# Measured canopy (no server)

ClearPath refines tree clutter with Meta/WRI canopy-height data. The source tiles
are 1 m, 65536² and have no usable overviews, so a GitHub Actions workflow
rebuilds each one into a small, peak-preserving Cloud-Optimised GeoTIFF on
**Cloudflare R2**. The browser reads only the bytes it needs from those files
with HTTP Range requests ([`js/canopy-cog.js`](../js/canopy-cog.js)). Nothing
runs on a server. Where a tile isn't published, ClearPath falls back to the flat
WorldCover Forest(m) height.

```txt
Actions: "Build canopy tiles"
  download Meta/WRI source → gdalwarp max-downsample → COG with RMS overviews
  → R2: tiles/<qk>/<stamp>.tif, meta/<qk>.json, manifest.json, CORS policy
ClearPath browser
  → https://canopy.nbird.com.au/manifest.json        (revalidated ≤ once a minute)
  → https://canopy.nbird.com.au/tiles/<qk>/<stamp>.tif   (Range reads, immutable)
```

## One-time setup

1. **Create the bucket.** Cloudflare dashboard → R2 → *Create bucket*, e.g.
   `clearpath-canopy`. The free tier includes 10 GB of storage and no egress fees.
2. **Give it a public hostname.** Bucket → *Settings* → *Custom Domains* →
   *Connect Domain* → `canopy.nbird.com.au`. This needs the zone on Cloudflare,
   which it already is. Use a custom domain rather than the `r2.dev` URL:
   `r2.dev` is rate-limited and isn't cached by Cloudflare's CDN. If you choose
   another hostname, change `CANOPY_BASE` in `js/app.js` and the `connect-src`
   entry in `index.html`'s Content-Security-Policy.
3. **Create an Account API token.** R2 → *Manage API tokens* → *Create Account API token* with
   *Object Read & Write*, scoped to that bucket. Note the access key ID, the
   secret, and your account ID.
4. **Add them to the repo.** Settings → Secrets and variables → Actions:
   - Secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
   - Variables: `R2_BUCKET` (the bucket name). Optionally set `CANOPY_ORIGINS`
     (comma-separated). It defaults to `https://dea.nbird.com.au`. Local `npm run serve`
     is deliberately not allowed, so local runs use flat Forest(m).

5. **Set CORS once.** Bucket → *Settings* → *CORS Policy* → *Edit*:

   ```json
   [{"AllowedOrigins": ["https://dea.nbird.com.au"],
     "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": ["Range"],
     "ExposeHeaders": ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"],
     "MaxAgeSeconds": 86400}]
   ```

   The workflow also tries to apply this on every run. A bucket-scoped "Object
   Read & Write" token isn't allowed to, so that step just warns and the
   dashboard policy stays in place.

## Staying inside the free tier

R2's free tier is 10 GB-month of Standard storage, 1 M Class A (write) and
10 M Class B (read) operations a month, with free egress.

- **Storage is the only limit that matters.** Measured on a dense-forest tile
  (618 MB source), the build is 87 MB at factor 4 and 29 MB at factor 8. The 32
  original tiles (17.9 GB of source) come to about **2.5 GB** at factor 4, or
  **0.8 GB** at factor 8. Budget roughly 90 MB per forested tile at factor 4.
- **The workflow enforces a budget**, `CANOPY_BUDGET_GB` (default 9). Before
  building, it estimates the peak (bucket now + new builds; replaced versions
  are pruned only at the end) and refuses if that's over budget. It checks the
  real total again before every upload. Each run's summary shows the bucket size.
- **Reads:** tiles are `immutable` on the custom domain, so repeat reads come
  from Cloudflare's cache and don't count as R2 operations. Uncached, a coverage
  sweep is tens to a couple of hundred reads, far below 10 M a month.
- **Keep the bucket on Standard storage** (the default). Infrequent Access has
  no free tier.
- **As a backstop, set a billing alert:** Billing → Budget alerts, with a $1
  threshold. Alerts only notify (they arrive a day late and don't cap spend),
  but past the free tier, storage costs only $0.015/GB-month.

## Building tiles

Actions → **Build canopy tiles** → *Run workflow*:

- **tiles**: quadkeys separated by spaces or commas, for example the ones
  ClearPath logs as `Canopy: tile 311213001 not published`. Use `all` to
  rebuild every published tile.
- **factor**: `4` by default (see below).

Each tile is built in its own job, with up to 8 running in parallel. A final
job then:
- rewrites `manifest.json` from every `meta/<qk>.json`
- applies the CORS policy
- deletes tile objects that no manifest entry references

Tiles that failed don't block the ones that succeeded.

To build locally instead, run `sh scripts/canopy/build-tile.sh <qk> out`. It
uses Docker GDAL unless `gdalwarp` is on PATH.

### How a tile is built (and why)

The source is uint8 whole metres on a ~1.19 m Web Mercator grid, with no
nodata value (0 means no canopy).

- **`gdalwarp -r max`, factor 4 by default.** Each output cell is the tallest
  of 4×4 source pixels, giving ~4.8 m Mercator cells (~4.3 m ground at 27°S).
  Tree tops are what obstruct a ray, so they're kept instead of averaged into
  gaps. Use `2` for finer cells or `8` for smaller files.
- **`OVERVIEW_RESAMPLING=RMS`.** The browser reads coarser overviews for long
  coverage sweeps. GDAL's default (cubic) would smooth peaks away at those
  levels; RMS leans toward tall pixels.
- **Byte, DEFLATE + predictor 2, 512 px tiles.** This keeps exact metres and
  matches what the reader decodes.
- **Every build gets a new object key** (`tiles/<qk>/<UTC stamp>.tif`), so
  each URL's bytes never change. Tiles are served with
  `Cache-Control: immutable`, so browsers and the CDN cache them indefinitely.

`meta/<qk>.json`, mirrored in the manifest, records the source URL, ETag and
Last-Modified time, the build, the cell size, the GDAL version and the size.
Meta/WRI's v1 data hasn't changed since April 2024. If it does, run the
workflow with `all`. If they publish a new dataset path, set `SOURCE_PREFIX` in
the build step.

## How the browser reads it

`CanopyCOG.sampler(url, bbox, stepM)`:

- Fetches the first 64 KB of the file, which holds every IFD and tile index in
  a GDAL COG.
- Picks the **coarsest overview whose ground pixel is no larger than the
  sampling step**: ~8.5 m for links, ~17 m for 20 m coverage sweeps. It goes
  coarser only if more than 192 tiles would be needed.
- Reads only the tiles under the bbox. Adjacent byte ranges merge into one
  request, with at most 6 requests in flight in total.
- Decodes with the browser's built-in `DecompressionStream`. No library is
  needed, so there's no CSP change for scripts.
- Keeps decoded tiles in memory, and keeps the raw header and tile bytes in the
  Cache API (`clearpath-canopy-v1`). Revisiting an area costs no network at all.

If any tile touched by an area is missing or fails, the whole area uses the
flat Forest(m) height. That avoids a result that is half measured and half
guessed. A store that can't be reached is retried after 90 s.

## Verify

```sh
curl -s https://canopy.nbird.com.au/manifest.json | jq '.tiles | length'
# A Range read should return 206 and exactly one allow-origin header:
curl -sI -H "Origin: https://dea.nbird.com.au" -H "Range: bytes=0-15" \
  "https://canopy.nbird.com.au/$(curl -s https://canopy.nbird.com.au/manifest.json | jq -r '[.tiles[]][0].path')" \
  | grep -iE "^HTTP|access-control-allow-origin|content-range"
```
