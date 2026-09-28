import test from 'node:test';
import assert from 'node:assert/strict';
import '../js/rf-model.js';
import '../js/rf-data.js';
const M=globalThis.RFModel,D=globalThis.RFData;
const close=(a,b,eps=1e-6)=>assert.ok(Math.abs(a-b)<eps,`${a} != ${b}`);
const flat={dists:[0,500,1000],elevs:[0,0,0],antA:100,antB:100,freq:1000,K:4/3};
test('free-space, Fresnel and grazing knife edge reference values',()=>{
  close(M.fspl(1000,1000),92.44);
  close(M.fresnel(500,500,1000),8.657258,1e-5);
  close(M.knife(0),6.032852208563606);
  assert.equal(M.knife(-1),0);
  const r=M.solve(flat);close(r.pathLossDb,92.44);assert.equal(r.geometry,'clear');
});
test('Bullington equations 50–57 independently calculated fixture',()=>{
  // Flat-earth limit; A=10 m, B=20 m. Hills (d,h)=(1 km,50 m),(3 km,60 m).
  // Stim=40 m/km; Srim=40 m/km; db=(20-10+40*4)/80=2.125 km.
  // Bullington height=95 m; direct ray=15.3125 m; lambda=0.299792458 m.
  const nu=(95-15.3125)*Math.sqrt(.002*4/(.299792458*2.125*1.875));
  const luc=6.9+20*Math.log10(Math.sqrt((nu-.1)**2+1)+nu-.1);
  const expected=luc+(1-Math.exp(-luc/6))*(10+.02*4);
  const r=M.solve({dists:[0,1000,3000,4000],elevs:[0,50,60,0],antA:10,antB:20,freq:1000,K:1e15});
  close(r.diffLossDb,expected);assert.ok(r.nlos);
});
test('reciprocity for multiple ridges and nonuniform spacing, including clutter',()=>{
  const p={dists:[0,40,100,450,1200,1500],elevs:[10,12,28,60,35,17],clutter:[8,7,5,0,9,8],antA:2,antB:6,freq:915,K:1.333};
  for(const clutterMode of ['geometry','terminal']){
    const f=M.solve({...p,clutterMode});
    const reverse={...p,clutterMode,dists:p.dists.map(x=>1500-x).reverse(),elevs:[...p.elevs].reverse(),clutter:[...p.clutter].reverse(),antA:p.antB,antB:p.antA};
    close(f.pathLossDb,M.solve(reverse).pathLossDb);
  }
});
test('directional budgets include cable losses and receiver-specific noise/sensitivity',()=>{
  const a={tx:22,gain:2,rx:-130,cable:1,modem:'LongFast',nf:6};
  const b={tx:10,gain:5,rx:-110,cable:2,modem:'LongFast',nf:8,noiseDbm:-105};
  const r=M.budget(a,b,120);
  close(r.ab.prxDbm,-94);close(r.ba.prxDbm,-106);
  close(r.ab.marginDb,16);close(r.ba.marginDb,24);close(r.marginDb,16);
  close(r.ab.snrDb,11);assert.equal(r.ab.noiseMeasured,true);
  assert.equal(M.budget(a,{...b,modem:'MediumFast'},120).compatible,false);
});
test('coverage and link agree for every prefix, receiver clutter and RF asymmetry',()=>{
  const p={dists:[0,20,40,60,80,100,120,140,160,180,200],elevs:[0,0,0,4,9,3,0,0,2,3,3],clutter:Array(11).fill(10),freq:915,K:1.333,clutterMode:'terminal'};
  const a={antH:2,tx:22,gain:2,rx:-130,cable:1,clearM:0},b={antH:3,tx:10,gain:0,rx:-120,cable:2,clearM:20};
  const margins=M.coverageRay(p,a,b,6);
  for(let i=1;i<p.dists.length;i++){
    const link=M.solve({...p,dists:p.dists.slice(0,i+1),elevs:p.elevs.slice(0,i+1),clutter:p.clutter.slice(0,i+1),antA:a.antH,antB:b.antH,clearA:0,clearB:20});
    close(margins[i],M.budget(a,b,link.pathLossDb).marginDb-6);
  }
});
test('strict LOS and diffraction modes explicitly differ for an obstructed path',()=>{
  const p={...flat,antA:2,antB:2,elevs:[0,80,0]};
  assert.equal(M.solve({...p,mode:'los'}).pathLossDb,Infinity);
  assert.ok(Number.isFinite(M.solve(p).pathLossDb));
  assert.ok(M.solve(p).diffLossDb>M.solve({...p,mode:'knife'}).diffLossDb);
});
test('sampling convergence on a smooth ridge and narrow obstruction capture',()=>{
  function path(step){const dists=Array.from({length:2000/step+1},(_,i)=>i*step);return {...flat,antA:10,antB:10,dists,elevs:dists.map(x=>70*Math.exp(-(((x-947)/65)**2)))};}
  const a=M.solve(path(20)),b=M.solve(path(10)),c=M.solve(path(5));
  assert.ok(Math.abs(b.pathLossDb-c.pathLossDb)<.1);
  assert.ok(Math.abs(a.pathLossDb-c.pathLossDb)<.5);
  const coarse={...path(100),elevs:path(100).dists.map(x=>Math.abs(x-950)<20?90:0)};
  const fine={...path(10),elevs:path(10).dists.map(x=>Math.abs(x-950)<20?90:0)};
  assert.ok(M.solve(fine).diffLossDb>M.solve(coarse).diffLossDb+10);
});
test('near endpoint clutter counts unless a clearing is explicitly supplied',()=>{
  const p={...flat,dists:[0,20,100,500,1000],elevs:[0,0,0,0,0],antA:2,antB:100,clutter:[0,20,0,0,0]};
  assert.ok(M.solve(p).pathLossDb>M.solve({...p,clearA:30}).pathLossDb);
  assert.equal(M.terminalLoss(2,15,5800),null);
  const r=M.solve({...p,clutterMode:'terminal',freq:5800});
  assert.ok(r.warnings.some(x=>x.includes('outside')));
  close(r.pathLossDb,M.solve({...p,freq:5800}).pathLossDb);
});
test('guessed tree heights near an end are unknown, not walls, in both clutter modes',()=>{
  const dists=Array.from({length:51},(_,i)=>i*20),elevs=dists.map(()=>0);
  // Tree pixels only beside each end (within 100 m); open ground between.
  const nearEnd=dists.map(d=>d<=100||1000-d<=100);
  const clutter=nearEnd.map(t=>t?15:0),guess=nearEnd;
  for(const clutterMode of ['geometry','terminal']){
    const p={dists,elevs,clutter,antA:2,antB:2,freq:915,K:4/3,clutterMode};
    const guessed=M.solve({...p,guess}),measured=M.solve(p);
    assert.ok(guessed.pathLossDb<measured.pathLossDb-10,`${clutterMode}: ${guessed.pathLossDb} vs ${measured.pathLossDb}`);
    assert.equal(guessed.termLossDb,0);
  }
  // Guessed heights away from both ends still count.
  const mid=dists.map((d)=>d>200&&d<800);
  const r=M.solve({dists,elevs,clutter:dists.map(()=>0).map((_,i)=>mid[i]?15:0),guess:mid,antA:2,antB:2,freq:915});
  assert.ok(r.surfaceBlocked);
});
test('adaptive angular refinement notices wide gaps and reception boundaries',()=>{
  const a={az:0,samples:[{marginDb:Infinity},{marginDb:5}]},b={az:1,samples:[{marginDb:Infinity},{marginDb:5}]};
  assert.equal(M.refineSector(a,b,25000,250),true);
  assert.equal(M.refineSector(a,b,1000,250),false);
  b.samples[1].marginDb=-1;assert.equal(M.refineSector(a,b,1000,250),true);
});
test('trace direction, timestamps, failures and split are preserved',()=>{
  const raw={nodeNameMap:{A:'Homing'},traces:[{timestamp:'2026-09-29T10:00:00+10:00',modem:'LongFast',frequencyMHz:915,
    forward:[{node:'A'},{node:'B',snrDb:-4.5}],reverse:[{node:'B'},{node:'A',snrDb:-5}]}]};
  const rows=D.observations(raw);assert.equal(rows.length,2);assert.equal(rows[0].from,'Homing');assert.equal(rows[1].to,'Homing');
  assert.equal(rows[0].snrDb,-4.5);assert.equal(rows[1].snrDb,-5);assert.equal(rows[0].timestamp,'2026-09-29T00:00:00.000Z');
  assert.equal(rows[0].split,'validation');
  const unknown=D.observations([{from:'A',to:'B',timestamp:'2026-09-29T00:00:00Z',success:false}]);
  assert.deepEqual(D.observations({observations:JSON.parse(JSON.stringify(unknown))}),unknown);
  assert.throws(()=>D.observations([{...rows[0],success:false,snrDb:-5}]));
  assert.throws(()=>D.observations([{...rows[0],timestamp:'yesterday'}]));
  close(D.metrics([2,-2,4]).mae,8/3);
});
test('local DEM interpolation and explicit nodata fallback',()=>{
  const g=D.grid({type:'terrain-grid',source:'survey',date:'2026-09-29',datum:'EGM96',rows:2,cols:2,north:1,south:0,west:0,east:1,elevations:[0,10,20,30]});
  close(D.gridAt(g,.5,.5),15);close(D.gridAt(g,0,1),30);assert.equal(D.gridAt(g,2,2),null);
  assert.equal(D.gridAt({...g,elevations:[0,null,20,30]},.5,.5),null);
  assert.throws(()=>D.grid({...g,elevations:[0]}));
});
