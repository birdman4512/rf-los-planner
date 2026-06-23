# ClearPath — RF Line of Sight Planner

Interactive browser-based planner for RF line-of-sight links, terrain profiles,
Fresnel clearance, multi-hop paths, and terrain-aware coverage estimates.

The planner is designed for quick radio-path exploration, especially for
Meshtastic, amateur radio, and point-to-point Wi-Fi links.

## Features

- Leaflet map interface for placing and linking sites
- Terrain profile analysis using AWS Open Terrain Tiles
- Line-of-sight and 1st Fresnel zone clearance checks, with earth-curvature
  correction (selectable k-factor: 4/3, 1, 2/3)
- Per-link knife-edge diffraction loss estimate in dB (ITU-R P.526), so marginal
  links report an actual loss figure rather than just a pass/fail flag
- Multi-hop path profile views
- Per-band RF presets for Meshtastic, VHF/UHF, and Wi-Fi
- Terrain-aware radial coverage estimates
- Optional surface clutter: ESA WorldCover land cover plus measured Meta/WRI
  canopy height (via a self-hosted titiler) for foliage/building obstruction
  and diffraction loss — see [docs/canopy-titiler.md](docs/canopy-titiler.md)
- Shareable URLs that preserve nodes, links, paths, and RF settings

## Link Status

Each analysed link is classified by clearance:

- **✓ CLEAR** — LOS clear and the 1st Fresnel zone meets the preset threshold
  (40% for Meshtastic/ham, 60% for Wi-Fi).
- **⚠ MARGINAL** — LOS clear but the Fresnel zone is obstructed below the
  threshold; the estimated knife-edge diffraction loss (**Diff**, in dB) is shown
  on the link result.
- **✕ BLOCKED** — terrain interrupts the direct line of sight.

## Modelling & Limitations

This is a first-order **line-of-sight** planner. It is frequency-aware — both the
Fresnel zone radius and free-space path loss scale correctly with frequency — so
it is well suited to comparing bands for clear point-to-point links.

Bare-earth terrain (~30 m DEM) is always the hard LOS gate. **Optional surface
clutter** adds foliage/building obstruction on top: ESA WorldCover land-cover
heights, optionally refined by measured Meta/WRI canopy height served by a
self-hosted titiler ([docs/canopy-titiler.md](docs/canopy-titiler.md)). Clutter
is treated as soft loss (extra Fresnel/diffraction intrusion plus a capped
per-metre attenuation), never as new hard terrain.

It does **not** model non-line-of-sight propagation (diffraction-dominated paths,
tropospheric or ground-wave), rain or atmospheric attenuation, multipath, or
antenna patterns. The diffraction figure is a single knife-edge estimate over the
dominant obstruction. For full NLOS coverage prediction, use a Longley-Rice/ITWOM
tool (SPLAT!, Radio Mobile, CloudRF).

## Running Locally

Serve the repo root over HTTP and open it in a browser:

```
npm install
npm run serve
# → http://localhost:8080/
```

This matches how GitHub Pages serves the site (same-origin fonts,
Content-Security-Policy behaviour, CORS image decoding). Opening `index.html`
directly via `file://` mostly works but is not the tested path.

The tool loads Leaflet, LZString, map tiles, and terrain tiles from public
CDNs/services, so an internet connection is needed for the full experience.
Fonts are self-hosted from `fonts/`.

The app itself is `index.html` (markup + styles) plus `js/app.js` (all logic).
There is deliberately no inline JavaScript: the Content-Security-Policy omits
`'unsafe-inline'` from `script-src`.

## Repeater Finder

`repeaters.html` is a standalone companion page (not linked from the map) that
lists Australian amateur repeaters near a location and opens a selection in
ClearPath as a deep-link — your location plus each repeater as linked nodes,
with the RF frequency preset to the repeater's output band — so you can check
line-of-sight and coverage for "what can I hear from here".

The repeater dataset (`data/repeaters-au.json`) is derived from the ACMA
Register of Radiocommunications Licences (CC BY 4.0). To refresh it, run the
**Build repeaters** GitHub Action (Actions tab → *Build repeaters* → *Run
workflow*); it downloads the ACMA extract, rebuilds the JSON via
`scripts/build-repeaters.mjs`, and commits the result (which redeploys the
site). It also runs monthly. The shipped JSON is sample data until the action
runs for the first time.

The v4 share-link format is single-sourced in `share-codec.js`, shared by the
app and the finder.

## Publishing

The site is published to GitHub Pages by the **CI & Deploy** GitHub Action
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)), not by serving the repo
root directly. On every push to `main` the workflow runs the JS syntax check and
Playwright smoke tests (`verify`), and only if those pass does the gated `deploy`
job assemble a clean `_site/` and publish it. Failed tests leave the previous
good deploy live.

Expected URL:

`https://dea.nbird.com.au/rf-los-planner/`

### First-time setup

1. In the repository settings, set **Settings → Pages → Build and deployment →
   Source** to **GitHub Actions** (not "Deploy from a branch"). The branch/root
   option would serve the raw repo and bypass the test gate.
2. Push to `main` (or run the workflow via *Actions → CI & Deploy → Run
   workflow*). The `deploy` job publishes the assembled site.

The `deploy` job's **Assemble static site** step copies an explicit allow-list of
files into `_site/` (the HTML pages, the `js/` folder, fonts, icons, and
`data/repeaters-au.json`) — dev tooling (`scripts/`, `tests/`, `package.json`,
workflows, `docs/`) is deliberately kept off the public URL. **Any new static
asset must be added to that step or it will 404 on the live site.**

The optional canopy/titiler stack is a separate self-hosted service and is **not**
part of this Pages deploy — see [docs/canopy-titiler.md](docs/canopy-titiler.md)
for that.
