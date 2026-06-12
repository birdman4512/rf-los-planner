# Canopy via a self-hosted titiler

ClearPath reads per-pixel Meta/WRI canopy heights, but the source COGs are 1 m
with **no overviews** (65536² px), so the browser can only read them at full
resolution. That's fine for **links** (a few grazing points) but caps out for
**coverage in dense forest** (tens of thousands of grazing points — see the
`CANOPY_MAX_POINTS` cap in `app.js`).

A **titiler** fixes this: it reads the COGs server-side (GDAL `/vsicurl/`) and
returns a small **downsampled** image for any bbox — so dense-forest coverage
canopy becomes one fast fetch, like the old (now-dead) GFW tile server.

> ⚠️ Because the COGs have **no overviews**, *any* server still has to read the
> full-resolution pixels to downsample a large bbox. The win is that it happens
> server-side (more RAM/CPU, near the data) and only a small image crosses the
> wire. To make it genuinely fast — especially on a tiny VM — **pre-build
> overviews on the few tiles covering your sites** (see "Make it fast" below).

---

## Option 1 — Local VM (e.g. Alpine, small specs)  ⭐ simplest, can't be billed

A local VM is ideal: it's your hardware (no cloud bill, ever), and it only needs
to be **on while you're planning** — when it's off, ClearPath just falls back to
flat Forest(m). Small specs are fine: **1 vCPU / 1 GB RAM** is comfortable (512 MB
works if you keep `GDAL_CACHEMAX` low).

**Run titiler in Docker, even on Alpine.** Don't install the Python geo stack on
Alpine directly — rasterio/GDAL have no musl wheels and fight Alpine's libc. Just
run the Debian-based container; the Alpine host only runs the Docker daemon:

```sh
apk add docker
rc-update add docker boot && service docker start
```

Build + run titiler (same image as everywhere else):

```sh
mkdir -p ~/titiler && cd ~/titiler
cat > Dockerfile <<'EOF'
FROM ghcr.io/osgeo/gdal:ubuntu-small-latest
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip \
 && pip install --no-cache-dir --break-system-packages titiler.application uvicorn \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
ENV CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif \
    GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
    GDAL_HTTP_MULTIPLEX=YES \
    GDAL_CACHEMAX=256 \
    VSI_CACHE=TRUE
EXPOSE 8000
CMD ["uvicorn","titiler.application.main:app","--host","0.0.0.0","--port","8000"]
EOF
docker build -t clearpath-titiler .
docker run -d --restart unless-stopped --name titiler \
  -v ~/cogs:/cogs:ro -p 127.0.0.1:8000:8000 clearpath-titiler
```

(The `-v ~/cogs:/cogs` mount is for the "Make it fast" step below; harmless if
you skip it.)

Then expose it with a **free Cloudflare Tunnel** — no port-forwarding, works
behind home NAT, HTTPS included (Part C). A local VM behind a tunnel is the
cleanest way to reach it from the public ClearPath site.

### Make it fast (recommended for local): pre-build overviews

Download just the COG tiles covering your sites and add overviews once. titiler
then reads the overviews instead of the full 1 m raster, so dense-forest bbox
requests go from many seconds to instant — and it works offline.

```sh
mkdir -p ~/cogs && cd ~/cogs
# repeat for each z9 quadkey covering your area (ClearPath logs the tile ids):
TILE=311211222
curl -L -o $TILE.tif \
  "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/$TILE.tif"
# rewrite as a tiled COG WITH overviews (needs gdal; run inside the container):
docker run --rm -v ~/cogs:/cogs ghcr.io/osgeo/gdal:ubuntu-small-latest \
  gdal_translate /cogs/$TILE.tif /cogs/$TILE.cog.tif \
  -of COG -co OVERVIEWS=AUTO -co COMPRESS=DEFLATE -co BLOCKSIZE=512
```

Then point ClearPath's `url=` at the **local** file (`/cogs/<tile>.cog.tif`)
instead of the S3 URL — titiler serves it with overviews. A handful of tiles is
a few GB of disk.

---

## Option 2 — Oracle Cloud "Always Free" VM (cloud, also can't be billed)

A Free-Tier account you **don't** upgrade to "Pay As You Go" cannot be charged —
over-limit usage throttles, it doesn't bill.

1. Sign up at <https://www.oracle.com/cloud/free/>; **never** click "Upgrade to
   Pay As You Go".
2. **Compute → Create instance:** shape **Ampere A1 (ARM)** "Always Free"
   (~2 OCPU / 12 GB), image **Ubuntu 22.04**. *(If Ampere is "out of capacity",
   retry / change region, or use the always-free AMD `VM.Standard.E2.1.Micro`.)*
3. No inbound firewall changes needed — the Cloudflare Tunnel is outbound-only.
4. SSH in, then follow the same **Docker** steps as Option 1 (install via
   `curl -fsSL https://get.docker.com | sudo sh`), and the Tunnel in Part C.

---

## Part C — Cloudflare Tunnel (HTTPS, no open ports) — for Option 1 or 2

Install `cloudflared` (Alpine: `apk add cloudflared`; Debian/Ubuntu: the
`.deb` for your arch from the cloudflare/cloudflared releases). Then:

```sh
cloudflared tunnel login
cloudflared tunnel create clearpath-titiler          # note the UUID
cloudflared tunnel route dns clearpath-titiler titiler.nbird.com.au
```

`/etc/cloudflared/config.yml`:

```yaml
tunnel: clearpath-titiler
credentials-file: /root/.cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: titiler.nbird.com.au
    service: http://127.0.0.1:8000
  - service: http_status:404
```

Run it as a service (`cloudflared service install` on systemd; on Alpine add an
OpenRC service or `cloudflared tunnel run` under a supervisor).

---

## Part D — Verify

```sh
curl "https://titiler.nbird.com.au/cog/info?url=https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/311211222.tif"
```

The downsampled bbox PNG ClearPath will request:

```
https://titiler.nbird.com.au/cog/bbox/152.4,-27.5,153.4,-26.6/256x256.png
  ?url=<S3 or /cogs/local cog url>&rescale=0,60&colormap_name=gray&return_mask=true&resampling=bilinear
```

> CORS: titiler allows all origins by default. To restrict to ClearPath, add a
> Cloudflare **Transform Rule → Modify Response Header** on `titiler.nbird.com.au`
> setting `Access-Control-Allow-Origin: https://dea.nbird.com.au`. titiler tiles
> are cacheable, so you can let Cloudflare cache this hostname.

---

## Part E — Wire ClearPath to it

Once `titiler.nbird.com.au` is verified, ping me and I'll switch the client to
**server-tiled PNG fetches**: per quadkey, fetch one downsampled
`cog/bbox/.../{cols}x{rows}.png`, decode `height = pixel/255 * 60`, mask via
alpha. This **drops `geotiff.js` (538 KB), the `CANOPY_MAX_POINTS` cap, and the
`canopy-service` Cloudflare Worker**, makes **dense-forest coverage canopy work**,
and adds `https://titiler.nbird.com.au` to the CSP `img-src`.

---

## Option 3 — AWS Lambda (co-located with the data, but can bill on overage)

Lambda in **us-east-1** is next to the COGs (fastest reads); the always-free tier
(1M req + 400k GB-s/mo) covers personal use — but AWS has **no hard cap**, so set
Budgets alerts. Deploy with **AWS SAM** (CloudFormation) using a **Lambda
Function URL** (free; avoids API Gateway's 12-month-only free tier), container
image or GDAL layer, region `us-east-1`. titiler's repo ships an adaptable CDK
deployment under `deployment/aws`.
