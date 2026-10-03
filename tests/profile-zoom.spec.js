import { test, expect } from '@playwright/test';

// A 30 km link with a synthetic profile (ridge near the far end), so the
// profile can be drawn without fetching terrain.
async function setup(page){
  await page.goto('/index.html');
  await page.waitForFunction(() => S._ready && S._mapLayersReady);
  await page.evaluate(() => {
    closeHelp(); fetchElev = async () => {};
    const a = addNode(-27.0, 152.90), b = addNode(-27.27, 152.90);
    addEdge(a.id, b.id);
    const e = S.edges[0], N = 300, dist = haversine(a.lat, a.lng, b.lat, b.lng);
    const dists = Array.from({ length: N + 1 }, (_, i) => dist * i / N);
    const elevs = dists.map(d => 20 + 700 * Math.exp(-(((d - 27000) / 1500) ** 2)));
    e.profile = { elevs, dists, dist, aH: 22, bH: 745, a, b, freq: 146, K: 4 / 3, N, clutterH: null, clutterClass: null };
    // Real solver output, then forced to "budget OK but blocked".
    const res = RFModel.solve({ ...modelOptions(), dists, elevs, clutter: null, guess: null, antA: 2, antB: 30, clearA: 0, clearB: 0 });
    e.result = { ...res, ...linkBudgetFor(a, b, res.pathLossDb), status: 'clear', geometry: 'obstructed', requiredMarginDb: 6,
      marginRange: [5, 15], pathLossRange: [res.pathLossDb, res.pathLossDb, res.pathLossDb], provenance: 'test', canopy: 'off',
      terrainError: 5, clutterError: 5 };
    syncEdgesSource();
    selectEdgeView(e.id, { force: true });
  });
}

test('obstructed but workable links use the dashed layer', async ({ page }) => {
  await setup(page);
  await page.waitForFunction(() => S.map.getSource('edges-src').serialize().data.features?.length > 0);
  const props = await page.evaluate(() => S.map.getSource('edges-src').serialize().data.features[0].properties);
  expect(props.obstructed).toBe(true);
  expect(await page.evaluate(() => S.map.getLayer('edges-line-obstructed').filter)).toEqual(['get', 'obstructed']);
});

test('wheel zooms the profile about the pointer and FULL resets it', async ({ page }) => {
  await setup(page);
  const box = await page.locator('#profileCanvas').boundingBox();
  const total = await page.evaluate(() => S.profileHover.totalDist);
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
  for(let i = 0; i < 4; i++) await page.mouse.wheel(0, -100);
  const w = await page.evaluate(() => [S.profileHover.w0, S.profileHover.w1]);
  expect(w[1] - w[0]).toBeLessThan(total * 0.5);
  expect(w[0]).toBeGreaterThan(total * 0.3);                 // zoomed toward the pointer side
  await expect(page.locator('#btnProfileFull')).toBeVisible();
  // The zoomed stretch is outlined on the map.
  await page.waitForFunction(() => S.map.getSource('profile-window-src').serialize().data.features.length > 0);
  await page.locator('#btnProfileFull').click();
  expect(await page.evaluate(() => [S.profileHover.w0, S.profileHover.w1 - S.profileHover.totalDist])).toEqual([0, 0]);
  await expect(page.locator('#btnProfileFull')).toBeHidden();
});

test('dragging across the profile zooms to that stretch', async ({ page }) => {
  await setup(page);
  const box = await page.locator('#profileCanvas').boundingBox();
  const PAD = 46, pw = box.width - PAD - 12;
  await page.mouse.move(box.x + PAD + pw * 0.2, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + PAD + pw * 0.4, box.y + 60, { steps: 5 });
  await page.mouse.up();
  const r = await page.evaluate(() => [S.profileHover.w0 / S.profileHover.totalDist, S.profileHover.w1 / S.profileHover.totalDist]);
  expect(r[0]).toBeCloseTo(0.2, 1);
  expect(r[1]).toBeCloseTo(0.4, 1);
});

test('follow map shows only the part of the link on screen', async ({ page }) => {
  await setup(page);
  await page.locator('#btnFollowMap').click();
  await expect(page.locator('#btnFollowMap')).toHaveAttribute('aria-pressed', 'true');
  // Frame only the southern end of the link (the ridge end).
  await page.evaluate(() => S.map.jumpTo({ center: [152.90, -27.22], zoom: 12 }));
  await page.waitForFunction(() => S.profileHover && S.profileHover.w0 > 0);
  const r = await page.evaluate(() => [S.profileHover.w0 / S.profileHover.totalDist, S.profileHover.w1 / S.profileHover.totalDist]);
  expect(r[1] - r[0]).toBeLessThan(0.6);
  expect(r[1]).toBeGreaterThan(0.8);
  // A manual zoom turns following off.
  const box = await page.locator('#profileCanvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await expect(page.locator('#btnFollowMap')).toHaveAttribute('aria-pressed', 'false');
});
