import test from 'node:test';
import assert from 'node:assert/strict';
import '../js/canopy-cog.js';
import { makeCog, rangeFetch, mercX, mercY } from './helpers/make-cog.mjs';
const C = globalThis.CanopyCOG;

// 64×64 px at 10 m (Mercator) plus a 32×32 overview at 20 m; 16-px tiles.
const lat0 = -27, lng0 = 153;
const opts = (extra = {}) => ({
  originX: mercX(lng0), originY: mercY(lat0), res: 10,
  levels: [
    { w: 64, h: 64, tile: 16, pixel: (c, r) => (c * 3 + r * 7) % 251 },
    { w: 32, h: 32, tile: 16, pixel: (c, r) => 200 + (c + r) % 50 }
  ],
  ...extra
});
const lonOf = c => (opts().originX + (c + 0.5) * 10) / 6378137 * 180 / Math.PI;
const latOf = r => (2 * Math.atan(Math.exp((opts().originY - (r + 0.5) * 10) / 6378137)) - Math.PI / 2) * 180 / Math.PI;
const bbox = (c0, r0, c1, r1) => ({ west: lonOf(c0), east: lonOf(c1), north: latOf(r0), south: latOf(r1) });

function setup(files){
  const log = [];
  C.reset();
  C.configure({ fetch: rangeFetch(files, log), persistentCache: false });
  return log;
}

for(const [name, extra] of [['classic deflate+predictor', {}], ['BigTIFF', { bigtiff: true }], ['uncompressed', { compress: false, predictor: 1 }]]){
  test(`reads exact pixels at full resolution (${name})`, async () => {
    setup({ 'u.tif': makeCog(opts(extra)) });
    const s = await C.sampler('u.tif', bbox(0, 0, 63, 63), 5);
    assert.equal(s.level, 0);
    for(const [c, r] of [[0, 0], [5, 9], [17, 33], [63, 63], [40, 2]]){
      assert.equal(s.heightAt(latOf(r), lonOf(c)), (c * 3 + r * 7) % 251, `pixel ${c},${r}`);
    }
  });
}

test('picks the coarsest overview that still resolves the step', async () => {
  setup({ 'o.tif': makeCog(opts()) });
  const cos = Math.cos(lat0 * Math.PI / 180);
  const s = await C.sampler('o.tif', bbox(0, 0, 63, 63), 20 * cos + 0.1);
  assert.equal(s.level, 1);
  assert.equal(s.heightAt(latOf(0), lonOf(0)), 200);
  const fine = await C.sampler('o.tif', bbox(0, 0, 63, 63), 20 * cos - 0.1);
  assert.equal(fine.level, 0);
});

test('reads only the tiles under the bbox, merging adjacent ranges', async () => {
  const log = setup({ 'm.tif': makeCog(opts()) });
  const s = await C.sampler('m.tif', bbox(18, 18, 45, 28), 5);   // tile cols 1–2, rows 1
  assert.equal(s.tiles, 2);
  const tileReads = log.filter(([, start]) => start > 0);
  assert.equal(tileReads.length, 1, 'adjacent tiles fetched in one request');
  assert.ok(Number.isNaN(s.heightAt(latOf(60), lonOf(60))), 'outside the bbox is NaN');
  log.length = 0;
  await C.sampler('m.tif', bbox(18, 18, 45, 28), 5);
  assert.equal(log.length, 0, 'second read served from memory');
});

test('nodata maps to NaN; outside the raster is NaN', async () => {
  setup({ 'n.tif': makeCog(opts({ nodata: 0 })) });
  const s = await C.sampler('n.tif', bbox(0, 0, 63, 63), 5);
  assert.ok(Number.isNaN(s.heightAt(latOf(0), lonOf(0))));        // pixel value 0
  assert.ok(Number.isNaN(s.heightAt(latOf(0), lonOf(-5))));
});

test('rejects non-TIFF and missing files', async () => {
  setup({ 'bad.tif': Buffer.from('hello world, not a tiff') });
  await assert.rejects(C.sampler('bad.tif', bbox(0, 0, 1, 1), 5), /not a TIFF/);
  await assert.rejects(C.sampler('nope.tif', bbox(0, 0, 1, 1), 5), /HTTP 404/);
});
