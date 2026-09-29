import {test,expect} from '@playwright/test';

test('analysed links show separate geometry, directional budgets and observations',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/index.html');await page.waitForFunction(()=>S._ready);
  const result=await page.evaluate(async()=>{
    closeHelp();document.getElementById('inpClutterOn').checked=false;
    tileElevAt=async()=>100;
    const a=addNode(-27.08598,152.927027),b=addNode(-27.077036,152.831577);
    a.name='Homing Bird';b.name='SunBird';a.antH=2;b.antH=2;
    b.rfOverride=true;b.txDbm=10;b.gainDbi=2;b.rxDbm=-130;b.cableDb=2;b.modem='LongFast';
    a.clearM=0;a.groundM=100;
    addEdge(a.id,b.id);await runAnalysis();
    const r=S.edges[0].result;
    importObservations({observations:[{from:'Homing Bird',to:'SunBird',timestamp:'2026-09-29T00:00:00Z',modem:'LongFast',frequencyMHz:915,success:true,snrDb:-4.5,rssiDbm:-110,split:'validation'}]});
    const decoded=parseSharedHash(buildShareHash());
    return {status:r.status,geometry:r.geometry,step:r.maxSpacing,ab:r.ab,ba:r.ba,range:r.marginRange,
      clearM:decoded.nodes[0].clearM,ground:decoded.nodes[0].groundM,cable:decoded.nodes[1].cableDb,
      model:decoded.model.propagation,sharedObservations:buildShareHash().includes('observations')};
  });
  expect(result.step).toBeLessThanOrEqual(20);
  expect(result.ab.prxDbm-result.ba.prxDbm).toBeCloseTo(12);
  expect(result.range[0]).toBeLessThanOrEqual(result.range.at(-1));
  expect(result.clearM).toBe(0);expect(result.ground).toBe(100);expect(result.cable).toBe(2);expect(result.model).toBe('bullington');
  await expect(page.locator('#resultsArea')).toContainText('Geometry:');
  await expect(page.locator('#resultsArea')).toContainText('1/1 recorded receptions');
  await expect(page.locator('#validationReport')).toContainText('validation RSSI: n=1');
  // Details remain usable without the parent selecting/redrawing the card.
  await page.locator('.link-details summary').click();await expect(page.locator('.link-details')).toHaveAttribute('open','');
  expect(errors).toEqual([]);
});

test('settings edits invalidate geometry and imported grid takes precedence',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/index.html');await page.waitForFunction(()=>S._ready);
  const r=await page.evaluate(async()=>{
    closeHelp();
    localTerrain=RFData.grid({type:'terrain-grid',source:'test survey',date:'2026-09-29',datum:'EGM96',rows:2,cols:2,north:-27,south:-28,west:152,east:153,elevations:[100,100,100,100]});
    const sampled=await tileElevAt(-27.5,152.5);
    const a=addNode(-27.5,152.5),b=addNode(-27.5,152.51);addEdge(a.id,b.id);await runAnalysis();
    const before=!!S.edges[0].result;
    document.getElementById('inpPropagation').value='los';onCoverageParamChanged();
    return {sampled,before,after:S.edges[0].result};
  });
  expect(r).toEqual({sampled:100,before:true,after:null});expect(errors).toEqual([]);
});

test('measurement import rejects invalid records without replacing existing data',async({page})=>{
  await page.goto('/index.html');await page.waitForFunction(()=>S._ready);
  const r=await page.evaluate(()=>{
    const o={from:'A',to:'B',timestamp:'2026-09-29T00:00:00Z',success:true,snrDb:-5};
    importObservations({observations:[o]});let rejected=false;
    try{importObservations({observations:[{...o,success:false}]});}catch{rejected=true;}
    const p=parseSharedHash(buildShareHash());
    return {count:observations.length,rejected,defaultClear:p.clutterExclude};
  });
  expect(r).toEqual({count:1,rejected:true,defaultClear:0});
});

test('adaptive coverage reports actual resolution and supports irregular rays',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/index.html');await page.waitForFunction(()=>S._ready);
  const result=await page.evaluate(async()=>{
    tileElevAt=async()=>0;
    document.getElementById('inpCovMaxKm').value=1;
    document.getElementById('inpCovRays').value=24;
    document.getElementById('inpAngularTarget').value=200;
    document.getElementById('inpAdaptive').checked=true;
    const node=addNode(-27,152);node.elev=0;node.antH=20;
    await _computeNodeCoverageImpl(node);
    const rays=node.coverageHeatRays;
    return {count:rays.length,quality:node.coverageQuality,
      atPoint:pointInCoverage(node,...destPoint(node.lat,node.lng,15,200)),
      sorted:rays.every((r,i)=>!i||r.az>rays[i-1].az)};
  });
  expect(result.count).toBeGreaterThan(24);expect(result.count).toBeLessThanOrEqual(720);
  expect(result.sorted).toBe(true);expect(result.atPoint).toBe(true);expect(result.quality).toContain('apart at the');expect(errors).toEqual([]);
});

test('mobile settings and project download/restore preserve data',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.goto('/index.html');await page.waitForFunction(()=>S._ready);
  await page.evaluate(()=>{
    closeHelp();tileElevAt=async()=>20;const n=addNode(-27,152);n.name='Homing';n.clearM=0;n.groundM=20;
    importObservations({observations:[{from:'Homing',to:'SunBird',timestamp:'2026-09-29T00:00:00Z',success:false}]});
    openSettings();
  });
  await page.getByRole('button',{name:'Measurements',exact:true}).click();
  const bounds=await page.locator('#settingsModal .modal').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(391);
  const downloadPromise=page.waitForEvent('download');
  await page.locator('#btnExportProject').click();const download=await downloadPromise;
  const file=await download.path();
  await page.evaluate(()=>clearAll());
  await page.locator('#projectFile').setInputFiles(file);
  await expect(page.locator('#dataMessage')).toContainText('Loaded');
  const restored=await page.evaluate(()=>({name:S.nodes[0].name,ground:S.nodes[0].groundM,count:observations.length,success:observations[0].success}));
  expect(restored).toEqual({name:'Homing',ground:20,count:1,success:false});
});
