import { test, expect } from '@playwright/test';

// These smoke tests guard against the "one typo breaks the whole app" failure
// mode: everything is inline JS deployed straight to GitHub Pages. We gate on
// *uncaught* page errors (real code breakage). Console errors are logged but
// not failed on, because external map/terrain tiles can flake and emit console
// noise that is not a bug in our code.

function trackErrors(page) {
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  return pageErrors;
}

test.describe('RF LOS Planner — smoke', () => {
  test('loads cleanly and core UI is present', async ({ page }) => {
    const pageErrors = trackErrors(page);
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/index.html', { waitUntil: 'load' });

    await expect(page.locator('header h1')).toContainText('Line of Sight');
    await expect(page.locator('#map')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ NEW PATH' })).toBeVisible();

    // App globals + Leaflet map initialised.
    const ready = await page.evaluate(
      () => typeof addNode === 'function' && typeof addEdge === 'function' && !!(window.S || S).map
    );
    expect(ready).toBe(true);

    if (consoleErrors.length) {
      console.log('Console errors (non-fatal):\n' + consoleErrors.join('\n'));
    }
    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  });

  test('linking nodes makes standalone paths; path builder opens with all nodes', async ({ page }) => {
    const pageErrors = trackErrors(page);
    await page.goto('/index.html', { waitUntil: 'load' });

    // Two linked nodes -> one auto-created standalone 2-node path.
    const counts = await page.evaluate(() => {
      const a = addNode(-37.81, 144.96);
      const b = addNode(-37.79, 144.99);
      addEdge(a.id, b.id);
      const St = window.S || S;
      return { nodes: St.nodes.length, edges: St.edges.length, paths: St.paths.length };
    });
    expect(counts).toEqual({ nodes: 2, edges: 1, paths: 1 });

    // Regression guard for the "new links never auto-join" change: a third node
    // linked to an existing path endpoint must create its OWN path.
    const afterThird = await page.evaluate(() => {
      const St = window.S || S;
      const firstNodeId = St.nodes[0].id;
      const c = addNode(-37.83, 144.93);
      addEdge(c.id, firstNodeId);
      return { nodes: St.nodes.length, edges: St.edges.length, paths: St.paths.length };
    });
    expect(afterThird).toEqual({ nodes: 3, edges: 2, paths: 2 });

    // Path builder modal opens and lists every node as selectable.
    await page.getByRole('button', { name: '+ NEW PATH' }).click();
    await expect(page.locator('#pathModal')).toBeVisible();
    await expect(page.locator('#pbNodeList .pb-node')).toHaveCount(3);

    // Esc closes it (shared modal Esc handler).
    await page.keyboard.press('Escape');
    await expect(page.locator('#pathModal')).toBeHidden();

    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
