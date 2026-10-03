// UI/data adapters for the pure model. User measurements stay local and are
// included only in an explicitly downloaded project, never in a share URL.
let observations=[];
let localTerrain=null;
let coverageWorker=null,workerSequence=0;
function optionalNumber(value,min,max){
  if(value==null||String(value).trim()==='') return null;
  const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):null;
}
function modelOptions(){
  const g=globalRf();
  return {freq:g.freq,K:g.K,mode:g.mode,clutterMode:g.clutterMode,atten:g.clutterAttenRef,cap:g.clutterCapDb,fresnelPct:g.fresnelPct};
}
// User-supplied site clutter heights are measurements, so they also clear the
// matching entries of the optional guess mask.
function applySiteClutter(h,dists,a,b,guess=null){
  if(!h && a?.clutterM==null && b?.clutterM==null) return null;
  const result=h?[...h]:dists.map(()=>0),D=dists.at(-1);
  for(let i=0;i<result.length;i++){
    if(a?.clutterM!=null && dists[i]<=100){ result[i]=a.clutterM; if(guess) guess[i]=false; }
    if(b?.clutterM!=null && D-dists[i]<=100){ result[i]=b.clutterM; if(guess) guess[i]=false; }
  }
  return result;
}
function solveCoverageWorker(profile,a,b,margin){
  if(typeof Worker==='undefined') return Promise.resolve(RFModel.coverageRay(profile,a,b,margin));
  if(!coverageWorker) coverageWorker=new Worker('js/rf-worker.js?v=20261004-02');
  const worker=coverageWorker,id=++workerSequence;
  return new Promise((resolve,reject)=>{
    const cleanup=()=>{worker.removeEventListener('message',message);worker.removeEventListener('error',error);};
    const message=({data})=>{if(data.id!==id)return;cleanup();data.error?reject(new Error(data.error)):resolve(data.margins);};
    const error=e=>{cleanup();worker.terminate();coverageWorker=null;reject(new Error(e.message||'Coverage worker failed'));};
    worker.addEventListener('message',message);worker.addEventListener('error',error);
    worker.postMessage({id,profile,a,b,margin});
  });
}
function invalidateAllAnalysis(){
  S.modelRevision=(S.modelRevision||0)+1;
  S.edges.forEach(e=>{e.result=null;e.profile=null;});
  S.profileCache={};S.elevCache={};
  clearCanvas();renderResults();syncEdgesSource();renderEdgesPanel();renderPathsPanel();
}
function modemOptions(value){
  return `<option value="" ${value?'':'selected'}>None</option>`+Object.keys(RFModel.MODEMS).map(k=>`<option value="${k}" ${k===value?'selected':''}>${k}</option>`).join('');
}
function setSiteMeasurement(node,key,value){
  node[key]=optionalNumber(value,key==='groundM'?-12000:0,key==='groundM'?10000:key==='clearM'?5000:200);
  if(key==='groundM')fetchElev(node);
  invalidateEdgesForNode(node.id);invalidateNodeCoverage(node,true);renderNodeList();
}
function setExtraRadio(node,key,value){
  if(key==='noiseDbm')node[key]=optionalNumber(value,-200,0);
  else if(key==='modem'){
    node.modem=Object.hasOwn(RFModel.MODEMS,value)?value:'';
    if(node.modem)node.rxDbm=RFModel.sensitivity(node.modem,node.noiseFigure??globalRf().nf);
  }else node.hardware=String(value).slice(0,120);
  invalidateNodeCoverage(node,true);refreshLinkBudgets();renderNodeList();
}
const MODEL_FIELDS={cable:'inpCable',nf:'inpNoiseFigure',noise:'inpNoiseFloor',propagation:'inpPropagation',clutterMode:'inpClutterMode',terrainError:'inpTerrainError',clutterError:'inpClutterError',angularTarget:'inpAngularTarget'};
function serializeModelSettings(){const r={};for(const [k,id]of Object.entries(MODEL_FIELDS))r[k]=document.getElementById(id).value;r.adaptive=document.getElementById('inpAdaptive').checked;return r;}
function normaliseModelSettings(r={}){
  r=r&&typeof r==='object'?r:{};
  return {cable:optionalNumber(r.cable,0,100)??0,nf:optionalNumber(r.nf,0,30)??6,noise:optionalNumber(r.noise,-200,0),
    propagation:['bullington','knife','los'].includes(r.propagation)?r.propagation:'bullington',
    clutterMode:r.clutterMode==='terminal'?'terminal':'geometry',terrainError:optionalNumber(r.terrainError,0,100)??5,
    clutterError:optionalNumber(r.clutterError,0,100)??5,angularTarget:optionalNumber(r.angularTarget,25,5000)??250,adaptive:r.adaptive!==false};
}
function restoreModelSettings(raw){const r=normaliseModelSettings(raw);for(const [k,id]of Object.entries(MODEL_FIELDS))document.getElementById(id).value=r[k]??'';document.getElementById('inpAdaptive').checked=r.adaptive;}
function normaliseNodeSettings(r={}){
  r=r&&typeof r==='object'?r:{};
  return {cableDb:optionalNumber(r.cableDb,0,100),noiseFigure:optionalNumber(r.noiseFigure,0,30),noiseDbm:optionalNumber(r.noiseDbm,-200,0),
    groundM:optionalNumber(r.groundM,-12000,10000),clearM:optionalNumber(r.clearM,0,5000),clutterM:optionalNumber(r.clutterM,0,200),
    modem:r.modem==null?null:Object.hasOwn(RFModel.MODEMS,r.modem)?r.modem:'',hardware:String(r.hardware||'').slice(0,120)};
}
// Omitted from share links when a node has no extra settings, keeping URLs short.
function serializeNodeSettings(node){
  const r=normaliseNodeSettings(node);
  return Object.values(r).some(v=>v!=null&&v!=='')?r:null;
}
function localTerrainAt(lat,lng){return RFData.gridAt(localTerrain,lat,lng);}
function terrainProvenance(lat,lng){
  const pixel=40075017*Math.cos(lat*Math.PI/180)/(2**TERRAIN_Z*256);
  const g=localTerrain;
  const spacing=g?Math.max((g.north-g.south)*111320/(g.rows-1),(g.east-g.west)*111320*Math.cos(lat*Math.PI/180)/(g.cols-1)):0;
  return g ? `Local DEM ${g.source} (${g.date}; ${g.datum}; ~${spacing.toFixed(0)} m grid); AWS fallback outside grid/nodata` : `AWS Terrarium z${TERRAIN_Z}, ~${pixel.toFixed(0)} m pixels; source age/vertical accuracy unverified`;
}
function clutterProvenance(wc,canopy){
  return `${wc?`WorldCover 2021 class heights (~${(wc.spacingM||20).toFixed(0)} m sampling)`:'WorldCover unavailable'}; ${canopy?`measured canopy resampled to ~${(canopy.spacingM||20).toFixed(0)} m${canopy.note?` (${canopy.note})`:''}; age/height error unverified`:'measured canopy unavailable or disabled; class-height fallback where available'}`;
}
function matchedObservations(a,b){return observations.filter(r=>r.from.toLowerCase()===a.name.toLowerCase()&&r.to.toLowerCase()===b.name.toLowerCase());}
function observationSummary(a,b){
  const rows=matchedObservations(a,b);
  if(!rows.length)return 'No observations';
  const success=rows.filter(r=>r.success).length,latest=rows.reduce((a,b)=>a.timestamp>b.timestamp?a:b);
  return `${success}/${rows.length} recorded receptions; latest ${latest.timestamp}${latest.snrDb!=null?`, SNR ${latest.snrDb} dB`:''}. Traces are successful-packet samples, not an availability estimate.`;
}
function db(value){return Number.isFinite(value)?value.toFixed(1):value===Infinity?'∞':'−∞';}
function linkDetailsHtml(e,a,b){
  const r=e.result;
  const row=(from,to,d)=>`<tr><td>${escHtml(from.name)} → ${escHtml(to.name)}</td><td>${db(d.prxDbm)}</td><td>${db(d.marginDb)}</td><td>${d.snrDb==null?'—':db(d.snrDb)}</td></tr>`;
  return `<details class="link-details"><summary>Directions, observations and data quality</summary>
    <table><thead><tr><th>Direction</th><th>RX dBm</th><th>Margin dB</th><th>SNR dB</th></tr></thead><tbody>${row(a,b,r.ab)}${row(b,a,r.ba)}</tbody></table>
    <p>SNR uses ${r.ab.noiseMeasured||r.ba.noiseMeasured?'measured noise where supplied; estimated noise otherwise':'thermal noise + configured receiver noise figure'}. It is a prediction.</p>
    <p>${escHtml(a.name)} → ${escHtml(b.name)}: ${escHtml(observationSummary(a,b))}<br>${escHtml(b.name)} → ${escHtml(a.name)}: ${escHtml(observationSummary(b,a))}</p>
    <p>${r.samples} samples, maximum step ${r.maxSpacing.toFixed(1)} m. ${escHtml(r.provenance)}</p>
    <p>Height sensitivity: margin ${db(r.marginRange?.[0])} to ${db(r.marginRange?.at(-1))} dB for terrain ±${r.terrainError} m / clutter ±${r.clutterError} m. Scenarios, not confidence bounds; endpoint heights held fixed.</p>
    <p>Losses: diffraction ${db(r.diffLossDb)}, through-clutter ${db(r.clutterLossDb)}, terminal ${db(r.termLossDb)} dB. ${r.warnings.map(escHtml).join(' ')}</p>
    <p>Calculated ${escHtml(r.computedAt)}. Smooth-earth diffraction, multipath, interference and weather variability are not predicted.</p>
  </details>`;
}
function downloadJson(name,data){
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function importObservations(raw){
  const added=RFData.observations(raw),existing=new Set(observations.map(r=>JSON.stringify(r)));
  const merged=[...observations];for(const r of added){const key=JSON.stringify(r);if(!existing.has(key)){merged.push(r);existing.add(key);}}
  if(merged.length>10000)throw new Error('Maximum 10,000 observations');
  observations=merged;renderResults();renderValidation();return added.length;
}
function renderValidation(){
  const el=document.getElementById('validationReport');if(!el)return;
  const errors={calibration:[],validation:[]},snrErrors={calibration:[],validation:[]};
  let matched=0,success=0,unmatched=0,settingsMismatch=0;
  for(const o of observations){
    if(o.success)success++;
    const a=S.nodes.filter(n=>n.name.toLowerCase()===o.from.toLowerCase()),b=S.nodes.filter(n=>n.name.toLowerCase()===o.to.toLowerCase());
    if(a.length!==1||b.length!==1){unmatched++;continue;}
    const edge=S.edges.find(e=>(e.aId===a[0].id&&e.bId===b[0].id)||(e.bId===a[0].id&&e.aId===b[0].id));
    const r=edge?.result;if(!r?.ab)continue;
    const sender=effectiveRf(a[0]),receiver=effectiveRf(b[0]);
    if(!o.modem||!o.frequencyMHz||o.modem!==receiver.modem||Math.abs(o.frequencyMHz-globalRf().freq)>.01){settingsMismatch++;continue;}
    const settings={txDbm:sender.tx,txGainDbi:sender.gain,rxGainDbi:receiver.gain,txCableDb:sender.cable,rxCableDb:receiver.cable,txHeightM:a[0].antH,rxHeightM:b[0].antH,rxSensitivityDbm:receiver.rx};
    if(o.radio&&Object.entries(settings).some(([k,v])=>o.radio[k]!=null&&Math.abs(o.radio[k]-v)>.01)){settingsMismatch++;continue;}
    const predicted=edge.aId===a[0].id?r.ab:r.ba;matched++;
    if(o.success&&o.rssiDbm!=null&&Number.isFinite(predicted.prxDbm))errors[o.split].push(predicted.prxDbm-o.rssiDbm);
    if(o.success&&o.snrDb!=null&&Number.isFinite(predicted.snrDb))snrErrors[o.split].push(predicted.snrDb-o.snrDb);
  }
  const summary=(title,values)=>{const m=RFData.metrics(values);return m?`${title}: n=${m.n}, prediction − observation bias ${m.bias.toFixed(1)} dB, MAE ${m.mae.toFixed(1)} dB.`:`${title}: no comparable samples.`;};
  el.textContent=`${observations.length} records (${success} received, ${observations.length-success} failed). ${unmatched} unknown/ambiguous node names; ${settingsMismatch} missing/mismatched modem or frequency; ${matched} matched analysed directions.\n`+
    ['calibration','validation'].map(split=>summary(split+' RSSI',errors[split])+' '+summary(split+' SNR',snrErrors[split])).join('\n')+
    '\nOptional radio metadata is checked when supplied; otherwise verify power, antennas and hardware manually. No automatic tuning is applied. Keep validation samples separate from calibration. Successful traces alone cannot estimate delivery probability; capture failed attempts too.';
}
function invalidateData(){
  invalidateAllAnalysis();S.nodes.forEach(n=>{invalidateNodeCoverage(n,true);fetchElev(n);});renderNodeList();renderValidation();
}
function setupAccuracyUI(){
  const msg=document.getElementById('dataMessage');
  const action=(id,fn)=>document.getElementById(id).addEventListener('click',async()=>{try{await fn();msg.textContent='Done.';}catch(e){msg.textContent=e.message;}});
  const fileAction=(id,fn)=>document.getElementById(id).addEventListener('change',async ev=>{try{
    const file=ev.target.files[0];if(!file)return;if(file.size>25*1024*1024)throw new Error('Maximum file size 25 MB');
    await fn(JSON.parse(await file.text()));msg.textContent='Loaded '+file.name;
  }catch(e){msg.textContent=e.message;}finally{ev.target.value='';}});
  action('btnImportMeasurements',()=>importObservations(JSON.parse(document.getElementById('measurementInput').value)));
  fileAction('observationFile',importObservations);
  fileAction('terrainFile',raw=>{const validated=RFData.grid(raw);localTerrain=validated;invalidateData();});
  action('btnRemoveTerrain',()=>{localTerrain=null;invalidateData();});
  action('btnExportObservations',()=>downloadJson('clearpath-observations.json',{observations}));
  action('btnExportProject',()=>downloadJson('clearpath-project.json',{type:'clearpath-project',version:1,hash:buildShareHash(),observations,terrain:localTerrain}));
  fileAction('projectFile',raw=>{
    if(raw.type!=='clearpath-project'||raw.version!==1||typeof raw.hash!=='string')throw new Error('Unsupported project file');
    parseSharedHash(raw.hash);const obs=RFData.observations({observations:raw.observations||[]}),terrain=raw.terrain?RFData.grid(raw.terrain):null;
    clearAll();localTerrain=terrain;loadFromHash(raw.hash);observations=obs;renderValidation();
  });
  action('btnExampleMeasurements',()=>downloadJson('measurement-example.json',{observations:[{from:'SunBird',to:'Monsoon Moon Server',timestamp:'2026-09-29T00:00:00Z',frequencyMHz:915,modem:'LongFast',success:true,snrDb:-4.5,split:'validation',source:'EXAMPLE ONLY: replace date and actual radio settings'}],traces:[]}));
  document.getElementById('btnValidationRefresh').addEventListener('click',renderValidation);
}
setupAccuracyUI();
