# RF Line of Sight Planner

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

It does **not** model non-line-of-sight propagation (diffraction-dominated paths,
tropospheric or ground-wave), clutter/foliage/building loss (terrain is bare-earth
~30 m DEM), rain or atmospheric attenuation, multipath, or antenna patterns. The
diffraction figure is a single knife-edge estimate over the dominant obstruction.
For full NLOS coverage prediction, use a Longley-Rice/ITWOM tool (SPLAT!, Radio
Mobile, CloudRF).

## Running Locally

Open `index.html` in a browser.

The tool loads Leaflet, LZString, fonts, map tiles, and terrain tiles from public
CDNs/services, so an internet connection is needed for the full experience.

## Publishing

This repo is intended to be published with GitHub Pages.

Expected URL:

`https://dea.nbird.com.au/rf-los-planner/`

Enable Pages in the repository settings using the `main` branch and the repository
root as the source.
