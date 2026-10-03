import { test, expect } from '@playwright/test';
import { makeCog } from './helpers/make-cog.mjs';

// Mock R2: a manifest plus a COG per z9 quadkey, georeferenced to that tile's
// real Web Mercator bounds (coarse, so they're quick to build), served with Range.
const HALF = 20037508.342789244, TILE_M = 2 * HALF / 512;
function quadkeyXY(qk){
  let x = 0, y = 0;
  for(const d of qk){ x = x * 2 + (+d & 1); y = y * 2 + (+d >> 1); }
  return { x, y };
}
// Every z9 quadkey within ~1° of the test site (-27.14, 152.93).
const NEARBY = [];
for(let x = Math.floor((151.9 + 180) / 360 * 512); x <= Math.floor((153.9 + 180) / 360 * 512); x++){
  for(let lat = -28.4; lat <= -25.9; lat += 0.2){
    const r = lat * Math.PI / 180, y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 512);
    let qk = '';
    for(let i = 9; i > 0; i--){ const m = 1 << (i - 1); qk += ((x & m) ? 1 : 0) + ((y & m) ? 2 : 0); }
    if(!NEARBY.includes(qk)) NEARBY.push(qk);
  }
}
const cogs = new Map();
function cogFor(qk){
  if(!cogs.has(qk)){
    const { x, y } = quadkeyXY(qk);
    cogs.set(qk, makeCog({
      originX: -HALF + x * TILE_M, originY: HALF - y * TILE_M, res: TILE_M / 1024,
      levels: [
        { w: 1024, h: 1024, tile: 256, pixel: (c, r) => (c + r) % 97 === 0 ? 0 : 52 },
        { w: 512, h: 512, tile: 256, pixel: () => 52 }
      ]
    }));
  }
  return cogs.get(qk);
}

async function mockStore(page, { publish = () => true } = {}){
  const log = [];
  await page.route('https://canopy.nbird.com.au/**', async route => {
    const url = new URL(route.request().url());
    const cors = { 'access-control-allow-origin': '*' };
    if(url.pathname === '/manifest.json'){
      const tiles = {};
      for(const qk of NEARBY) if(publish(qk)) tiles[qk] = { path: `tiles/${qk}/20261003T000000Z.tif`, build: 'max4-ovrms-u8' };
      return route.fulfill({ json: { format: 'cog-u8', generated: 'g1', tiles }, headers: cors });
    }
    const m = /^\/tiles\/([0-3]{9})\//.exec(url.pathname);
    if(!m) return route.fulfill({ status: 404, headers: cors });
    const body = cogFor(m[1]);
    const r = /bytes=(\d+)-(\d+)/.exec(route.request().headers()['range'] || '');
    log.push(r ? r[0] : 'full');
    if(!r) return route.fulfill({ body, headers: cors });
    const s = +r[1], e = Math.min(+r[2], body.length - 1);
    return route.fulfill({ status: 206, body: body.subarray(s, e + 1),
      headers: { ...cors, 'content-range': `bytes ${s}-${e}/${body.length}` } });
  });
  return log;
}

const grid = (page, km, step) => page.evaluate(async ([km, step]) => {
  const lat = -27.14, lng = 152.93, d = metresToDegrees(lat, km * 1000);
  const g = await buildCanopyGrid(lat - d.dLat, lng - d.dLng, lat + d.dLat, lng + d.dLng, step);
  return g && { tiles: g.tiles, spacing: g.spacingM, h: g.heightAt(lat, lng), note: g.note, prov: clutterProvenance(null, g) };
}, [km, step]);

test('canopy COG: coverage-sized grid reads whole metres via Range, then from memory', async ({ page }) => {
  const log = await mockStore(page);
  await page.goto('/index.html');
  const r = await grid(page, 50, 20);
  if(!r) console.log(await page.evaluate(() => S.debugLog.map(e => e.msg).join(' | ')));
  expect(r).not.toBeNull();
  expect(r.h).toBe(52);                      // above the old 40 m PNG ceiling
  expect(r.tiles).toBeGreaterThan(1);
  expect(r.note).toContain('max4-ovrms-u8');
  expect(log.every(x => x !== 'full')).toBe(true);
  const n = log.length;
  await grid(page, 50, 20);
  expect(log.length).toBe(n);                // decoded tiles reused, no new requests
});

test('canopy COG: an unpublished tile falls back to flat Forest(m)', async ({ page }) => {
  await mockStore(page, { publish: qk => qk !== '311213001' });
  await page.goto('/index.html');
  expect(await grid(page, 2, 20)).toBeNull();
});
