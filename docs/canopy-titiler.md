# Canopy via a self-hosted titiler

ClearPath reads per-pixel Meta/WRI canopy heights, but the source COGs are 1 m
with **no overviews** (65536² px), so the browser can only read them at full
resolution. That's fine for **links** (a few grazing points) but caps out for
**coverage in dense forest** (tens of thousands of grazing points — see the
`CANOPY_MAX_POINTS` cap in `app.js`).

A **titiler** fixes this: it reads the COGs server-side (GDAL `/vsicurl/`) and
returns a small **downsampled** image for any bbox — so dense-forest coverage
canopy becomes one fast fetch, like the old (now-dead) GFW tile server.

> ⚠️ Because the COGs have **no overviews**, *any* server still reads full-res
> to downsample a large bbox. The win is it happens server-side and only a small
> image crosses the wire. To make it genuinely fast — especially on a tiny VM —
> **pre-build overviews on the few tiles covering your sites** ("Make it fast").

The whole stack runs from one `docker-compose.yml` (titiler + the Cloudflare
Tunnel connector), so it's the same on a local box or a cloud VM.

---

## Option 1 — Local VM (e.g. Alpine, small specs)  ⭐ can't be billed, simplest

Your hardware, no cloud bill ever, and it only needs to be **on while you're
planning** (off → ClearPath just falls back to flat Forest(m)). **1 vCPU / 1 GB**
is comfortable; 512 MB works with the low `GDAL_CACHEMAX` below.

### 1. Install Docker + Compose (Alpine)

```sh
apk add docker docker-cli-compose
rc-update add docker boot && service docker start
```

### 2. Create the project

```sh
mkdir -p ~/titiler/cogs && cd ~/titiler
```

`~/titiler/Dockerfile` — Debian/GDAL base (don't fight Alpine's musl; the host
only runs the daemon):

```dockerfile
FROM ghcr.io/osgeo/gdal:ubuntu-small-latest
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip \
 && pip install --no-cache-dir --break-system-packages titiler.application uvicorn \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
EXPOSE 8000
CMD ["uvicorn","titiler.application.main:app","--host","0.0.0.0","--port","8000"]
```

`~/titiler/docker-compose.yml`:

```yaml
services:
  titiler:
    build: .
    restart: unless-stopped
    expose: ["8000"]                 # internal only; cloudflared reaches it as titiler:8000
    ports: ["127.0.0.1:8000:8000"]   # optional: lets you curl it locally on the VM
    volumes:
      - ./cogs:/cogs:ro
    environment:
      CPL_VSIL_CURL_ALLOWED_EXTENSIONS: ".tif"
      GDAL_DISABLE_READDIR_ON_OPEN: "EMPTY_DIR"
      GDAL_CACHEMAX: "256"
      VSI_CACHE: "TRUE"

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN}
    depends_on: [titiler]
```

### 3. Create the Cloudflare Tunnel (dashboard → token)

1. **Cloudflare Zero Trust dashboard → Networks → Tunnels → Create a tunnel →
   Cloudflared**, name it `clearpath-titiler`, **Save**.
2. On the "Install connector" screen, copy the **token** (the long `eyJ…`
   string). Put it in `~/titiler/.env`:
   ```
   TUNNEL_TOKEN=eyJ...your-token...
   ```
3. In the tunnel's **Public Hostname** tab → **Add a public hostname**:
   - Subdomain `titiler`, Domain `nbird.com.au`
   - Type **HTTP**, URL **`titiler:8000`**  *(the compose service name, not
     localhost — cloudflared resolves it over the compose network)*
   - **Save**.

### 4. Start it

```sh
cd ~/titiler
docker compose up -d --build
docker compose logs -f cloudflared   # should show "Registered tunnel connection"
```

### Make it fast (recommended): pre-build overviews

The source COGs have no overviews, so downsampling reads full-res — slow on a
small VM. Download the few tiles covering your sites and rebuild each as a COG
**with** overviews (one-off; ClearPath's LOG prints the tile ids):

```sh
cd ~/titiler/cogs
TILE=311211222
curl -L -o $TILE.tif \
  "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/$TILE.tif"
docker run --rm -v "$PWD":/cogs ghcr.io/osgeo/gdal:ubuntu-small-latest \
  gdal_translate /cogs/$TILE.tif /cogs/$TILE.cog.tif \
  -of COG -co OVERVIEWS=AUTO -co COMPRESS=DEFLATE -co BLOCKSIZE=512
```

Then ClearPath requests `url=/cogs/<tile>.cog.tif` (local, with overviews) →
instant, and works offline. A handful of tiles is a few GB of disk.

---

## Option 2 — Oracle Cloud "Always Free" VM (cloud, also can't be billed)

A Free-Tier account you **don't** upgrade to "Pay As You Go" cannot be charged.

1. <https://www.oracle.com/cloud/free/> — sign up, **never** "Upgrade to Pay As
   You Go".
2. **Compute → Create instance:** **Ampere A1 (ARM)** "Always Free"
   (~2 OCPU / 12 GB), **Ubuntu 22.04**. *(Ampere "out of capacity" → retry /
   change region, or use the always-free AMD `VM.Standard.E2.1.Micro`.)*
3. No inbound firewall changes — the tunnel is outbound-only.
4. Install Docker (`curl -fsSL https://get.docker.com | sudo sh`) then follow the
   **same Option 1 steps 2–4** (identical `docker-compose.yml`).

---

## Verify (from your own PC)

```sh
curl "https://titiler.nbird.com.au/cog/info?url=https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/311211222.tif"
```

JSON back = working end to end. The downsampled bbox PNG ClearPath will request:

```
https://titiler.nbird.com.au/cog/bbox/152.4,-27.5,153.4,-26.6/256x256.png
  ?url=<S3 or /cogs/local cog url>&rescale=0,60&colormap_name=gray&return_mask=true&resampling=bilinear
```

> CORS: titiler allows all origins by default. To restrict to ClearPath, add a
> Cloudflare **Transform Rule → Modify Response Header** on `titiler.nbird.com.au`
> setting `Access-Control-Allow-Origin: https://dea.nbird.com.au`. titiler tiles
> are cacheable, so you can let Cloudflare cache this hostname.

---

## Wire ClearPath to it

Once the verify curl returns JSON, ping me and I'll switch the client to
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
