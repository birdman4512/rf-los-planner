// ─────────────────────────────────────────────────────────────────────────
//  build-repeaters.mjs — generate data/repeaters-au.json from the ACMA RRL.
//
//  Source: ACMA Register of Radiocommunications Licences "spectra" daily
//  extract, licensed CC BY 4.0. Download + unzip is done by the caller (the
//  GitHub Action), which leaves the CSV tables in a directory we read here.
//
//    1. unzip spectra_rrl.zip -d spectra
//    2. node scripts/build-repeaters.mjs spectra
//
//  No npm dependencies — pure Node (>=18). Run it via the "Build repeaters"
//  GitHub Action (manual button) so the dataset refreshes without local Node.
//
//  ── Heuristics worth verifying after the first run (counts are logged) ──
//  • Amateur repeaters = LICENCE_TYPE_NAME ~ /amateur/i and
//    LICENCE_CATEGORY_NAME ~ /repeater/i, status current.
//  • A licence's transmitter device (DEVICE_TYPE ~ /^t/i) is the OUTPUT you
//    listen to; the receiver device (/^r/i) is the INPUT; offset = in − out.
//  • FREQUENCY is stored in Hz → divided by 1e6 for MHz.
//  If ACMA's field values differ from the above, adjust the filters below;
//  the per-stage counts printed to the log make drift easy to spot.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = process.argv[2] || 'spectra';
const OUT = join(__dirname, '..', 'data', 'repeaters-au.json');

// Minimal RFC-4180 CSV parser → array of row objects keyed by header.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.length > 1).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

// Find a CSV by case-insensitive base name (ACMA ships e.g. device_details.csv).
function loadTable(name) {
  const files = readdirSync(SRC_DIR);
  const match = files.find(f => f.toLowerCase() === `${name}.csv`)
             || files.find(f => f.toLowerCase().startsWith(name) && f.toLowerCase().endsWith('.csv'));
  if (!match) { console.warn(`  ! table ${name}.csv not found in ${SRC_DIR}`); return []; }
  const rows = parseCsv(readFileSync(join(SRC_DIR, match), 'utf8'));
  console.log(`  loaded ${match}: ${rows.length} rows`);
  return rows;
}

const hzToMhz = v => { const n = +v; return isFinite(n) && n > 0 ? +(n / 1e6).toFixed(4) : null; };
const isCurrent = s => /current|issued|in\s*force|granted/i.test(s || '');

console.log(`Reading ACMA spectra tables from ./${SRC_DIR}`);
const sites    = loadTable('site');
const devices  = loadTable('device_details');
const licences = loadTable('licence');
const clients  = loadTable('client');

const siteById = new Map(sites.map(s => [s.SITE_ID, s]));
const clientByNo = new Map(clients.map(c => [c.CLIENT_NO, c]));

// Amateur repeater licences.
const amateurRepeaters = new Map(); // LICENCE_NO → licence row
for (const l of licences) {
  if (/amateur/i.test(l.LICENCE_TYPE_NAME) &&
      /repeater/i.test(l.LICENCE_CATEGORY_NAME) &&
      isCurrent(l.STATUS_TEXT || l.STATUS)) {
    amateurRepeaters.set(l.LICENCE_NO, l);
  }
}
console.log(`Amateur repeater licences (current): ${amateurRepeaters.size}`);

// Group device records by licence.
const devicesByLicence = new Map();
for (const d of devices) {
  if (!amateurRepeaters.has(d.LICENCE_NO)) continue;
  if (!devicesByLicence.has(d.LICENCE_NO)) devicesByLicence.set(d.LICENCE_NO, []);
  devicesByLicence.get(d.LICENCE_NO).push(d);
}

const repeaters = [];
let skippedNoTx = 0, skippedNoSite = 0;
for (const [licNo, devs] of devicesByLicence) {
  const tx = devs.find(d => /^t/i.test(d.DEVICE_TYPE)) || devs[0];
  const rx = devs.find(d => /^r/i.test(d.DEVICE_TYPE));
  if (!tx) { skippedNoTx++; continue; }
  const site = siteById.get(tx.SITE_ID);
  const lat = site && +site.LATITUDE, lng = site && +site.LONGITUDE;
  if (!site || !isFinite(lat) || !isFinite(lng)) { skippedNoSite++; continue; }

  const outMhz = hzToMhz(tx.FREQUENCY || tx.CARRIER_FREQ);
  const inMhz  = rx ? hzToMhz(rx.FREQUENCY || rx.CARRIER_FREQ) : null;
  const client = clientByNo.get(amateurRepeaters.get(licNo).CLIENT_NO);

  repeaters.push({
    call: (tx.CALL_SIGN || '').trim() || null,
    name: (site.NAME || tx.STATION_NAME || '').trim() || (client?.LICENCEE || '').trim() || null,
    lat: +lat.toFixed(6),
    lng: +lng.toFixed(6),
    state: (site.STATE || '').trim() || null,
    outMhz,
    inMhz,
    offsetMhz: (outMhz != null && inMhz != null) ? +(inMhz - outMhz).toFixed(4) : null,
    antH: tx.HEIGHT ? +(+tx.HEIGHT).toFixed(1) : null,
    eirp: tx.EIRP ? `${tx.EIRP} ${tx.EIRP_UNIT || ''}`.trim() : null
  });
}

repeaters.sort((a, b) => (a.state || '').localeCompare(b.state || '') ||
                         (a.outMhz || 0) - (b.outMhz || 0));

console.log(`Built ${repeaters.length} repeaters (skipped: no-tx ${skippedNoTx}, no-site ${skippedNoSite})`);

const out = {
  generated: new Date().toISOString().slice(0, 10),
  source: 'ACMA Register of Radiocommunications Licences (CC BY 4.0)',
  attribution: 'Contains data sourced from the ACMA, licensed under CC BY 4.0.',
  count: repeaters.length,
  repeaters
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`Wrote ${OUT}`);
