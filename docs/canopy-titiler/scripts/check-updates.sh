#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
COGS_DIR=${COGS_DIR:-"$PROJECT_DIR/cogs"}
SOURCE_PREFIX=${SOURCE_PREFIX:-"https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm"}

meta_value() {
  key="$1"
  file="$2"
  if [ -f "$file" ]; then
    grep "^$key=" "$file" | sed "s/^$key=//" | head -n 1
  fi
}

for cog in "$COGS_DIR"/*.cog.tif; do
  [ -e "$cog" ] || continue
  tile=$(basename "$cog" .cog.tif)
  url="$SOURCE_PREFIX/$tile.tif"
  meta="$COGS_DIR/$tile.meta"
  old_etag=$(meta_value etag "$meta")
  old_last_modified=$(meta_value last_modified "$meta")

  headers=$(curl -fsSI "$url" || true)
  new_etag=$(printf '%s\n' "$headers" | awk 'tolower($0) ~ /^etag:/ { sub(/\r$/, ""); sub(/^[^:]*:[ \t]*/, ""); gsub(/"/, ""); print; exit }')
  new_last_modified=$(printf '%s\n' "$headers" | awk 'tolower($0) ~ /^last-modified:/ { sub(/\r$/, ""); sub(/^[^:]*:[ \t]*/, ""); print; exit }')

  if [ -n "$old_etag" ] && [ -n "$new_etag" ] && [ "$old_etag" != "$new_etag" ]; then
    echo "$tile changed: etag $old_etag -> $new_etag"
  elif [ -n "$old_last_modified" ] && [ -n "$new_last_modified" ] && [ "$old_last_modified" != "$new_last_modified" ]; then
    echo "$tile changed: last-modified $old_last_modified -> $new_last_modified"
  else
    echo "$tile ok"
  fi
done
