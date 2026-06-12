# Canopy via a self-hosted titiler (future option)

ClearPath currently reads per-pixel Meta/WRI canopy heights **in the browser**
(`geotiff.js`) through the Cloudflare Worker, but capped to a small ring around
each site (opt-in "Measured canopy ≤5 km" toggle). That cap exists because the
canopy COGs are **1 m with no overviews** (65536² px), so a full-resolution
browser read of a whole coverage area needs hundreds of MB in one array and
fails.

A **titiler** removes that limit by doing the windowing *and* downsampling
**server-side**, returning a small image — exactly what the (now-dead) GFW
tile server did. This is the right approach if you want canopy across the whole
coverage area instead of just an inner ring.

## Run titiler in Docker

[titiler](https://developmentseed.org/titiler/) ships an official image:

```bash
docker run --rm -p 8000:8000 \
  -e PORT=8000 \
  -e CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif \
  -e GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR \
  ghcr.io/developmentseed/titiler:latest
```

Or via `docker-compose.yml`:

```yaml
services:
  titiler:
    image: ghcr.io/developmentseed/titiler:latest
    ports:
      - "8000:8000"
    environment:
      - PORT=8000
      - CPL_VSIL_CURL_ALLOWED_EXTENSIONS=.tif
      - GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR
      # Larger cache helps repeat reads of the same COGs:
      - GDAL_CACHEMAX=512
      - VSI_CACHE=TRUE
```

GDAL reads the COGs straight from the public S3 bucket via its `/vsicurl/`
handler, so titiler can point at them directly — no Cloudflare Worker needed
for this path. For production, put it behind HTTPS (Caddy/nginx/Cloudflare
Tunnel) and lock CORS to the ClearPath origin.

## Wire ClearPath to it

A bbox PNG request (what the old GFW code used) looks like:

```
https://<titiler-host>/cog/bbox/{minx},{miny},{maxx},{maxy}/{w}x{h}.png
  ?url=https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/<quadkey>.tif
  &rescale=0,60&resampling=bilinear&return_mask=true
```

To switch `buildCanopyGrid` back to a server-tiled fetch:
- Replace the geotiff.js chunked read with a per-tile `loadClutterImage(bboxUrl, cols, rows)`
  (the pattern is in git history — see the pre-COG `canopyBboxUrl`/PNG version).
- Decode the grayscale PNG: `height = (pixel/255) * 60` (rescale ceiling), mask
  via the alpha channel.
- Drop the `CANOPY_RADIUS_M` cap — server-side downsampling makes whole-area
  reads cheap again.
- Add the titiler origin to `connect-src`/`img-src` in the CSP, and remove the
  now-unused `geotiff.min.js` + Cloudflare Worker.

## Hosting notes

- **Local/LAN only:** the Docker command above is enough for personal use.
- **Public:** AWS Lambda (titiler has a serverless deployment), Fly.io, or a
  small VPS. The COGs are in `us-east-1`; co-locating the tiler there makes the
  COG reads fast.
