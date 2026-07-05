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

    await expect(page.locator('header h1')).toContainText('ClearPath');
    await expect(page.locator('#map')).toBeVisible();
    await expect(page.getByRole('button', { name: '+ NEW PATH' })).toBeVisible();

    // App globals + MapLibre map initialised.
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

  test('path visibility does not accidentally hide shared links', async ({ page }) => {
    const pageErrors = trackErrors(page);
    await page.goto('/index.html', { waitUntil: 'load' });

    const visibility = await page.evaluate(async () => {
      const St = window.S || S;
      // MapLibre's vector style loads asynchronously, unlike Leaflet's
      // near-instant raster init — wait for it before reading the edges-src
      // GeoJSON source below, or getSource() returns undefined.
      await new Promise(resolve => {
        const check = () => St._mapLayersReady ? resolve() : setTimeout(check, 20);
        check();
      });
      const a = addNode(-37.81, 144.96);
      const b = addNode(-37.79, 144.99);
      addEdge(a.id, b.id);
      const autoPath = St.paths[0];
      St.paths.push({ id: St.nextId++, name: 'Shared link path', hidden: false, nodeIds: [a.id, b.id] });

      setPathHidden(autoPath.id, true);
      const afterHide = {
        autoPathHidden: autoPath.hidden,
        sharedPathHidden: St.paths[1].hidden,
        edgeHidden: St.edges[0].hidden,
        edgeVisible: isEdgeVisible(St.edges[0])
      };

      const c = addNode(-37.83, 144.93);
      const d = addNode(-37.84, 144.94);
      const e = addNode(-37.85, 144.95);
      addEdge(c.id, d.id);
      addEdge(d.id, e.id);
      const multiPath = { id: St.nextId++, name: 'Multi-hop path', hidden: false, nodeIds: [c.id, d.id, e.id] };
      St.paths.push(multiPath);
      const multiEdges = pathEdges(multiPath);

      setEdgeHidden(multiEdges[0].id, true);
      const afterPartialLinkHide = { multiPathHidden: multiPath.hidden };

      setEdgeHidden(multiEdges[1].id, true);
      const afterAllLinkHide = { multiPathHidden: multiPath.hidden };

      hideAllPaths();
      const afterHideAll = {
        autoPathHidden: St.paths[0].hidden,
        sharedPathHidden: St.paths[1].hidden,
        edgeHidden: St.edges[0].hidden,
        edgeVisible: isEdgeVisible(St.edges[0])
      };

      showOnlyEdge(St.edges[0].id);
      // Edge styling is data-driven (see syncEdgesSource()/initMapLayers()):
      // 'selected' only turns on emphasis (line-width 6) when more than one
      // edge is visible, so with only one edge showing it should read false —
      // the equivalent of the old Leaflet weight staying at the base value (2).
      const selectedFeature = St.map.getSource('edges-src')._data.features
        .find(f => f.properties.id === St.edges[0].id);
      const selectedSingleEmphasis = selectedFeature.properties.selected;

      return { afterHide, afterPartialLinkHide, afterAllLinkHide, afterHideAll, selectedSingleEmphasis };
    });

    expect(visibility.afterHide).toEqual({
      autoPathHidden: true,
      sharedPathHidden: false,
      edgeHidden: false,
      edgeVisible: true
    });
    expect(visibility.afterPartialLinkHide).toEqual({ multiPathHidden: false });
    expect(visibility.afterAllLinkHide).toEqual({ multiPathHidden: true });
    expect(visibility.afterHideAll).toEqual({
      autoPathHidden: true,
      sharedPathHidden: true,
      edgeHidden: true,
      edgeVisible: false
    });
    expect(visibility.selectedSingleEmphasis).toBe(false);

    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  });

  test('coverage rays keep scanning after a near blocked sample', async ({ page }) => {
    const pageErrors = trackErrors(page);
    await page.goto('/index.html', { waitUntil: 'load' });

    const reachKm = await page.evaluate(async () => {
      document.getElementById('inpCovMaxKm').value = '10';
      document.getElementById('inpCovRays').value = '24';
      document.getElementById('inpCovSamples').value = '30';
      document.getElementById('inpCovFresnel').value = '0';

      const node = addNode(0, 0);
      node.elev = 0;
      node.antH = 6;
      node.coverageOn = true;

      const originalTileElevAt = tileElevAt;
      tileElevAt = async (lat, lng) => {
        const d = haversine(0, 0, lat, lng);
        if (d > 250 && d < 500) return 100;      // blocks the first short candidate
        if (d > 9000 && d < 11000) return 4000;  // farther high ground is clear
        return 0;
      };

      try {
        await _computeNodeCoverageImpl(node);
        return node.coverageReachMax / 1000;
      } finally {
        tileElevAt = originalTileElevAt;
      }
    });

    expect(reachKm).toBeGreaterThan(9);
    expect(pageErrors, `Uncaught page errors:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
