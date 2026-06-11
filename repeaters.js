// ─────────────────────────────────────────────────────────────────────────
//  ClearPath Repeater Finder — standalone page (no dependency on the map app
//  beyond the shared share-codec). Lists amateur repeaters near a location
//  and opens a selection in ClearPath as a deep-link, with the RF frequency
//  set to the repeater's output band.
// ─────────────────────────────────────────────────────────────────────────
'use strict';

const state = { repeaters: [], meta: {}, sortKey: 'dist', sortDir: 1, selected: new Set() };
const $ = id => document.getElementById(id);

// ── Geometry ──
const R_EARTH = 6371000;
const toRad = d => d * Math.PI / 180;
function haversineKm(aLat, aLng, bLat, bLng) {
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return (R_EARTH * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s))) / 1000;
}
function bearingDeg(aLat, aLng, bLat, bLng) {
  const y = Math.sin(toRad(bLng - aLng)) * Math.cos(toRad(bLat));
  const x = Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
            Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLng - aLng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const compass = d => ['N','NE','E','SE','S','SW','W','NW'][Math.round(d / 45) % 8];
const bandOf = mhz => (mhz >= 30 && mhz < 300) ? 'vhf' : (mhz >= 300 && mhz < 3000) ? 'uhf' : null;

// ── RF defaults per band, mirroring ClearPath's ham VHF/UHF presets ──
function bandDefaults(mhz) {
  if (mhz >= 30 && mhz < 300)   return { tx: 37, gn: 0, rx: -120, mg: 6, cf: 0.4, cm: 50 }; // 2m VHF
  if (mhz >= 300 && mhz < 1000) return { tx: 37, gn: 0, rx: -120, mg: 6, cf: 0.4, cm: 30 }; // 70cm UHF
  return { tx: 22, gn: 2, rx: -130, mg: 6, cf: 0.4, cm: 50 };
}

function currentLocation() {
  const lat = parseFloat($('lat').value), lng = parseFloat($('lng').value);
  return (isFinite(lat) && isFinite(lng)) ? { lat, lng } : null;
}

// ── Deep-link into ClearPath ──
// Node 0 is "My location" (if set); each repeater follows, linked back to it so
// Analyse shows which links close. RF frequency is set to the (first) repeater's
// output band so ClearPath opens on the right frequency.
function buildHash(list) {
  const loc = currentLocation();
  const f = list.find(r => r.outMhz)?.outMhz || 146;
  const b = bandDefaults(f);
  const nodes = [];
  if (loc) nodes.push({ lat: loc.lat, lng: loc.lng, antH: 2, name: 'My location' });
  for (const r of list) {
    const label = `${r.call || 'RPT'}${r.outMhz ? ' ' + r.outMhz.toFixed(3) : ''}`.trim();
    nodes.push({ lat: r.lat, lng: r.lng, antH: r.antH || 10, name: label, coverageOn: true });
  }
  const edges = [];
  if (loc) list.forEach((_, i) => edges.push({ a: 0, b: i + 1, hidden: false }));
  const rf = {
    f, k: '1.333', tx: b.tx, gn: b.gn, rx: b.rx, mg: b.mg, ra: 2,
    cr: 360, cs: 50, cf: b.cf, cm: b.cm, co: 0, fh: 15, uh: 8, xe: 100, ca: 0.10
  };
  return 'index.html#' + CPShareCodec.encode({ rf, nodes, edges, paths: [] });
}

function openInClearPath(list) {
  if (!list.length) { alert('Select at least one repeater first.'); return; }
  window.open(buildHash(list), '_blank', 'noopener');
}

// ── Rendering ──
function visibleRepeaters() {
  const loc = currentLocation();
  const radius = parseFloat($('radius').value);
  let rows = state.repeaters.map(r => {
    const dist = loc ? haversineKm(loc.lat, loc.lng, r.lat, r.lng) : null;
    const brg = loc ? bearingDeg(loc.lat, loc.lng, r.lat, r.lng) : null;
    return { ...r, dist, brg };
  });
  if (loc && isFinite(radius) && radius > 0) rows = rows.filter(r => r.dist <= radius);
  const q = ($('search').value || '').trim().toLowerCase();
  if (q) rows = rows.filter(r => `${r.call || ''} ${r.name || ''}`.toLowerCase().includes(q));
  const band = $('band').value;
  if (band) rows = rows.filter(r => bandOf(r.outMhz) === band);
  const dir = state.sortDir;
  rows.sort((a, b) => {
    let av, bv;
    switch (state.sortKey) {
      case 'call':  av = a.call || ''; bv = b.call || ''; return av.localeCompare(bv) * dir;
      case 'out':   av = a.outMhz || 0; bv = b.outMhz || 0; break;
      case 'state': av = a.state || ''; bv = b.state || ''; return av.localeCompare(bv) * dir;
      default:      av = a.dist ?? Infinity; bv = b.dist ?? Infinity; // dist
    }
    return (av - bv) * dir;
  });
  return rows;
}

function rowKey(r) { return `${r.call}|${r.lat}|${r.lng}|${r.outMhz}`; }

function render() {
  const rows = visibleRepeaters();
  const loc = currentLocation();
  if (!state.repeaters.length) {
    $('list').innerHTML = '<div class="empty">No repeater data loaded.</div>';
    return;
  }
  const th = (key, label, cls = '') =>
    `<th class="${cls}${state.sortKey === key ? ' sorted' : ''}" data-sort="${key}">${label}${
      state.sortKey === key ? (state.sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  const head = `<tr>
    <th></th>
    ${th('call', 'Call')}
    ${th('out', 'Output', 'num')}
    <th class="num">Offset</th>
    ${th('state', 'State')}
    ${th('dist', 'Dist km', 'num')}
    <th>Brg</th>
    <th></th>
  </tr>`;
  const body = rows.map(r => {
    const k = rowKey(r);
    const checked = state.selected.has(k) ? 'checked' : '';
    const off = r.offsetMhz != null ? (r.offsetMhz > 0 ? '+' : '') + r.offsetMhz.toFixed(3) : '—';
    const dist = r.dist != null ? r.dist.toFixed(1) : '—';
    const brg = r.brg != null ? `${Math.round(r.brg)}° ${compass(r.brg)}` : '—';
    return `<tr>
      <td><input type="checkbox" data-k="${encodeURIComponent(k)}" ${checked}></td>
      <td>${r.call || '—'}<div style="font-size:11px;color:var(--muted)">${r.name || ''}</div></td>
      <td class="num">${r.outMhz != null ? r.outMhz.toFixed(4) : '—'}</td>
      <td class="num">${off}</td>
      <td>${r.state || '—'}</td>
      <td class="num">${dist}</td>
      <td>${brg}</td>
      <td><a class="open" href="${buildHash([r])}" target="_blank" rel="noopener">Open ▸</a></td>
    </tr>`;
  }).join('');
  $('list').innerHTML = `<div class="sub">${rows.length} repeater(s)${loc ? ' near you' : ' — set a location to sort by distance'}</div>
    <table><thead>${head}</thead><tbody>${body}</tbody></table>`;

  $('list').querySelectorAll('th[data-sort]').forEach(t => t.addEventListener('click', () => {
    const key = t.dataset.sort;
    if (state.sortKey === key) state.sortDir *= -1;
    else { state.sortKey = key; state.sortDir = 1; }
    render();
  }));
  $('list').querySelectorAll('input[type=checkbox][data-k]').forEach(cb => cb.addEventListener('change', () => {
    const k = decodeURIComponent(cb.dataset.k);
    if (cb.checked) state.selected.add(k); else state.selected.delete(k);
  }));
}

function selectedRepeaters() {
  return state.repeaters.filter(r => state.selected.has(rowKey(r)));
}

// ── Init ──
async function init() {
  try {
    const res = await fetch('data/repeaters-au.json', { cache: 'no-store' });
    const data = await res.json();
    state.repeaters = (data.repeaters || []).filter(r => isFinite(r.lat) && isFinite(r.lng));
    state.meta = data;
    if (data.sample || !state.repeaters.length) {
      const b = $('banner');
      b.hidden = false;
      b.textContent = data.note ||
        'Sample data. Run the "Build repeaters" GitHub Action to load the full ACMA dataset.';
    }
    $('attribution').innerHTML =
      `${data.attribution || 'Contains data sourced from the ACMA, licensed under CC BY 4.0.'}` +
      ` &nbsp;·&nbsp; <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>` +
      (data.generated ? ` &nbsp;·&nbsp; dataset ${data.generated}` : '');
  } catch (e) {
    $('list').innerHTML = `<div class="empty">Could not load repeater data: ${e.message}</div>`;
    return;
  }
  state.sortKey = 'call';
  render();

  $('btnLocate').addEventListener('click', () => {
    if (!navigator.geolocation) { alert('Geolocation not available.'); return; }
    navigator.geolocation.getCurrentPosition(p => {
      $('lat').value = p.coords.latitude.toFixed(4);
      $('lng').value = p.coords.longitude.toFixed(4);
      state.sortKey = 'dist'; state.sortDir = 1;
      render();
    }, err => alert('Location failed: ' + err.message));
  });
  ['lat', 'lng', 'radius', 'search'].forEach(id => $(id).addEventListener('input', render));
  $('band').addEventListener('change', render);
  $('btnOpenSelected').addEventListener('click', () => openInClearPath(selectedRepeaters()));
}

init();
