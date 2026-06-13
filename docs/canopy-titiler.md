# Canopy via a self-hosted titiler

ClearPath refines tree clutter with Meta/WRI canopy-height COGs. The source tiles
are 1 m and huge with no usable overviews, so they are read **server-side** by a
self-hosted titiler that returns a small downsampled PNG per tile. Where a tile
isn't served, ClearPath falls back to the flat WorldCover Forest(m) value.

The smooth path is:

1. Pre-build the few source tiles you need as local COGs with overviews.
2. Serve only those local COGs through a narrow `/canopy/...` proxy.
3. ClearPath uses the flat WorldCover Forest(m) value for any tile not built.

The deployable files live in [`docs/canopy-titiler/`](canopy-titiler/):

- `Dockerfile` builds the titiler image.
- `docker-compose.yml` runs titiler and the restricted Nginx proxy.
- `nginx.conf` exposes only `/canopy/<quadkey>/bbox/.../*.png` and
  `/canopy/manifest.json`; it does not expose titiler's generic `/cog?url=`, and
  it is the single source of CORS for the stack.
- `scripts/build-cog.sh` downloads one Meta/WRI source tile and rebuilds it as a
  local COG with overviews.
- `scripts/refresh-manifest.sh` writes `cogs/manifest.json` for the app.
- `scripts/check-updates.sh` compares local tile metadata with the upstream S3
  headers.

## Network Shape

The stack is self-contained and publishes the canopy API on **host port 8090**.
Front it with any TLS reverse proxy (nginx, Caddy, Traefik, …) on a public
hostname. That reverse proxy is independent of this stack — it only forwards the
`/canopy/` path through unchanged and adds nothing:

```txt
ClearPath browser
  -> https://<your-host>/canopy/...
  -> your TLS reverse proxy   (forward /canopy/* → host:8090; add NO CORS)
  -> host port 8090
  -> canopy-proxy:8080 in Docker   (path restriction + CORS + rewrite)
  -> titiler:8000, using /cogs/<quadkey>.cog.tif only
```

This closes the open-proxy issue because the public service never accepts an
arbitrary `url=` parameter. CORS is set once, **inside** the stack (the canopy
proxy), so your reverse proxy must **not** add its own `Access-Control-*`
headers — a duplicated header makes the browser reject the response.

## VM Setup

On the VM:

```sh
mkdir -p ~/titiler
```

Copy the contents of `docs/canopy-titiler/` from this repo to `~/titiler/`.
Then:

```sh
cd ~/titiler
chmod +x scripts/*.sh
mkdir -p cogs
```

Then start the stack:

```sh
docker compose up -d --build
docker compose ps
```

The host publishes the canopy proxy on `8090`, not `8080`, to avoid clashing
with other services. If your reverse proxy also runs in Docker, it cannot
reliably reach a port bound only to `127.0.0.1`, so the stack publishes
`8090:8080`.

### Front it with your TLS reverse proxy

Point your existing public reverse proxy at the stack on `host:8090`, forwarding
the `/canopy/` path **unchanged** (the inner Nginx matches on the `/canopy/`
prefix) and adding **no** headers of its own. A Caddy site, for example, needs
only a plain pass-through:

```caddy
handle /canopy/* {
    reverse_proxy host.docker.internal:8090
}

handle /canopy {
    redir /canopy/ 308
}
```

> **Do not add `Access-Control-*` headers at the reverse proxy.** CORS is set
> once, inside the stack (`nginx.conf` → `set $cors_origin`). A second copy makes
> the browser reject the doubled header. No OPTIONS/preflight handling is needed
> either — ClearPath only makes simple requests (`<img crossorigin>` + a plain
> `fetch`), which never trigger a preflight. To change the allowed browser
> origin, edit `set $cors_origin` in `nginx.conf`, not the reverse proxy.

## Build Local Canopy Tiles

When ClearPath logs a missing tile such as `311213001`, build it on the VM:

```sh
cd ~/titiler
./scripts/build-cog.sh 311213001
```

That creates:

```txt
cogs/311213001.cog.tif
cogs/311213001.meta
cogs/manifest.json
```

ClearPath fetches `manifest.json` first. If the tile is listed, it requests:

```txt
https://tracker.quirkyit.com.au/canopy/311213001/bbox/152.77,-27.22,153.08,-27.06/751x451.png
```

If the tile isn't built, ClearPath uses the flat WorldCover Forest(m) value for
that area instead. It checks the manifest first, so it never probes missing
local files (no user-visible 500s).

## Render Tuning

The proxy's `rewrite` in `nginx.conf` fixes how each tile is rendered:

```txt
rescale=0,40&colormap_name=gray&return_mask=true&resampling=rms
```

- **`rescale=0,40`** — gray 0–255 maps to 0–40 m. **This ceiling MUST equal
  `CANOPY_HMAX` in `app.js`** (currently `40`). They are the encode/decode ends of
  the same 8-bit value; changing one without the other misreads every canopy
  height by the ratio of the two. The `<img>`/canvas decode is 8-bit, so a lower
  ceiling is the only browser-side precision lever — keep it just above the local
  maximum canopy height.
- **`resampling=rms`** — downsamples each output cell toward its tall pixels
  (`rms >= mean`), so peaks aren't averaged away. Only the decimation set is valid
  here (`nearest`/`bilinear`/`cubic`/`cubic_spline`/`lanczos`/`average`/`mode`/
  `gauss`/`rms`); `max`/`min`/`med`/`q1`/`q3` are **warp-only** and return **422**.
  Fall back to `bilinear` if `rms` ever 422s.

These render parameters apply at read time — **no COG rebuild is needed**. After
editing `nginx.conf`, reload the proxy:

```sh
cd ~/titiler
docker compose exec canopy-proxy nginx -s reload
```

## Verify

Host-local health check:

```sh
curl -i http://127.0.0.1:8090/healthz
```

Public health check (through your reverse proxy):

```sh
curl -i https://tracker.quirkyit.com.au/canopy/healthz
```

Manifest:

```sh
curl https://tracker.quirkyit.com.au/canopy/manifest.json
```

Tile render:

```sh
curl -L -o test.png \
  "https://tracker.quirkyit.com.au/canopy/311213001/bbox/152.77568137888179,-27.220726676248653,153.07837262111823,-27.059125784374057/751x451.png"
```

CORS — expect **exactly one** `access-control-allow-origin` line:

```sh
curl -sI -H "Origin: https://dea.nbird.com.au" \
  "https://tracker.quirkyit.com.au/canopy/manifest.json" | grep -i access-control
```

The old titiler URL should not be exposed publicly:

```sh
curl -i "https://tracker.quirkyit.com.au/cog/info?url=https://example.com/test.tif"
```

Expected result: `404`.

## Updates

The local COGs are a cache of a specific upstream Meta/WRI dataset path:

```txt
https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/
```

Each `build-cog.sh` run records the upstream `ETag` and `Last-Modified` headers
in `cogs/<tile>.meta`. To audit for source updates:

```sh
cd ~/titiler
./scripts/check-updates.sh
```

If a tile reports changed metadata, rebuild it:

```sh
./scripts/build-cog.sh <tile>
```

If Meta/WRI publish a new dataset version under a different path, update
`SOURCE_PREFIX` when running the scripts, rebuild the tiles you care about, and
restart the stack if needed:

```sh
SOURCE_PREFIX="https://.../new/path/chm" ./scripts/build-cog.sh 311213001
```

## Why Not Raw S3 In The Live App?

The raw source tiles are valid GeoTIFFs, but they are huge and do not have useful
overviews for this workflow. Rendering a bbox PNG from raw S3 through titiler can
hang a small VM for long enough to feel broken. Local COGs with overviews make
the fast path predictable; the flat WorldCover Forest(m) value is the fallback
for any area whose tile hasn't been built.
