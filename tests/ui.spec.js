import { test, expect } from '@playwright/test';

async function ready(page){
  await page.goto('/index.html');
  await page.waitForFunction(() => S._ready);
  await page.evaluate(() => { closeHelp(); fetchElev = async () => {}; });
}

test('undo restores a deleted node and its link', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => { const a = addNode(-27.1, 152.9), b = addNode(-27.2, 153.0); addEdge(a.id, b.id); });
  await page.locator('.wp-del').first().click();
  expect(await page.evaluate(() => [S.nodes.length, S.edges.length])).toEqual([1, 0]);
  await page.locator('#toast .toast-act', { hasText: 'UNDO' }).click();
  expect(await page.evaluate(() => [S.nodes.length, S.edges.length, S.nodes[0].name])).toEqual([2, 1, 'Site 1']);
});

test('clear all from the ⋯ menu is undoable', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => { addNode(-27.1, 152.9); addNode(-27.2, 153.0); });
  await page.locator('#btnMore').click();
  await expect(page.locator('#moreMenu')).toBeVisible();
  await page.locator('#btnClearAll').click();
  await expect(page.locator('#moreMenu')).toBeHidden();
  expect(await page.evaluate(() => S.nodes.length)).toBe(0);
  await page.locator('#toast .toast-act').click();
  expect(await page.evaluate(() => S.nodes.length)).toBe(2);
});

test('the session is restored on the next visit', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => { const n = addNode(-27.1, 152.9); renameNode(n.id, 'Saved Hill'); renderNodeList(); });
  await page.waitForFunction(() => localStorage.getItem('clearpathSession'));
  await page.goto('/index.html');                                  // no #hash: a fresh visit
  await page.waitForFunction(() => S._ready);
  expect(await page.evaluate(() => S.nodes.map(n => n.name))).toEqual(['Saved Hill']);
  await expect(page.locator('#helpModal')).not.toHaveClass(/open/);
  await expect(page.locator('#toast')).toContainText('Restored your last session');
});

test('tap modes add and link nodes without right-click', async ({ page }) => {
  await ready(page);
  await page.locator('#btnAddMode').click();
  await expect(page.locator('#btnAddMode')).toHaveAttribute('aria-pressed', 'true');
  const map = page.locator('#map canvas');
  const box = await map.boundingBox();
  await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.4);
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.55);
  expect(await page.evaluate(() => S.nodes.length)).toBe(2);
  await page.locator('#btnConnectMode').click();
  await expect(page.locator('#btnAddMode')).toHaveAttribute('aria-pressed', 'false');
  const markers = page.locator('.node-marker-icon');
  await markers.nth(0).click();
  await expect(markers.nth(0)).toHaveClass(/picked/);
  await markers.nth(1).click();
  expect(await page.evaluate(() => S.edges.length)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#modeBar')).toBeHidden();
});

test('terrain profile resizes and floating controls follow it', async ({ page }) => {
  await ready(page);
  const handle = page.locator('#chartResize');
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + 4);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y - 96, { steps: 4 });
  await page.mouse.up();
  const h = await page.evaluate(() => document.querySelector('.chart-panel').offsetHeight);
  expect(h).toBeGreaterThan(280);
  expect(await page.evaluate(() => +localStorage.getItem('clearpathChartH'))).toBe(h);
  // The floating buttons slide (0.15 s transition); wait for them to settle.
  await expect.poll(async () => Math.abs(parseFloat(await page.evaluate(() => getComputedStyle(document.querySelector('.fab-group')).bottom)) - (h + 10))).toBeLessThan(1.5);
});

test('results show which canopy source a link used', async ({ page }) => {
  await ready(page);
  const html = await page.evaluate(() => [canopyTag('measured'), canopyTag('flat'), canopyTag('off')]);
  expect(html[0]).toContain('CANOPY: MEASURED');
  expect(html[1]).toContain('CANOPY: FLAT 15 m');
  expect(html[2]).toBe('');
});

test('phone layout docks the side panel under the map', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  const [map, side] = await Promise.all([page.locator('#map').boundingBox(), page.locator('.sidebar').boundingBox()]);
  expect(side.y).toBeGreaterThan(map.y);
  expect(side.width).toBeGreaterThan(380);
  await page.locator('#btnSidebarMin').click();
  await expect(page.locator('#btnSidebarExpand')).toBeVisible();
  const header = await page.locator('header').boundingBox();
  expect(header.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
