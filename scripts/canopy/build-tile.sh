#!/bin/sh
# Build one peak-preserving canopy COG from a Meta/WRI source tile.
#   scripts/canopy/build-tile.sh <9-digit quadkey> <out dir>
# Writes <out>/<quadkey>.tif and <out>/<quadkey>.json (the tile's manifest
# entry). Runs GDAL from Docker unless gdalwarp is already on PATH.
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <9-digit quadkey> <out dir>" >&2
  exit 2
fi

TILE="$1"
OUT_DIR="$2"
case "$TILE" in
  [0-3][0-3][0-3][0-3][0-3][0-3][0-3][0-3][0-3]) ;;
  *) echo "Tile must be a 9-digit quadkey containing only 0,1,2,3" >&2; exit 2 ;;
esac

SOURCE_PREFIX=${SOURCE_PREFIX:-"https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm"}
GDAL_IMAGE=${GDAL_IMAGE:-"ghcr.io/osgeo/gdal:ubuntu-small-latest"}
SRC_URL="$SOURCE_PREFIX/$TILE.tif"

# Downsample factor from the ~1.19 m (EPSG:3857) source grid. Each output cell
# is the MAX of FACTOR x FACTOR source pixels, so canopy tops (what obstructs a
# ray) survive instead of being averaged into gaps. 4 -> ~4.8 m Mercator
# (~4.3 m ground at 27 S), still finer than the app's 10-40 m sampling.
FACTOR=${FACTOR:-4}
case "$FACTOR" in
  1|2|4|8|16) ;;
  *) echo "FACTOR must be 1, 2, 4, 8 or 16" >&2; exit 2 ;;
esac
OUT_PX=$((65536 / FACTOR))
BUILD="max${FACTOR}-ovrms-u8"

mkdir -p "$OUT_DIR"
OUT_DIR=$(CDPATH= cd -- "$OUT_DIR" && pwd)
SRC="$OUT_DIR/$TILE.src.tif"
TMP="$OUT_DIR/$TILE.tmp.tif"

if command -v gdalwarp >/dev/null 2>&1; then
  gdal() { "$@"; }
  P="$OUT_DIR"
else
  gdal() { docker run --rm -v "$OUT_DIR":/work "$GDAL_IMAGE" "$@"; }
  P=/work
fi

# Meta publishes no tile where there is no land (open sea). A 404 (and only a
# 404, so an outage is never mistaken for one) is recorded as an empty tile:
# a manifest entry with no file, which the app treats as covered, no canopy.
STATUS=$(curl -s -o /dev/null -I -w '%{http_code}' "$SRC_URL")
if [ "$STATUS" = 404 ]; then
  echo "No source for $TILE (open sea / no data): recording it as an empty tile"
  cat > "$OUT_DIR/$TILE.json" <<EOF
{"quadkey": "$TILE", "empty": true, "generated": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")", "sourceUrl": "$SRC_URL"}
EOF
  exit 0
fi

# Read the upstream headers BEFORE downloading, so the recorded ETag can never
# describe a newer object than the bytes actually built.
HEADERS=$(curl -fsSI "$SRC_URL")
ETAG=$(printf '%s\n' "$HEADERS" | awk 'tolower($0) ~ /^etag:/ { sub(/\r$/, ""); sub(/^[^:]*:[ \t]*/, ""); gsub(/"/, ""); print; exit }')
LAST_MODIFIED=$(printf '%s\n' "$HEADERS" | awk 'tolower($0) ~ /^last-modified:/ { sub(/\r$/, ""); sub(/^[^:]*:[ \t]*/, ""); print; exit }')

echo "Downloading $SRC_URL"
curl -fL --retry 3 -o "$SRC" "$SRC_URL"

# The source is 65536x65536 uint8 (whole metres; no nodata tag, 0 = no canopy).
# - gdalwarp -r max: peak-preserving downsample (a warp-only resampler).
# - OVERVIEW_RESAMPLING=RMS: overviews lean toward tall pixels too. GDAL's
#   default (cubic) would smooth peaks away at the coarse levels the app reads
#   for long coverage sweeps.
# - Byte output keeps the source's exact integer metres.
# - 512 px DEFLATE tiles with predictor 2: what js/canopy-cog.js decodes.
echo "Building $TILE (max ${FACTOR}x${FACTOR} -> ${OUT_PX}px, RMS overviews)"
gdal gdalwarp "$P/$TILE.src.tif" "$P/$TILE.tmp.tif" \
  -overwrite -r max -ts "$OUT_PX" "$OUT_PX" -ot Byte -multi -wm 1024 \
  -wo NUM_THREADS=ALL_CPUS -of COG \
  -co COMPRESS=DEFLATE -co PREDICTOR=2 -co LEVEL=9 -co BLOCKSIZE=512 \
  -co OVERVIEWS=AUTO -co OVERVIEW_RESAMPLING=RMS -co NUM_THREADS=ALL_CPUS
GDAL_VERSION=$(gdal gdalinfo --version | tr -d '\r')

mv "$TMP" "$OUT_DIR/$TILE.tif"
rm -f "$SRC"

GENERATED=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
STAMP=$(date -u +"%Y%m%dT%H%M%SZ")
BYTES=$(wc -c < "$OUT_DIR/$TILE.tif" | tr -d ' ')
# Mercator cell size; ground size is this x cos(latitude).
RES_M=$(awk -v f="$FACTOR" 'BEGIN { printf "%.3f", 40075016.686 / 512 / 65536 * f }')

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# A new object key per build keeps every published URL immutable, so browsers
# and the CDN can cache tiles forever (publish-manifest.sh prunes old keys).
cat > "$OUT_DIR/$TILE.json" <<EOF
{"quadkey": "$TILE", "path": "tiles/$TILE/$STAMP.tif", "bytes": $BYTES,
 "build": "$BUILD", "resolutionM": $RES_M, "generated": "$GENERATED",
 "gdal": "$(json_escape "$GDAL_VERSION")", "sourceUrl": "$(json_escape "$SRC_URL")",
 "sourceEtag": "$(json_escape "$ETAG")", "sourceLastModified": "$(json_escape "$LAST_MODIFIED")"}
EOF
echo "Done: $OUT_DIR/$TILE.tif ($BYTES bytes)"
