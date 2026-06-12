#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
COGS_DIR=${COGS_DIR:-"$PROJECT_DIR/cogs"}
MANIFEST="$COGS_DIR/manifest.json"
SOURCE_PREFIX=${SOURCE_PREFIX:-"https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm"}
GENERATED=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

mkdir -p "$COGS_DIR"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

meta_value() {
  key="$1"
  file="$2"
  if [ -f "$file" ]; then
    grep "^$key=" "$file" | sed "s/^$key=//" | head -n 1
  fi
}

{
  echo "{"
  echo "  \"sourcePrefix\": \"$(json_escape "$SOURCE_PREFIX")\","
  echo "  \"generated\": \"$GENERATED\","
  echo "  \"tiles\": {"

  first=1
  for cog in "$COGS_DIR"/*.cog.tif; do
    [ -e "$cog" ] || continue
    tile=$(basename "$cog" .cog.tif)
    meta="$COGS_DIR/$tile.meta"
    source_url=$(meta_value source_url "$meta")
    etag=$(meta_value etag "$meta")
    last_modified=$(meta_value last_modified "$meta")
    tile_generated=$(meta_value generated "$meta")

    [ "$first" -eq 1 ] || echo ","
    first=0
    printf '    "%s": {' "$(json_escape "$tile")"
    printf '"sourceUrl": "%s"' "$(json_escape "${source_url:-$SOURCE_PREFIX/$tile.tif}")"
    [ -z "${etag:-}" ] || printf ', "sourceEtag": "%s"' "$(json_escape "$etag")"
    [ -z "${last_modified:-}" ] || printf ', "sourceLastModified": "%s"' "$(json_escape "$last_modified")"
    [ -z "${tile_generated:-}" ] || printf ', "generated": "%s"' "$(json_escape "$tile_generated")"
    printf '}'
  done

  echo
  echo "  }"
  echo "}"
} > "$MANIFEST.tmp"

mv "$MANIFEST.tmp" "$MANIFEST"
echo "Wrote $MANIFEST"
