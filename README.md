# ClearPath — RF Line of Sight Planner

Interactive browser-based planner for RF line-of-sight links, terrain profiles,
Fresnel clearance, multi-hop paths, and terrain-aware coverage estimates.

The planner is designed for quick radio-path exploration, especially for
Meshtastic, amateur radio, and point-to-point Wi-Fi links.

## Features

- MapLibre map for sites, links, paths and terrain-aware coverage
- One shared RF solver for profiles and coverage, with directional budgets
- Bullington diffraction, single-edge comparison and strict surface-LOS modes
- Separate geometry, predicted receive power/margin/SNR and observed reception
- Distance-based profiles, marginal-profile refinement and adaptive coverage rays
- Per-node radio settings, cable loss, surveyed ground and local clutter overrides
- Canopy/WorldCover modelling, zero default clearing radius and explicit data quality
- Height-sensitivity scenarios, local DEM imports and traceroute/measurement validation
- Shareable settings URLs and downloadable projects including local data

## Accuracy and limitations

Budget status now means **BUDGET OK**, **LOW MARGIN** or **BELOW SENSITIVITY**.
Geometry is reported independently. A successful traceroute is evidence of a
received packet, not proof of clear LOS or reliable availability.

The default uses the Bullington component of ITU-R P.526, not the complete
spherical-earth/delta-Bullington model. Clutter attenuation and terminal-region
selection still contain assumptions. Source resolution, missing canopy data,
noise/interference and changing conditions limit prediction accuracy. Height
scenarios are sensitivity checks, not confidence intervals.

See [Accuracy model and validation](docs/accuracy.md) for the equations used,
limitations, measurement/traceroute JSON format, terrain-grid format and tests.
Measured canopy comes from a self-hosted titiler; see
[docs/canopy-titiler.md](docs/canopy-titiler.md).

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

The tool loads MapLibre, LZString, map tiles, and terrain tiles from public
CDNs/services, so an internet connection is needed for the full experience.
Fonts are self-hosted from `fonts/`.

The app uses `index.html` (markup/styles), `js/app.js` (map and workflow),
`js/rf-model.js` (shared propagation), `js/rf-worker.js` (coverage),
`js/rf-data.js` (data validation), and `js/accuracy.js` (accuracy controls/imports).
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
root directly. On every push to `main` the workflow runs the JS syntax check, numerical model tests and
Playwright regression tests (`verify`), and only if those pass does the gated `deploy`
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
