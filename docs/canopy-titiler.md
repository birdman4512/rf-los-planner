# Canopy via a self-hosted titiler

ClearPath can refine tree clutter with Meta/WRI canopy-height COGs. The source
tiles are 1 m and huge, so browser `geotiff.js` reads are acceptable for a few
link grazing points but are too slow/noisy for dense coverage sweeps.

The smooth path is:

1. Pre-build the few source tiles you need as local COGs with overviews.
2. Serve only those local COGs through a narrow `/canopy/...` proxy.
3. Let ClearPath fall back to the existing browser geotiff path when a local COG
   is not present.

The deployable files live in [`docs/canopy-titiler/`](canopy-titiler/):

- `Dockerfile` builds the titiler image.
- `docker-compose.yml` runs titiler, the restricted Nginx proxy, and cloudflared.
- `nginx.conf` exposes only `/canopy/<quadkey>/bbox/.../*.png` and
  `/canopy/manifest.json`; it does not expose titiler's generic `/cog?url=`.
- `scripts/build-cog.sh` downloads one Meta/WRI source tile and rebuilds it as a
  local COG with overviews.
- `scripts/refresh-manifest.sh` writes `cogs/manifest.json` for the app.
- `scripts/check-updates.sh` compares local tile metadata with the upstream S3
  headers.

## Recommended Network Shape

Keep the VM closed to inbound traffic and use a Cloudflare Tunnel:

```txt
ClearPath browser
  -> https://titiler.nbird.com.au/canopy/...
  -> Cloudflare Tunnel
  -> canopy-proxy:8080
  -> titiler:8000, using /cogs/<quadkey>.cog.tif only
```

This closes the open proxy issue because the public service never accepts an
arbitrary `url=` parameter. It also avoids public firewall rules, public VM ports,
and TLS certificate management.

Direct internet exposure can work, but it is not easier overall: you would need
to expose only the Nginx proxy, add TLS, keep ports/firewall tight, and never
publish titiler's `8000` port. If you do expose the VM directly, put Caddy/Nginx
with HTTPS in front of `canopy-proxy:8080`; do not expose titiler itself.

## VM Setup

On the VM:

```sh
mkdir -p ~/titiler
```

Copy the contents of `docs/canopy-titiler/` from this repo to `~/titiler/`.
Then:

```sh
cd ~/titiler
cp .env.example .env
chmod +x scripts/*.sh
mkdir -p cogs
```

Put your Cloudflare Tunnel token in `.env`:

```txt
TUNNEL_TOKEN=eyJ...your-token...
```

In the Cloudflare Tunnel public hostname settings, point
`titiler.nbird.com.au` to:

```txt
http://canopy-proxy:8080
```

Then start the stack:

```sh
docker compose up -d --build
docker compose logs -f cloudflared
```

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
https://titiler.nbird.com.au/canopy/311213001/bbox/152.77,-27.22,153.08,-27.06/751x451.png
```

If the tile is missing, ClearPath skips titiler and falls back to the existing
geotiff Worker path. That avoids user-visible 500s from probing missing local
files.

## Verify

Health check:

```sh
curl -i https://titiler.nbird.com.au/healthz
```

Manifest:

```sh
curl https://titiler.nbird.com.au/canopy/manifest.json
```

Tile render:

```sh
curl -L -o test.png \
  "https://titiler.nbird.com.au/canopy/311213001/bbox/152.77568137888179,-27.220726676248653,153.07837262111823,-27.059125784374057/751x451.png"
```

The old titiler URL should not be exposed publicly:

```sh
curl -i "https://titiler.nbird.com.au/cog/info?url=https://example.com/test.tif"
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
the fast path predictable; the browser geotiff fallback remains the safety net.
