# Accuracy model and validation

## Calculations

`js/rf-model.js` is the pure calculation engine used by both individual links
and the coverage worker. Units are metres, MHz, dBm and dB. A coverage candidate
uses exactly the same solver and two directional radio budgets as a link with
the same sampled profile and endpoint settings. Its remote endpoint uses the
global radio settings and the configured coverage RX height.

The default diffraction method is the **Bullington component** in
[ITU-R P.526-15 §4.5.1, equations 50–57](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.526-15-201910-S!!PDF-E.pdf).
It considers both terrain horizons, rather than just the largest single-edge
parameter. Earth bulge uses the selected effective radius factor. Single-edge
comparison and strict surface-LOS modes are also available. This is **not** the
complete delta-Bullington method: its smooth-earth correction is not implemented.
Broad smooth hills and long over-horizon paths remain particularly uncertain.

Geometry is reported independently from reception. `BUDGET OK` means both
directions exceed receiver sensitivity by the required reserve. `LOW MARGIN`
means both exceed sensitivity but at least one lacks that reserve. `BELOW
SENSITIVITY` means the budget fails; strict LOS can also exclude a path. Different
specified LoRa presets are flagged as incompatible. Geometry and signal strength
are not evidence of real reception.

Every radio budget includes TX power, both antenna gains and both cable losses.
Receiver sensitivity is independently editable for each device. LoRa presets
provide bandwidth and typical demodulation thresholds; the calculated default
sensitivity uses thermal noise and an editable receiver noise figure. SNR uses
that estimated noise floor, or a supplied measured noise floor. RSSI and SNR
observations do not automatically change predictions. Interference, multipath,
polarisation mismatch, antenna patterns, atmospheric variability and weather
losses are not predicted.

## Terrain and clutter

Profiles follow a great-circle path, generally at 20 m spacing. Profiles near
the Fresnel boundary are refined to approximately 10 m, capped at 6,400 intervals.
Coverage starts with the selected number of rays and bisects wide sectors or
sectors with changing reception/margin, to a maximum of 720 rays and five passes.
The requested angular spacing is a target, not a guarantee; results report actual
radial spacing and maximum separation at the outer edge. Coverage runs in a Web
Worker. It discards results if inputs change during calculation.

AWS Terrarium elevations are sampled at zoom 12 with pixel-centred interpolation
across tile boundaries. Transparent terrain pixels cause an error, not a zero
elevation. Spatial sampling finer than the source does not recover missing
ridges, buildings or trees. The source age and vertical accuracy are not known
for every location.

WorldCover class heights and canopy rasters remain estimates. Measured zero
canopy is retained as a clearing over tree classes; it does not erase built-up
class height. Links always request measured canopy; the canopy setting only
controls coverage sweeps. Where a tree pixel has no measured canopy, its flat
Forest(m) height is a guess. Within 100 m of either end of a path such guessed
samples are treated as unknown (no clutter) in both clutter modes, rather than
as a wall beside a low antenna; user-supplied site clutter heights still apply. Source availability, fallback use, raster sampling and sample
spacing are reported. Canopy is not the native one metre product. Tiles are
pre-built to ~4–5 m cells using the maximum of each block, with RMS overviews,
so tree tops are kept rather than averaged into gaps. The browser reads the
overview level whose pixel is no larger than the sampling step: about 8.5 m for
links and about 17 m for a coverage sweep at 27°S. Heights are whole metres with
no ceiling. The data-quality note reports the grid spacing used and the tile build.

The default clutter treatment uses geometry plus empirical through-clutter
attenuation. The rate, square-root frequency scaling and cap are assumptions,
not a locally calibrated vegetation model. Combining diffraction and penetration
loss can overestimate some paths; validate with measurements. A verified clearing
radius defaults to zero and can be set independently per node. Existing share
links preserve their saved clearing radius. Local clutter overrides apply within
100 m of a node. Surveyed ground elevations override only the endpoint height.

Optional terminal clutter uses
[ITU-R P.2108-1 §3.1 equation 2a](https://www.itu.int/dms_pubrec/itu-r/rec/p/R-REC-P.2108-1-202109-I!!PDF-E.pdf)
for tree/urban clutter within 30–3,000 MHz. The path calculation uses the greater
of antenna and representative clutter height, then adds the terminal loss at
each end. Local geometric clutter within the 100 m terminal region is excluded
from that loss calculation to reduce double counting. Representative height is
estimated using the 80th percentile of samples in that region, or user supplied
heights; this choice and the 100 m region are modelling assumptions, not prescribed
by P.2108. Outside the frequency range, geometric clutter is used and flagged.

Height sensitivity re-runs the link with raised/lowered terrain and clutter.
These scenarios hold endpoint elevations fixed. They are not statistical
confidence bounds and do not include all possible correlated errors or weather.

## Observations and validation

Settings → Measurements accepts JSON. Observations are directed and timestamped:

```json
{
  "nodeNameMap": {"MSMS": "Monsoon Moon Server"},
  "observations": [{
    "from": "SunBird", "to": "MSMS",
    "timestamp": "2026-09-29T00:00:00Z",
    "frequencyMHz": 915, "modem": "LongFast",
    "success": true, "snrDb": -4.5,
    "split": "validation", "source": "Example only"
  }]
}
```

Replace the example's time and settings with actual measurements. Optional
`rssiDbm` is received signal power. Failed attempts use `success:false` with no
RSSI/SNR. Do not invent a receive power for packets that were not received.
Optional `radio` metadata accepts `txDbm`, `txGainDbi`, `rxGainDbi`, `txCableDb`,
`rxCableDb`, `txHeightM`, `rxHeightM`, `rxSensitivityDbm` and `hardware`. Numeric
settings are checked against the current sites before comparisons are included.
For traces, attach this metadata to the receiving hop. Missing settings remain
unknown; the app does not silently fill them from the current project.
`split` is either `calibration` or `validation` (default). Records are deduplicated
by all their fields and limited to 10,000. Repeated attempts need distinct times.

Traceroutes can be supplied as a `traces` array; each trace contains `timestamp`,
`frequencyMHz`, `modem`, optional `split`, and `forward` / `reverse` arrays. Each
array starts with `{ "node": "Origin" }`; following entries contain `node`,
`snrDb` and optionally `rssiDbm` for reception **at that node from the previous
node**. Forward and return paths need not be identical. This documented interchange
schema does not guess node identities from a screenshot or arbitrary client logs.

Node names match case-insensitively, and a name map can resolve differences.
Unknown or ambiguous nodes are counted, not created with invented coordinates.
For this user's observed topology, add Re-Rei at its actual location before
modelling Homing → Re-Rei → SunBird → Monsoon Moon Server.

After analysis, comparison reports prediction-minus-observation bias and MAE
separately for RSSI/SNR and calibration/validation samples. Only records with
matching modem, frequency and any supplied numeric radio metadata are compared.
Unrecorded hardware, antenna, height and environment changes still need to be
controlled by the operator. Keep validation
data independent when changing model assumptions. Successful traceroutes alone
cannot measure delivery probability or availability; record failed attempts and
repeat under different conditions. No automatic parameter fitting is performed.

## Local terrain and project files

Settings → Measurements imports a bare-earth grid JSON with `type:"terrain-grid"`,
`source`, `date`, `datum`, integer `rows` and `cols`, WGS84 `north`, `south`, `west`,
`east` bounds, and a flat `elevations` array. Bounds describe grid sample centres;
values run west to east, then north to south, in AMSL metres. Maximum one million
cells. Use `null` for no data; interpolation then falls back to AWS. Outside the
grid also falls back to AWS. Match the vertical datum before import; there is no
automatic geoid/datum conversion. Importing a grid invalidates cached profiles.

Project downloads contain the share hash, observations and optional terrain grid.
Restore validates all three before replacing current state. Share URLs retain
radio, model and site parameters but do not include measurements or DEM contents.
Downloads are explicit and the imported data stays in the browser session;
download a project before closing the page. No data is uploaded by these imports.

## Verification

`npm run test:model` checks reference FSPL/Fresnel/knife-edge values, an independent
Bullington calculation, reciprocity, asymmetric RF, incompatible modems, exact
link/coverage agreement, terminal handling, sampling convergence, adaptive-sector
decisions, trace direction/validation and local-grid interpolation. Browser tests
exercise controls, profiles, share extensions, imports and worker coverage.

These checks establish implementation consistency and formula agreement. They do
not establish a real-world prediction error for the Queensland links. That needs
repeated measured RSSI/SNR and failed-attempt data with known radio/site settings.
