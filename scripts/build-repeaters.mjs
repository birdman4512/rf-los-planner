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
//  No npm dependencies — pure Node (>=18). The tables are large (device_details
//  has millions of rows), so we STREAM each file line-by-line and keep only the
//  amateur-repeater subset in memory rather than loading whole tables.
//
//  CSV assumption: no fields contain embedded newlines (true for ACMA spectra),
//  so one record per line. Commas/quotes within a line are handled.
//
//  ── Heuristics worth verifying after the first run (counts are logged) ──
//  • Amateur repeaters = LICENCE_TYPE_NAME ~ /amateur/i and
//    LICENCE_CATEGORY_NAME ~ /repeater/i, status current.
//  • A licence's transmitter device (DEVICE_TYPE ~ /^t/i) is the OUTPUT you
//    listen to; the receiver (/^r/i) is the INPUT; offset = in − out.
//  • FREQUENCY is stored in Hz → divided by 1e6 for MHz.
//  If ACMA's values differ, adjust the filters below; the per-stage counts
//  printed to the log make drift easy to spot.
// ─────────────────────────────────────────────────────────────────────────
import { createReadStream, writeFileSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = process.argv[2] || 'spectra';
const OUT = join(__dirname, '..', 'data', 'repeaters-au.json');

// Split one CSV line into fields (handles quoted fields, commas, "" escapes).
function splitCsvLine(line) {
  const out = [];
  let field = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

// Locate a table CSV by case-insensitive base name (ACMA: device_details.csv …).
function findFile(name) {
  const files = readdirSync(SRC_DIR);
  const match = files.find(f => f.toLowerCase() === `${name}.csv`)
             || files.find(f => f.toLowerCase().startsWith(name) && f.toLowerCase().endsWith('.csv'));
  return match ? join(SRC_DIR, match) : null;
}

// Stream a CSV, calling onRow(fields, idx) per data row. idx maps COLUMN→index.
// Returns the row count. Keeps no rows in memory itself.
async function streamCsv(name, onRow) {
  const path = findFile(name);
  if (!path) { console.warn(`  ! table ${name}.csv not found in ${SRC_DIR}`); return 0; }
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  let idx = null, count = 0;
  for await (const line of rl) {
    if (!line) continue;
    const fields = splitCsvLine(line);
    if (!idx) { idx = {}; fields.forEach((h, i) => { idx[h.trim()] = i; }); continue; }
    count++;
    onRow(fields, idx);
  }
  console.log(`  streamed ${name}.csv: ${count} rows`);
  return count;
}

const col = (f, idx, name) => (idx[name] != null ? (f[idx[name]] || '') : '');
const hzToMhz = v => { const n = +v; return isFinite(n) && n > 0 ? +(n / 1e6).toFixed(4) : null; };
const isCurrent = s => /current|issued|in\s*force|granted/i.test(s || '');

console.log(`Reading ACMA spectra tables from ./${SRC_DIR}`);

// 1. Amateur repeater licences → set of LICENCE_NO + their CLIENT_NO.
const clientOfLicence = new Map();
await streamCsv('licence', (f, idx) => {
  const type = col(f, idx, 'LICENCE_TYPE_NAME');
  const cat = col(f, idx, 'LICENCE_CATEGORY_NAME');
  const status = col(f, idx, 'STATUS_TEXT') || col(f, idx, 'STATUS');
  if (/amateur/i.test(type) && /repeater/i.test(cat) && isCurrent(status)) {
    clientOfLicence.set(col(f, idx, 'LICENCE_NO'), col(f, idx, 'CLIENT_NO'));
  }
});
console.log(`Amateur repeater licences (current): ${clientOfLicence.size}`);

// 2. Device records for those licences only (the heavy table — filtered hard).
const devOfLicence = new Map();   // LICENCE_NO → [device rec]
const neededSites = new Set();
await streamCsv('device_details', (f, idx) => {
  const lic = col(f, idx, 'LICENCE_NO');
  if (!clientOfLicence.has(lic)) return;
  const site = col(f, idx, 'SITE_ID');
  if (site) neededSites.add(site);
  const rec = {
    type: col(f, idx, 'DEVICE_TYPE'),
    freq: col(f, idx, 'FREQUENCY') || col(f, idx, 'CARRIER_FREQ'),
    site,
    call: col(f, idx, 'CALL_SIGN').trim(),
    station: col(f, idx, 'STATION_NAME').trim(),
    height: col(f, idx, 'HEIGHT'),
    eirp: col(f, idx, 'EIRP'),
    eirpUnit: col(f, idx, 'EIRP_UNIT')
  };
  if (!devOfLicence.has(lic)) devOfLicence.set(lic, []);
  devOfLicence.get(lic).push(rec);
});

const neededClients = new Set(clientOfLicence.values());

// 3. Sites and clients — keep only the ones referenced above.
const siteById = new Map();
await streamCsv('site', (f, idx) => {
  const id = col(f, idx, 'SITE_ID');
  if (!neededSites.has(id)) return;
  siteById.set(id, {
    lat: +col(f, idx, 'LATITUDE'), lng: +col(f, idx, 'LONGITUDE'),
    name: col(f, idx, 'NAME').trim(), state: col(f, idx, 'STATE').trim()
  });
});
const licenceeByClient = new Map();
await streamCsv('client', (f, idx) => {
  const id = col(f, idx, 'CLIENT_NO');
  if (!neededClients.has(id)) return;
  licenceeByClient.set(id, col(f, idx, 'LICENCEE').trim());
});

// 4. Build repeater records: transmitter = output (listen), receiver = input.
const repeaters = [];
let skippedNoTx = 0, skippedNoSite = 0;
for (const [lic, devs] of devOfLicence) {
  const tx = devs.find(d => /^t/i.test(d.type)) || devs[0];
  const rx = devs.find(d => /^r/i.test(d.type));
  if (!tx) { skippedNoTx++; continue; }
  const site = siteById.get(tx.site);
  if (!site || !isFinite(site.lat) || !isFinite(site.lng)) { skippedNoSite++; continue; }
  const outMhz = hzToMhz(tx.freq);
  const inMhz = rx ? hzToMhz(rx.freq) : null;
  repeaters.push({
    call: tx.call || null,
    name: site.name || tx.station || licenceeByClient.get(clientOfLicence.get(lic)) || null,
    lat: +site.lat.toFixed(6),
    lng: +site.lng.toFixed(6),
    state: site.state || null,
    outMhz,
    inMhz,
    offsetMhz: (outMhz != null && inMhz != null) ? +(inMhz - outMhz).toFixed(4) : null,
    antH: tx.height ? +(+tx.height).toFixed(1) : null,
    eirp: tx.eirp ? `${tx.eirp} ${tx.eirpUnit || ''}`.trim() : null
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
