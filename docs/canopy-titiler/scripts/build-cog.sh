#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <9-digit quadkey>" >&2
  exit 2
fi

TILE="$1"
case "$TILE" in
  [0-3][0-3][0-3][0-3][0-3][0-3][0-3][0-3][0-3]) ;;
  *)
    echo "Tile must be a 9-digit quadkey containing only 0,1,2,3" >&2
    exit 2
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
COGS_DIR=${COGS_DIR:-"$PROJECT_DIR/cogs"}
SOURCE_PREFIX=${SOURCE_PREFIX:-"https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm"}
SRC_URL="$SOURCE_PREFIX/$TILE.tif"

mkdir -p "$COGS_DIR"

TMP_TIF="$COGS_DIR/$TILE.tmp.tif"
TMP_COG="$COGS_DIR/$TILE.tmp.cog.tif"
OUT_COG="$COGS_DIR/$TILE.cog.tif"
META="$COGS_DIR/$TILE.meta"

echo "Downloading $SRC_URL"
curl -fL -o "$TMP_TIF" "$SRC_URL"

echo "Building $OUT_COG"
docker run --rm -v "$COGS_DIR":/cogs ghcr.io/osgeo/gdal:ubuntu-small-latest \
  gdal_translate "/cogs/$TILE.tmp.tif" "/cogs/$TILE.tmp.cog.tif" \
  -of COG -co OVERVIEWS=AUTO -co COMPRESS=DEFLATE -co BLOCKSIZE=512

mv "$TMP_COG" "$OUT_COG"
rm -f "$TMP_TIF"

GENERATED=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
HEADERS=$(curl -fsSI "$SRC_URL" || true)
ETAG=$(printf '%s\n' "$HEADERS" | awk 'tolower($0) ~ /^etag:/ { sub(/\r$/, ""); sub(/^[^:]*:[ \t]*/, ""); gsub(/"/, ""); print; exit }')
LAST_MODIFIED=$(printf '%s\n' "$HEADERS" | awk 'tolower($0) ~ /^last-modified:/ { sub(/\r$/, ""); sub(/^[^:]*:[ \t]*/, ""); print; exit }')

{
  echo "source_url=$SRC_URL"
  echo "etag=$ETAG"
  echo "last_modified=$LAST_MODIFIED"
  echo "generated=$GENERATED"
} > "$META"

"$SCRIPT_DIR/refresh-manifest.sh"
echo "Done: $OUT_COG"
