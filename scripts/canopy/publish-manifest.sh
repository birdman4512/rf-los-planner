#!/bin/sh
# Rebuild manifest.json from every published tile entry (meta/<qk>.json), set
# the bucket's CORS policy, and delete tile objects no entry references.
# Needs aws-cli + jq, R2_BUCKET, R2_ENDPOINT and R2 credentials in the env.
set -eu
: "${R2_BUCKET:?}" "${R2_ENDPOINT:?}"
ORIGINS=${CANOPY_ORIGINS:-"https://dea.nbird.com.au"}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
s3() { aws s3 "$@" --endpoint-url "$R2_ENDPOINT"; }

mkdir -p "$WORK/meta"
s3 cp "s3://$R2_BUCKET/meta/" "$WORK/meta/" --recursive --only-show-errors
set -- "$WORK"/meta/*.json
[ -e "$1" ] || { echo "No tiles published yet" >&2; exit 1; }

jq -n --arg generated "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{format: "cog-u8", generated: $generated, tiles: (reduce inputs as $m ({}; .[$m.quadkey] = $m))}' \
  "$@" > "$WORK/manifest.json"
echo "Manifest lists $(jq '.tiles | length' "$WORK/manifest.json") tile(s)"

# The app revalidates this at most once a minute; tiles themselves are immutable.
s3 cp "$WORK/manifest.json" "s3://$R2_BUCKET/manifest.json" \
  --content-type application/json --cache-control "public, max-age=60" --only-show-errors

# Range reads need the Range header allowed and Content-Range exposed; a day's
# MaxAge lets the browser reuse one preflight per tile URL.
jq -n --arg o "$ORIGINS" '{CORSRules: [{
  AllowedOrigins: ($o | split(",")), AllowedMethods: ["GET", "HEAD"],
  AllowedHeaders: ["Range"], ExposeHeaders: ["Content-Range", "Content-Length", "Accept-Ranges", "ETag"],
  MaxAgeSeconds: 86400 }]}' > "$WORK/cors.json"
# An "Object Read & Write" token can't change bucket settings; then CORS stays as
# set in the dashboard (docs/canopy.md) and this is only a warning.
if ! aws s3api put-bucket-cors --bucket "$R2_BUCKET" --cors-configuration "file://$WORK/cors.json" \
    --endpoint-url "$R2_ENDPOINT" 2>/dev/null; then
  echo "::warning::Couldn't set the bucket CORS policy with this token; keep it set in the R2 dashboard"
fi

jq -r '.tiles[] | select(.path) | .path' "$WORK/manifest.json" | sort > "$WORK/keep"
s3 ls "s3://$R2_BUCKET/tiles/" --recursive | awk '{print $4}' | sort > "$WORK/have"
comm -13 "$WORK/keep" "$WORK/have" | while read -r key; do
  echo "Pruning superseded $key"
  s3 rm "s3://$R2_BUCKET/$key" --only-show-errors
done

listing=$(s3 ls "s3://$R2_BUCKET" --recursive --summarize)
printf '%s\n' "$listing" | awk '/Total Size/ { printf "Bucket now holds %.2f GB (R2 free tier: 10 GB)\n", $3 / 1e9 }' \
  | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
