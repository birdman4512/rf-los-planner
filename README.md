# RF Line of Sight Planner

Interactive browser-based planner for RF line-of-sight links, terrain profiles,
Fresnel clearance, multi-hop paths, and terrain-aware coverage estimates.

The planner is designed for quick radio-path exploration, especially for
Meshtastic, amateur radio, and point-to-point Wi-Fi links.

## Features

- Leaflet map interface for placing and linking sites
- Terrain profile analysis using AWS Open Terrain Tiles
- Line-of-sight and 1st Fresnel zone clearance checks
- Multi-hop path profile views
- Per-band RF presets for Meshtastic, VHF/UHF, and Wi-Fi
- Terrain-aware radial coverage estimates
- Shareable URLs that preserve nodes, links, paths, and RF settings

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
