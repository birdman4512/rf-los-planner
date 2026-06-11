// Clickjacking guard. The CSP frame-ancestors directive is ignored when the
// policy is delivered via <meta> (per spec), and GitHub Pages cannot send real
// response headers, so breaking out of a hostile frame here is the only
// protection that actually applies.
if (window.top !== window.self) {
  try { window.top.location.replace(window.location.href); }
  catch { document.documentElement.style.display = 'none'; }
}

// ═══════════════════════════════════════════════════════════
//  STATE
//  Graph model: nodes (waypoints) + edges (links between any two)
//  Paths: ordered sequences of node IDs for combined chart views
// ═══════════════════════════════════════════════════════════
const S = {
  map: null,
  nodes: [],       // {id, name, lat, lng, antH, elev, marker, rfOverride, txDbm, gainDbi, rxDbm, coverageOn, coverageLayer, coverageDirty, coverageComputed}
  edges: [],       // {id, aId, bId, hidden, line, result, profile}
  paths: [],       // {id, name, hidden, nodeIds[]}  — user-defined chains for chart
  nextId: 1,
  activeView: null, // {type:'edge'|'path', id}
  elevCache: {},
  profileCache: {},
  _coverageComputing: false,
  _coverageBatch: false,
  _analysing: false,
  debugLog: [],
  hoverMarker: null,
  profileHover: null,
  redrawProfile: null,
  profileCursorHideFrame: null,
  _dragId: null,
  showLinks: true,
  showPaths: true
};

const COLORS = ['#00c8f0','#f39c12','#2ecc71','#e74c3c','#9b59b6','#1abc9c','#e67e22','#3498db','#f1c40f','#e91e63'];
const nodeColor = i => COLORS[i % COLORS.length];
// A node's effective colour: its custom override, else the palette default.
// Keyed on the stable node id (not array position) so a node keeps its colour
// when earlier nodes are deleted and the rest shift down.
const nodeColorFor = node => node?.color || nodeColor((node?.id ?? 1) - 1);

const LIMITS = {
  hashChars: 50000,
  nodes: 200,
  edges: 500,
  paths: 200,
  pathNodes: 100,
  nameChars: 80,
  antH: 500,
  freqMin: 1,
  freqMax: 100000,
  kMin: 0.1,
  kMax: 10,
  rxAntH: 500,
  covMaxKm: 100,
  covRays: 360,
  covSamples: 80
};
const COVERAGE_RAY_OPTIONS = [24, 36, 72, 144, 360];
const COVERAGE_SAMPLE_OPTIONS = [30, 50, 80];
// Target terrain sample step (m) along each coverage ray — roughly the DEM
// pixel size so near-field hills are resolved. The Samples setting is a floor;
// COVERAGE_MAX_SAMPLES caps total samples per ray so large radii stay fast.
const COVERAGE_STEP_M = 40;
const COVERAGE_MAX_SAMPLES = 1600;
const FRESNEL_OPTIONS = [0, 0.4, 0.6, 1];

// ── Surface clutter via Meta/WRI canopy height + ESA WorldCover land cover ──
// Bare-earth terrain misses trees/buildings; clutter adds obstruction pressure
// and diffraction loss, while bare terrain remains the hard LOS blocker.
// Optional and off by default; degrades gracefully to bare terrain if data fails.
const WORLDCOVER_WMS_SOURCES = [
  { name:'Terrascope TiTiler', url:'https://titiler.terrascope.be/wms', layer:'esa-worldcover-map-10m-2021-v2_map', time:'2021-01-01' },
  { name:'Terrascope legacy', url:'https://services.terrascope.be/wms/v2', layer:'WORLDCOVER_2021_MAP' }
];
const CANOPY_TILE_Z = 9;
const CANOPY_MAX_M = 60; // PNG rescale ceiling for Meta/WRI canopy height.
const CANOPY_COG_BASE = 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/';
const CANOPY_GFW_BBOX = 'https://tiles.globalforestwatch.org/cog/basic/bbox/';
const CLUTTER_ATTEN_DB_PER_M_915 = 0.10; // reference loss while LOS passes through canopy/building clutter
const CLUTTER_ATTEN_CAP_DB = 45;         // avoid treating clutter as infinite terrain
// WorldCover classes: 10 Tree, 20 Shrub, 30 Grass, 40 Crop, 50 Built-up,
// 60 Bare, 70 Snow, 80 Water, 90 Wetland, 95 Mangrove, 100 Moss.
// Default clutter height (m) per WorldCover class. Tree cover and Built-up are
// user-editable (the two that matter most); the rest are sensible fixed values.
const CLUTTER_HEIGHT_DEFAULT = {10:15,20:3,30:0,40:1,50:8,60:0,70:0,80:0,90:1,95:8,100:0};
const WORLDCOVER_PALETTE = [
  {cls:10, rgb:[0,100,0]},       // Tree cover
  {cls:20, rgb:[255,187,34]},    // Shrubland
  {cls:30, rgb:[255,255,76]},    // Grassland
  {cls:40, rgb:[240,150,255]},   // Cropland
  {cls:50, rgb:[250,0,0]},       // Built-up
  {cls:60, rgb:[180,180,180]},   // Bare / sparse vegetation
  {cls:70, rgb:[240,240,240]},   // Snow and ice
  {cls:80, rgb:[0,100,200]},     // Permanent water bodies
  {cls:90, rgb:[0,150,160]},     // Herbaceous wetland
  {cls:95, rgb:[0,207,117]},     // Mangroves
  {cls:100,rgb:[250,230,160]}    // Moss and lichen
];

// Keep the in-memory caches bounded so long sessions / big coverage sweeps
// don't grow without limit. Maps and plain objects both iterate keys in
// insertion order, so dropping the first entries evicts the oldest.
function trimCache(cache, max){
  if(cache instanceof Map){
    while(cache.size > max) cache.delete(cache.keys().next().value);
  }else{
    const keys = Object.keys(cache);
    const excess = keys.length - max;
    for(let i = 0; i < excess; i++) delete cache[keys[i]];
  }
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function optionNum(v, allowed, fallback) {
  const n = Number(v);
  return allowed.includes(n) ? n : fallback;
}
function validLatLng(lat, lng) {
  if (lat == null || lng == null) return false;
  if (String(lat).trim() === '' || String(lng).trim() === '') return false;
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) &&
    Number(lat) >= -90 && Number(lat) <= 90 && Number(lng) >= -180 && Number(lng) <= 180;
}
function cleanName(name, fallback = 'Site') {
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (s || fallback).slice(0, LIMITS.nameChars);
}
function textNode(value) {
  const span = document.createElement('span');
  span.textContent = String(value ?? '');
  return span;
}

function removeEdgeLayers(edge){
  if(edge.line) S.map.removeLayer(edge.line);
  if(edge.hitLine) S.map.removeLayer(edge.hitLine);
}

// ═══════════════════════════════════════════════════════════
//  MAP INIT
// ═══════════════════════════════════════════════════════════
function initMap() {
  S.map = L.map('map', { center: [-27.6, 153.1], zoom: 10, zoomControl: true });
  S.map.createPane('profileHoverPane');
  S.map.getPane('profileHoverPane').style.zIndex=750;
  S.map.getPane('profileHoverPane').style.pointerEvents='none';
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19, crossOrigin: true
  }).addTo(S.map);
  const esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri', maxZoom: 19
  });
  L.control.layers({'OpenStreetMap': osm, 'Esri Topo': esri}, {}, {position:'topright'}).addTo(S.map);
  S.map.on('contextmenu', e => { L.DomEvent.preventDefault(e.originalEvent); showMapCtx(e.originalEvent.clientX, e.originalEvent.clientY, e.latlng); });
  S.map.on('mousedown', closeCtx);
  S.map.on('click', () => {
    closeCtx();
    if(S.activeView) clearActiveView();
  });
  setTimeout(() => S.map.invalidateSize(), 150);
  setTimeout(() => S.map.invalidateSize(), 500);
}

// ═══════════════════════════════════════════════════════════
//  NODES
// ═══════════════════════════════════════════════════════════
// Default name for a freshly placed node. Uniform "Site N" scheme so the prefix
// never changes as more nodes are added (N is the 1-based position in the list).
const defaultNodeName = idx => `Site ${idx + 1}`;

function addNode(lat, lng) {
  const idx = S.nodes.length;
  const node = { id: S.nextId++, name: defaultNodeName(idx), lat, lng, antH: 6, elev: null, marker: null,
    color: null,
    rfOverride: false, txDbm: null, gainDbi: null, rxDbm: null,
    coverageOn: false, coverageLayer: null, coverageDirty: true, coverageComputed: false };
  S.nodes.push(node);
  node.marker = makeMarker(node);
  renderNodeList();
  fetchElev(node);
  document.getElementById('wpCount').textContent = S.nodes.length;
  document.getElementById('mapHint').style.display = 'none';
  return node;
}

function makeMarker(node) {
  const idx = S.nodes.indexOf(node);
  const marker = L.marker([node.lat, node.lng], { draggable: true, icon: buildIcon(node) }).addTo(S.map);
  marker.on('click', e => {
    L.DomEvent.stopPropagation(e.originalEvent);
    selectNodeView(node.id);
  });
  marker.on('drag', () => {
    const ll = marker.getLatLng(); node.lat = ll.lat; node.lng = ll.lng;
    updateNodeFields(node); redrawEdgeLines();
  });
  marker.on('dragend', () => {
    node.elev = null; invalidateEdgesForNode(node.id); fetchElev(node);
    invalidateNodeCoverage(node, true);
    syncShareUrl();
    refreshOverlap();
    // Re-analyse all links whenever a node is dragged
    if (S.edges.length > 0) runAnalysis();
  });
  marker.on('contextmenu', e => { L.DomEvent.preventDefault(e.originalEvent); L.DomEvent.stopPropagation(e.originalEvent); showNodeCtx(e.originalEvent.clientX, e.originalEvent.clientY, node); });
  bindNodeTooltip(marker, node.name);
  return marker;
}

function bindNodeTooltip(marker, label) {
  marker.bindTooltip(textNode(label), { permanent: false, direction: 'top', offset: [0,-14] });
}

function setNodeTooltip(node, label) {
  if (!node.marker) return;
  node.marker.setTooltipContent(textNode(label));
}

// Marker SVG depends on index (number), colour (custom or palette) and selected state.
function nodeIconSvg(node) {
  const idx = S.nodes.indexOf(node);
  const c = nodeColorFor(node);
  const n = idx + 1;
  const selected = S.activeView?.type === 'node' && S.activeView.id === node.id;
  const pinPath = 'M11 0C4.9 0 0 4.9 0 11c0 8.3 11 17 11 17s11-8.7 11-17C22 4.9 17.1 0 11 0z';
  const selectedOutline = selected ? `<path d="${pinPath}" fill="none" stroke="${c}" stroke-width="4" stroke-linejoin="round" opacity="1"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="34" viewBox="-3 -3 28 34">
    ${selectedOutline}
    <path d="${pinPath}" fill="${c}" opacity="0.92"/>
    <circle cx="11" cy="11" r="6" fill="#0b0f17"/>
    <text x="11" y="14.5" text-anchor="middle" font-family="monospace" font-size="7" fill="${c}" font-weight="bold">${n}</text>
  </svg>`;
}

function nodeDivIcon(svg) {
  return L.divIcon({ html: svg, className: 'lf-marker', iconSize:[28,34], iconAnchor:[14,31], tooltipAnchor:[0,-31] });
}

function buildIcon(node) {
  const svg = nodeIconSvg(node);
  node._iconHtml = svg;
  return nodeDivIcon(svg);
}

// Rebuild only the icons whose appearance actually changed. setIcon() swaps the
// marker's DOM element, which both causes a visible flicker and aborts an
// in-progress drag — so skipping unchanged markers (every marker, on every
// analysis/selection) is what keeps dragging smooth and the screen stable.
function refreshAllIcons() {
  S.nodes.forEach(n => {
    if (!n.marker) return;
    const svg = nodeIconSvg(n);
    if (n._iconHtml !== svg) { n.marker.setIcon(nodeDivIcon(svg)); n._iconHtml = svg; }
  });
}

function removeNode(id) {
  const idx = S.nodes.findIndex(n => n.id === id);
  if (idx < 0) return;
  if (S.nodes[idx].coverageLayer) S.map.removeLayer(S.nodes[idx].coverageLayer);
  S.map.removeLayer(S.nodes[idx].marker);
  S.nodes.splice(idx, 1);
  // Remove all edges involving this node
  S.edges.filter(e => e.aId === id || e.bId === id).forEach(removeEdgeLayers);
  S.edges = S.edges.filter(e => e.aId !== id && e.bId !== id);
  // Remove this node from all paths, delete paths that become too short
  S.paths.forEach(p => { p.nodeIds = p.nodeIds.filter(nid => nid !== id); });
  S.paths = S.paths.filter(p => p.nodeIds.length >= 2);
  if(S.activeView?.type==='edge'&&!S.edges.some(e=>e.id===S.activeView.id)) S.activeView=null;
  if(S.activeView?.type==='path'&&!S.paths.some(p=>p.id===S.activeView.id)) S.activeView=null;
  if(S.activeView?.type==='node'&&S.activeView.id===id) S.activeView=null;
  refreshAllIcons();
  renderNodeList();
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
  highlightActiveMapView();
  document.getElementById('wpCount').textContent = S.nodes.length;
  document.getElementById('edgeCount').textContent = S.edges.length;
  document.getElementById('pathCount').textContent = S.paths.length;
}

function clearAll() {
  S.nodes.forEach(n => {
    if (n.marker) S.map.removeLayer(n.marker);
    if (n.coverageLayer) S.map.removeLayer(n.coverageLayer);
  });
  S.edges.forEach(removeEdgeLayers);
  S.nodes = []; S.edges = []; S.paths = [];
  S.activeView = null;
  S.nextId = 1;
  updateCovCount();
  renderNodeList(); renderEdgesPanel(); renderPathsPanel();
  document.getElementById('resultsArea').innerHTML = '<div class="no-data">Add nodes, links, then analyse.</div>';
  renderChartTabs(); clearCanvas();
  document.getElementById('wpCount').textContent = '0';
  document.getElementById('edgeCount').textContent = '0';
  document.getElementById('pathCount').textContent = '0';
  document.getElementById('mapHint').style.display = '';
}

function updateNodeFields(node) {
  const latEl = document.getElementById(`lat_${node.id}`);
  const lngEl = document.getElementById(`lng_${node.id}`);
  if (latEl) latEl.value = node.lat.toFixed(6);
  if (lngEl) lngEl.value = node.lng.toFixed(6);
}

// ═══════════════════════════════════════════════════════════
//  EDGES (LINKS)
// ═══════════════════════════════════════════════════════════
function addEdge(aId, bId) {
  // Prevent duplicate edges
  if (S.edges.some(e => (e.aId===aId&&e.bId===bId)||(e.aId===bId&&e.bId===aId))) { toast('Link already exists.',2000); return; }
  if (aId === bId) { toast('Cannot link a node to itself.',2000); return; }
  const edge = { id: S.nextId++, aId, bId, hidden: false, line: null, hitLine: null, result: null, profile: null };
  S.edges.push(edge);
  const a = S.nodes.find(n=>n.id===aId), b = S.nodes.find(n=>n.id===bId);
  edge.line = L.polyline([[a.lat,a.lng],[b.lat,b.lng]], { color:'#4a6278', weight:2, opacity:.7, dashArray:'5 4', interactive:false }).addTo(S.map);
  edge.hitLine = L.polyline([[a.lat,a.lng],[b.lat,b.lng]], { color:'#ffffff', weight:24, opacity:0, interactive:true }).addTo(S.map);
  attachEdgeHandlers(edge);
  highlightActiveMapView();
  renderEdgesPanel();
  document.getElementById('edgeCount').textContent = S.edges.length;

  // Auto-create or extend a path
  autoExtendPath(aId, bId);
}

function removeEdge(id) {
  const idx = S.edges.findIndex(e => e.id === id);
  if (idx < 0) return;
  const e = S.edges[idx];
  removeEdgeLayers(e);
  S.edges.splice(idx, 1);
  // Drop any path that relied on the deleted link: a path is only valid if every
  // consecutive node pair still has an edge connecting them.
  S.paths = S.paths.filter(p => {
    for (let i=0;i<p.nodeIds.length-1;i++) {
      const a=p.nodeIds[i], b=p.nodeIds[i+1];
      if (!S.edges.some(e2=>(e2.aId===a&&e2.bId===b)||(e2.aId===b&&e2.bId===a))) return false;
    }
    return true;
  });
  if(S.activeView?.type==='edge'&&S.activeView.id===id) S.activeView=null;
  if(S.activeView?.type==='path'&&!S.paths.some(p=>p.id===S.activeView.id)) S.activeView=null;
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
  highlightActiveMapView();
  document.getElementById('edgeCount').textContent = S.edges.length;
  document.getElementById('pathCount').textContent = S.paths.length;
}

function redrawEdgeLines() {
  const nodesById=nodeByIdMap();
  S.edges.forEach(e => {
    const a = nodesById.get(e.aId), b = nodesById.get(e.bId);
    if (a && b && e.line) e.line.setLatLngs([[a.lat,a.lng],[b.lat,b.lng]]);
    if (a && b && e.hitLine) e.hitLine.setLatLngs([[a.lat,a.lng],[b.lat,b.lng]]);
  });
}

function isEdgeVisible(edge){
  return !!edge && S.showLinks && !edge.hidden;
}

function visibleEdgeCount(){
  return S.edges.reduce((count,e)=>count+(isEdgeVisible(e)?1:0),0);
}

function nodeByIdMap(){
  return new Map(S.nodes.map(n=>[n.id,n]));
}

function edgePairKey(aId,bId){
  return aId<bId?`${aId}|${bId}`:`${bId}|${aId}`;
}

function edgeByNodePairMap(){
  const edgesByPair=new Map();
  S.edges.forEach(e=>edgesByPair.set(edgePairKey(e.aId,e.bId),e));
  return edgesByPair;
}

function edgeBetween(aId,bId,edgesByPair=edgeByNodePairMap()){
  return edgesByPair.get(edgePairKey(aId,bId));
}

function pathLabel(path,nodesById=nodeByIdMap()){
  return path.nodeIds.map(id=>nodesById.get(id)?.name||'?').join(' → ');
}

function pathEdges(path,edgesByPair=edgeByNodePairMap()){
  const found=[];
  if(!path) return found;
  for(let i=0;i<path.nodeIds.length-1;i++){
    const edge=edgeBetween(path.nodeIds[i],path.nodeIds[i+1],edgesByPair);
    if(edge) found.push(edge);
  }
  return found;
}

function pathUsesEdge(path, edge){
  if(!path||!edge) return false;
  for(let i=0;i<path.nodeIds.length-1;i++){
    const aId=path.nodeIds[i], bId=path.nodeIds[i+1];
    if((edge.aId===aId&&edge.bId===bId)||(edge.aId===bId&&edge.bId===aId)) return true;
  }
  return false;
}

function edgeHasVisiblePath(edge, exceptPathId=null){
  return S.paths.some(p=>p.id!==exceptPathId&&!p.hidden&&pathUsesEdge(p, edge));
}

function syncPathHiddenFromEdges(){
  let activePathHidden=false;
  const edgesByPair=edgeByNodePairMap();
  S.paths.forEach(p=>{
    const edges=pathEdges(p,edgesByPair);
    if(edges.length&&edges.every(e=>e.hidden)){
      p.hidden=true;
      if(S.activeView?.type==='path'&&S.activeView.id===p.id) activePathHidden=true;
    }
  });
  if(activePathHidden) clearActiveView();
}

function setEdgeHidden(id, hidden){
  const edge=S.edges.find(e=>e.id===id);
  if(!edge) return;
  edge.hidden=!!hidden;
  if(edge.hidden&&S.activeView?.type==='edge'&&S.activeView.id===id) clearActiveView();
  syncPathHiddenFromEdges();
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
  highlightActiveMapView();
}

function showOnlyEdge(id){
  S.edges.forEach(e=>{e.hidden=e.id!==id;});
  S.paths.forEach(p=>{p.hidden=true;});
  S.showLinks=true;
  const links=document.getElementById('inpShowLinks'); if(links) links.checked=true;
  // force: ONLY must isolate-and-select, never toggle an already-selected link off.
  selectEdgeView(id,{force:true});
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
  highlightActiveMapView();
}

function showAllLinks(){
  S.edges.forEach(e=>{e.hidden=false;});
  S.showLinks=true;
  const links=document.getElementById('inpShowLinks'); if(links) links.checked=true;
  renderEdgesPanel();
  renderChartTabs();
  renderResults();
  highlightActiveMapView();
}

function hideAllLinks(){
  S.edges.forEach(e=>{e.hidden=true;});
  if(S.activeView?.type==='edge') clearActiveView();
  syncPathHiddenFromEdges();
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
  highlightActiveMapView();
}

function setPathHidden(id, hidden){
  const path=S.paths.find(p=>p.id===id);
  if(!path) return;
  path.hidden=!!hidden;
  pathEdges(path).forEach(e=>{
    e.hidden=path.hidden?!edgeHasVisiblePath(e, path.id):false;
  });
  if(path.hidden&&S.activeView?.type==='path'&&S.activeView.id===id) clearActiveView();
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
  highlightActiveMapView();
}

function showOnlyPath(id){
  const path=S.paths.find(p=>p.id===id);
  if(!path) return;
  const visibleEdgeIds=new Set(pathEdges(path).map(e=>e.id));
  S.paths.forEach(p=>{p.hidden=p.id!==id;});
  S.edges.forEach(e=>{e.hidden=!visibleEdgeIds.has(e.id);});
  S.showLinks=true;
  S.showPaths=true;
  const links=document.getElementById('inpShowLinks'); if(links) links.checked=true;
  const paths=document.getElementById('inpShowPaths'); if(paths) paths.checked=true;
  selectPathView(id,{force:true});
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
  highlightActiveMapView();
}

function showAllPaths(){
  S.paths.forEach(p=>{p.hidden=false;});
  const edgesByPair=edgeByNodePairMap();
  S.paths.forEach(p=>pathEdges(p,edgesByPair).forEach(e=>{e.hidden=false;}));
  S.showLinks=true;
  S.showPaths=true;
  const links=document.getElementById('inpShowLinks'); if(links) links.checked=true;
  const paths=document.getElementById('inpShowPaths'); if(paths) paths.checked=true;
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
  highlightActiveMapView();
}

function hideAllPaths(){
  S.paths.forEach(p=>{p.hidden=true;});
  const edgesByPair=edgeByNodePairMap();
  S.paths.forEach(p=>pathEdges(p,edgesByPair).forEach(e=>{e.hidden=true;}));
  if(S.activeView?.type==='path') clearActiveView();
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
  highlightActiveMapView();
}

function edgeBaseStyle(edge){
  if(!isEdgeVisible(edge)) return {color:'#4a6278',weight:0,opacity:0,dashArray:''};
  if(!edge.result) return {color:'#4a6278',weight:2,opacity:.7,dashArray:'5 4'};
  if(edge.result.status==='error') return {color:'#e74c3c',weight:2,opacity:.8,dashArray:'3 5'};
  const col=edge.result.status==='clear'?'#2ecc71':edge.result.status==='marginal'?'#f39c12':'#e74c3c';
  return {color:col,weight:3,opacity:.9,dashArray:''};
}

function setDisplayVisibility(kind, visible) {
  if (kind === 'links') {
    S.showLinks = !!visible;
    const inp = document.getElementById('inpShowLinks');
    if (inp) inp.checked = S.showLinks;
    if (!S.showLinks && S.activeView?.type === 'edge') clearActiveView();
  } else if (kind === 'paths') {
    S.showPaths = !!visible;
    const inp = document.getElementById('inpShowPaths');
    if (inp) inp.checked = S.showPaths;
    if (!S.showPaths && S.activeView?.type === 'path') clearActiveView();
  }
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
  highlightActiveMapView();
  toast(`${kind === 'links' ? 'Links' : 'Paths'} ${visible ? 'shown' : 'hidden'}.`, 1200);
}

function selectNodeView(id, opts={}){
  if(!S.nodes.some(n=>n.id===id)) return;
  if(!opts.force&&S.activeView?.type==='node'&&S.activeView.id===id){clearActiveView();return;}
  S.activeView={type:'node',id};
  clearCanvas();
  document.getElementById('chartTitle').textContent='Elevation Profile';
  highlightActiveMapView();
  renderNodeList();
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
  if(opts.pan){
    const node=S.nodes.find(n=>n.id===id);
    S.map.panTo([node.lat,node.lng],{animate:true});
  }
  requestAnimationFrame(()=>{
    document.querySelector(`.wp-card[data-id="${id}"]`)?.scrollIntoView({block:'nearest'});
  });
}

function selectEdgeView(id, opts={}){
  const edge=S.edges.find(e=>e.id===id);
  if(!edge) return;
  if(!opts.force&&S.activeView?.type==='edge'&&S.activeView.id===id){clearActiveView();return;}
  S.activeView={type:'edge',id};
  if(edge.profile) showEdgeProfile(id);
  else{
    clearCanvas();
    document.getElementById('chartTitle').textContent='Elevation Profile';
  }
  highlightActiveMapView();
  renderNodeList();
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
}

function selectPathView(id, opts={}){
  const path=S.paths.find(p=>p.id===id);
  if(!path) return;
  if(!opts.force&&S.activeView?.type==='path'&&S.activeView.id===id){clearActiveView();return;}
  S.activeView={type:'path',id};
  if(pathHasAnalysedProfiles(path)) showPathProfile(id);
  else{
    clearCanvas();
    document.getElementById('chartTitle').textContent='Elevation Profile';
  }
  highlightActiveMapView();
  renderNodeList();
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
}

function clearActiveView(){
  S.activeView=null;
  clearCanvas();
  highlightActiveMapView();
  renderNodeList();
  renderEdgesPanel();
  renderPathsPanel();
  renderChartTabs();
  renderResults();
}

// Restyle every link on the map to reflect the current selection.
// Three cases per link:
//   1. it IS the selected single edge  → its own status colour, bolder + on top
//   2. it belongs to the selected path → its own status colour, bolder + on top
//   3. otherwise                        → its plain base style
// We deliberately keep each link's status colour (green/orange/red, or grey when
// un-analysed) and only thicken/opacify it for emphasis, so a "clear" link stays
// green, a "blocked" link stays red, etc. — selection never recolours the link.
function highlightActiveMapView(){
  const activePath=S.activeView?.type==='path'?S.paths.find(p=>p.id===S.activeView.id):null;
  const shouldEmphasizeSelected=visibleEdgeCount()>1;
  const edgesByPair=edgeByNodePairMap();
  // Collect the edge ids that make up the active path (consecutive node pairs).
  const pathEdgeIds=new Set();
  if(activePath){
    for(let i=0;i<activePath.nodeIds.length-1;i++){
      const edge=edgeBetween(activePath.nodeIds[i],activePath.nodeIds[i+1],edgesByPair);
      if(edge) pathEdgeIds.add(edge.id);
    }
  }
  S.edges.forEach(e=>{
    if(!e.line) return;
    if(!isEdgeVisible(e)){
      e.line.setStyle(edgeBaseStyle(e));
      if(e.hitLine) e.hitLine.setStyle({weight:0,opacity:0});
      return;
    }
    const isSelectedEdge=S.activeView?.type==='edge'&&S.activeView.id===e.id;
    if(shouldEmphasizeSelected&&(isSelectedEdge||pathEdgeIds.has(e.id))){
      // Emphasise by keeping the link's own colour but making it bolder.
      // weight:6 (vs the analysed default of 3) reads clearly as "selected"
      // while preserving the clear/marginal/blocked colour coding.
      e.line.setStyle({...edgeBaseStyle(e),weight:6,opacity:1});
      e.line.bringToFront();
    }else{
      e.line.setStyle(edgeBaseStyle(e));
    }
    if(e.hitLine){
      e.hitLine.setStyle({weight:24,opacity:0});
      e.hitLine.bringToFront();
    }
  });
  refreshAllIcons();
}

function invalidateEdgesForNode(nodeId) {
  let changed = false;
  S.edges.forEach(e => {
    if (e.aId !== nodeId && e.bId !== nodeId) return;
    e.result = null;
    e.profile = null;
    changed = true;
    if (e.line) e.line.setStyle(edgeBaseStyle(e));
  });
  if (!changed) return;

  // Clear stale chart but keep activeView so runAnalysis can restore the same view.
  const active = S.activeView;
  if (active?.type === 'edge') {
    const edge = S.edges.find(e => e.id === active.id);
    if (edge && (edge.aId === nodeId || edge.bId === nodeId)) clearCanvas();
  } else if (active?.type === 'path') {
    const path = S.paths.find(p => p.id === active.id);
    if (path?.nodeIds.includes(nodeId)) clearCanvas();
  }

  renderResults();
  renderEdgesPanel();
  renderChartTabs();
  renderPathsPanel();
  highlightActiveMapView();
}

// ═══════════════════════════════════════════════════════════
//  AUTO PATH BUILDING
//  Every new link gets its own standalone 2-node path. Existing
//  paths are never touched — to build a multi-hop chain, use the
//  "+ NEW PATH" builder. This keeps new links from silently
//  splicing themselves onto a path that shares an endpoint.
// ═══════════════════════════════════════════════════════════
function autoExtendPath(aId, bId) {
  const a = S.nodes.find(n=>n.id===aId), b = S.nodes.find(n=>n.id===bId);
  const p = { id: S.nextId++, name: `${a.name} → ${b.name}`, hidden: false, nodeIds: [aId, bId] };
  S.paths.push(p);
  renderPathsPanel();
  document.getElementById('pathCount').textContent = S.paths.length;
}

// ── Path builder modal: click nodes to assemble an ordered, link-checked path ──
const PB = { editId: null, seq: [] };  // seq = ordered list of nodeIds

function addPath()  { openPathBuilder(null); }
function editPath(id){ openPathBuilder(id); }

function openPathBuilder(editId) {
  if (S.nodes.length < 2) { toast('Need at least 2 nodes to build a path.',3000); return; }
  PB.editId = editId ?? null;
  if (editId != null) {
    const p = S.paths.find(p => p.id === editId);
    const nodesById=nodeByIdMap();
    PB.seq = p ? p.nodeIds.filter(id => nodesById.has(id)) : [];
  } else {
    PB.seq = [];
  }
  document.getElementById('pathModalTitle').textContent = editId != null ? '✎ Edit Path' : '+ Build Path';
  document.getElementById('pbSaveBtn').textContent = editId != null ? 'SAVE CHANGES' : 'CREATE PATH';
  renderPathBuilder();
  document.getElementById('pathModal').classList.add('open');
}
function closePathModal() { document.getElementById('pathModal').classList.remove('open'); }

function pbHasLink(aId, bId, edgesByPair=edgeByNodePairMap()) {
  return !!edgeBetween(aId,bId,edgesByPair);
}
function pbAddNode(id) { if (!PB.seq.includes(id)) { PB.seq.push(id); renderPathBuilder(); } }
function pbRemoveAt(i) { PB.seq.splice(i,1); renderPathBuilder(); }
function pbMove(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= PB.seq.length) return;
  [PB.seq[i], PB.seq[j]] = [PB.seq[j], PB.seq[i]];
  renderPathBuilder();
}

function renderPathBuilder() {
  const nodesById=nodeByIdMap();
  const edgesByPair=edgeByNodePairMap();
  // Left column: every node, click to append (dimmed once added)
  const nodeList = document.getElementById('pbNodeList');
  nodeList.innerHTML = '';
  S.nodes.forEach((n, idx) => {
    const added = PB.seq.includes(n.id);
    const div = document.createElement('div');
    div.className = 'pb-node' + (added ? ' added' : '');
    div.innerHTML = `<div class="pb-num" style="color:${nodeColorFor(n)};border-color:${nodeColorFor(n)}">${idx+1}</div>
      <span>${escHtml(n.name)}</span>${added ? '<span class="pb-tag">added</span>' : ''}`;
    if (!added) div.addEventListener('click', () => pbAddNode(n.id));
    nodeList.appendChild(div);
  });

  // Right column: the ordered sequence with reorder/remove + per-hop link status
  const seqList = document.getElementById('pbSeqList');
  seqList.innerHTML = '';
  if (!PB.seq.length) {
    seqList.innerHTML = '<div class="no-data">Click nodes on the left to add them in order.</div>';
  }
  const missing = [];
  PB.seq.forEach((id, i) => {
    const node = nodesById.get(id);
    if(!node) return;
    const idx = S.nodes.indexOf(node);
    const item = document.createElement('div');
    item.className = 'pb-seq-item';
    item.innerHTML = `<div class="pb-num" style="color:${nodeColorFor(node)};border-color:${nodeColorFor(node)}">${idx+1}</div>
      <span style="flex:1">${escHtml(node.name)}</span>
      <div class="pb-arrows">
        <button title="Move up" ${i===0?'disabled':''}>▲</button>
        <button title="Move down" ${i===PB.seq.length-1?'disabled':''}>▼</button>
      </div>
      <button class="pb-rm" title="Remove">✕</button>`;
    const [btnUp, btnDown] = item.querySelectorAll('.pb-arrows button');
    btnUp.addEventListener('click', () => pbMove(i, -1));
    btnDown.addEventListener('click', () => pbMove(i, 1));
    item.querySelector('.pb-rm').addEventListener('click', () => pbRemoveAt(i));
    seqList.appendChild(item);
    if (i < PB.seq.length - 1) {
      const nextNode = nodesById.get(PB.seq[i+1]);
      const ok = pbHasLink(id, PB.seq[i+1], edgesByPair);
      if (!ok) missing.push([node.name, nextNode?.name||'?']);
      const lk = document.createElement('div');
      lk.className = 'pb-link ' + (ok ? 'ok' : 'bad');
      lk.textContent = ok ? '│ ✓ linked' : '│ ✗ no link';
      seqList.appendChild(lk);
    }
  });

  const warn = document.getElementById('pbWarn');
  const saveBtn = document.getElementById('pbSaveBtn');
  if (PB.seq.length < 2) {
    warn.textContent = 'Add at least 2 nodes to form a path.';
    saveBtn.disabled = true;
  } else if (missing.length) {
    warn.textContent = 'No link for: ' + missing.map(m => `${m[0]} ↔ ${m[1]}`).join(', ') + '. Add the link first, or reorder.';
    saveBtn.disabled = true;
  } else {
    warn.textContent = '';
    saveBtn.disabled = false;
  }
}

function savePathModal() {
  if (PB.seq.length < 2) return;
  const nodesById=nodeByIdMap();
  const edgesByPair=edgeByNodePairMap();
  for (let i=0;i<PB.seq.length-1;i++) if (!pbHasLink(PB.seq[i], PB.seq[i+1], edgesByPair)) return;
  const nodeIds = PB.seq.slice();
  const name = nodeIds.map(id => nodesById.get(id)?.name||'?').join(' → ');
  if (PB.editId != null) {
    const p = S.paths.find(p => p.id === PB.editId);
    if (p) { p.nodeIds = nodeIds; p.name = name; }
    closePathModal();
    renderPathsPanel();
    renderChartTabs();
    if (S.activeView?.type==='path' && S.activeView.id===PB.editId) {
      if (p && pathHasAnalysedProfiles(p)) showPathProfile(PB.editId); else clearCanvas();
    }
    highlightActiveMapView();
  } else {
    S.paths.push({ id: S.nextId++, name, hidden: false, nodeIds });
    closePathModal();
    renderPathsPanel();
    renderChartTabs();
    document.getElementById('pathCount').textContent = S.paths.length;
  }
}

function removePath(id) {
  S.paths = S.paths.filter(p => p.id !== id);
  if(S.activeView?.type==='path'&&S.activeView.id===id) S.activeView=null;
  renderPathsPanel();
  renderChartTabs();
  highlightActiveMapView();
  document.getElementById('pathCount').textContent = S.paths.length;
}

function pathHasAnalysedProfiles(path,edgesByPair=edgeByNodePairMap()){
  return !!path&&path.nodeIds.slice(0,-1).every((id,i)=>{
    const nextId=path.nodeIds[i+1];
    return !!edgeBetween(id,nextId,edgesByPair)?.profile;
  });
}

// ═══════════════════════════════════════════════════════════
//  RENDER SIDEBAR
// ═══════════════════════════════════════════════════════════
function renderNodeList() {
  syncShareUrl();
  const list = document.getElementById('wpList');
  if (S.nodes.length === 0) { list.innerHTML = '<div class="no-data">Right-click map to add nodes.</div>'; return; }
  list.innerHTML = '';
  S.nodes.forEach((node, idx) => {
    const c = nodeColorFor(node);
    const amsl = node.elev !== null ? (node.elev + node.antH).toFixed(1) + 'm' : '…';
    const card = document.createElement('div');
    card.className = 'wp-card'; card.draggable = true; card.dataset.id = node.id;
    card.style.borderLeftColor = c;
    const rf = effectiveRf(node);
    const covBtnClass = !node.coverageComputed ? '' : (node.coverageDirty ? 'dirty' : 'ok');
    const covBtnLabel = !node.coverageComputed ? 'COMPUTE' : (node.coverageDirty ? 'RECOMPUTE' : '✓ RECOMPUTE');
    const isActive = S.activeView?.type === 'node' && S.activeView.id === node.id;
    card.classList.toggle('active', isActive);
    card.classList.toggle('collapsed', !!node.collapsed);
    card.innerHTML = `
      <div class="wp-row1">
        <button class="wp-collapse" title="Collapse / expand"><span class="chev">▾</span></button>
        <div class="wp-num" style="color:${c};border-color:${c}">${idx+1}</div>
        <input class="wp-color" type="color" value="${c}" title="Node colour"/>
        <input class="wp-name" value="${escHtml(node.name)}"/>
        <button class="wp-del">✕</button>
      </div>
      <div class="wp-summary">${node.lat.toFixed(4)}, ${node.lng.toFixed(4)} · AMSL ${amsl}${node.coverageOn?' · COV':''}</div>
      <div class="wp-body">
      <div class="wp-grid">
        <div class="wp-field"><label>LATITUDE</label>
          <input id="lat_${node.id}" type="number" step="0.000001" value="${node.lat.toFixed(6)}"/></div>
        <div class="wp-field"><label>LONGITUDE</label>
          <input id="lng_${node.id}" type="number" step="0.000001" value="${node.lng.toFixed(6)}"/></div>
      </div>
      <div class="wp-bottom">
        <label>ANT HT (m)</label>
        <input class="wp-anth" type="number" step="0.5" min="0" value="${node.antH}"/>
        <div class="wp-elev">GND:<span id="elev_${node.id}">${node.elev!==null?node.elev.toFixed(1)+'m':'…'}</span></div>
        <div class="wp-amsl">AMSL:<span id="amsl_${node.id}">${amsl}</span></div>
      </div>
      <div class="wp-cov">
        <input type="checkbox" id="cov_${node.id}" ${node.coverageOn?'checked':''}/>
        <label for="cov_${node.id}" style="cursor:pointer">COVERAGE</label>
        <button class="wp-cov-btn ${covBtnClass}" id="covBtn_${node.id}">${covBtnLabel}</button>
        <span class="wp-cov-status" id="covStat_${node.id}">${coverageStatusText(node)}</span>
      </div>
      <div class="wp-rf-toggle ${node.rfOverride?'open':''}">
        <span class="chev">▸</span> RF OVERRIDE ${node.rfOverride?'(custom)':'(using global)'}
      </div>
      <div class="wp-rf-body" id="rfBody_${node.id}" ${node.rfOverride?'':'style="display:none"'}>
        <div><label>TX dBm</label><input type="number" step="0.5" value="${rf.tx}" data-rf="txDbm"/></div>
        <div><label>Gain dBi</label><input type="number" step="0.5" value="${rf.gain}" data-rf="gainDbi"/></div>
        <div><label>RX dBm</label><input type="number" step="1" value="${rf.rx}" data-rf="rxDbm"/></div>
      </div>
      </div>`;
    // The CSP forbids inline on*= handlers (script-src has no 'unsafe-inline'),
    // so every card control is wired up here after the template is set.
    const q = sel => card.querySelector(sel);
    q('.wp-collapse').addEventListener('click', () => toggleNodeCollapse(node.id));
    q('.wp-color').addEventListener('change', ev => setNodeColor(node.id, ev.currentTarget.value));
    q('.wp-name').addEventListener('change', ev => renameNode(node.id, ev.currentTarget.value));
    q('.wp-del').addEventListener('click', () => removeNode(node.id));
    q(`#lat_${node.id}`).addEventListener('change', ev => setNodeCoord(node.id, 'lat', ev.currentTarget.value));
    q(`#lng_${node.id}`).addEventListener('change', ev => setNodeCoord(node.id, 'lng', ev.currentTarget.value));
    q('.wp-anth').addEventListener('change', ev => setNodeAntH(node.id, ev.currentTarget.value));
    q(`#cov_${node.id}`).addEventListener('change', ev => setNodeCoverageOn(node.id, ev.currentTarget.checked));
    q(`#covBtn_${node.id}`).addEventListener('click', () => computeNodeCoverage(node.id));
    q('.wp-rf-toggle').addEventListener('click', () => toggleNodeRfOverride(node.id));
    card.querySelectorAll('[data-rf]').forEach(inp => {
      inp.addEventListener('change', ev => setNodeRf(node.id, ev.currentTarget.dataset.rf, +ev.currentTarget.value));
    });
    const cardControlSelector = 'input,button,label,select,textarea';
    const restoreCardDrag = () => { card.draggable = true; };
    card.querySelectorAll(cardControlSelector).forEach(el=>{
      el.draggable=false;
      el.addEventListener('click', e=>e.stopPropagation());
      el.addEventListener('mousedown', e=>{
        card.draggable=false;
        e.stopPropagation();
      });
      el.addEventListener('pointerdown', e=>{
        card.draggable=false;
        e.stopPropagation();
        document.addEventListener('pointerup', restoreCardDrag, { once:true });
      });
      el.addEventListener('focus', () => { card.draggable=false; });
      el.addEventListener('blur', restoreCardDrag);
      el.addEventListener('dragstart', e=>e.preventDefault());
    });
    card.addEventListener('pointerdown', e => {
      if(!e.target.closest(cardControlSelector)) card.draggable=true;
    });
    card.addEventListener('click', () => selectNodeView(node.id));
    card.addEventListener('dragstart', e => {
      if(e.target.closest(cardControlSelector)){
        e.preventDefault();
        S._dragId=null;
        return;
      }
      e.dataTransfer.effectAllowed='move'; S._dragId=node.id;
    });
    card.addEventListener('dragend', () => { S._dragId=null; document.querySelectorAll('.wp-card').forEach(c=>c.classList.remove('drag-over')); });
    card.addEventListener('dragover', e => { e.preventDefault(); card.classList.add('drag-over'); });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', e => {
      e.preventDefault(); card.classList.remove('drag-over');
      if (!S._dragId || S._dragId===node.id) return;
      const fi = S.nodes.findIndex(n=>n.id===S._dragId), ti=idx;
      const [m]=S.nodes.splice(fi,1); S.nodes.splice(ti,0,m);
      refreshAllIcons(); renderNodeList();
    });
    list.appendChild(card);
  });
}

function renderEdgesPanel() {
  syncShareUrl();
  const panel = document.getElementById('edgesPanel');
  if (!S.showLinks) { panel.innerHTML='<div class="no-data">Links hidden.</div>'; return; }
  if (!S.edges.length) { panel.innerHTML='<div class="no-data">No links yet.</div>'; return; }
  const nodesById=nodeByIdMap();
  panel.innerHTML='';
  S.edges.forEach(e => {
    const a=nodesById.get(e.aId), b=nodesById.get(e.bId);
    if (!a||!b) return;
    const statusCol = !e.result ? '#4a6278' : e.result.status==='clear' ? '#2ecc71' : e.result.status==='marginal' ? '#f39c12' : '#e74c3c';
    const statusTxt = !e.result ? '' : e.result.status==='clear' ? '✓' : e.result.status==='marginal' ? '⚠' : e.result.status==='error' ? '!' : '✕';
    const isActive = S.activeView?.type==='edge' && S.activeView.id===e.id;
    const row = document.createElement('div'); row.className='edge-row'+(isActive?' active':'')+(e.hidden?' hidden':'');
    const deselectBtn = isActive ? `<button class="deselect-btn" title="Deselect (Esc)">DESELECT</button>` : '';
    row.innerHTML=`<div class="edge-dot" style="background:${statusCol}"></div>
      <div class="edge-label">${escHtml(a.name)} ↔ ${escHtml(b.name)}</div>
      <div class="edge-status" style="color:${statusCol}">${statusTxt}</div>
      ${deselectBtn}
      <button class="edge-only" title="Show only this link">ONLY</button>
      <button class="edge-vis" title="${e.hidden?'Show link':'Hide link'}">${e.hidden?'SHOW':'HIDE'}</button>
      <button class="edge-del">✕</button>`;
    const dsel = row.querySelector('.deselect-btn');
    if(dsel) dsel.addEventListener('click', ev => { ev.stopPropagation(); clearActiveView(); });
    row.querySelector('.edge-only').addEventListener('click', ev => { ev.stopPropagation(); showOnlyEdge(e.id); });
    row.querySelector('.edge-vis').addEventListener('click', ev => { ev.stopPropagation(); setEdgeHidden(e.id, !e.hidden); });
    row.querySelector('.edge-del').addEventListener('click', () => removeEdge(e.id));
    row.style.cursor='pointer';
    row.addEventListener('click', ev => {
      if (ev.target.classList.contains('edge-del')) return;
      if (e.hidden) { setEdgeHidden(e.id, false); return; }
      selectEdgeView(e.id);
    });
    row.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      showEdgeCtx(ev.clientX, ev.clientY, e);
    });
    panel.appendChild(row);
  });
}

function renderPathsPanel() {
  syncShareUrl();
  const panel = document.getElementById('pathsPanel');
  if (!S.showPaths) { panel.innerHTML='<div class="no-data">Paths hidden.</div>'; return; }
  if (!S.paths.length) { panel.innerHTML='<div class="no-data">No paths defined.</div>'; return; }
  const nodesById=nodeByIdMap();
  panel.innerHTML='';
  S.paths.forEach(p => {
    // Rebuild name from current node names
    const names = pathLabel(p,nodesById);
    const isActive = S.activeView?.type==='path' && S.activeView.id===p.id;
    const row = document.createElement('div');
    row.className='path-row'+(isActive?' active':'')+(p.hidden?' hidden':'');
    const deselectBtn = isActive ? `<button class="deselect-btn" title="Deselect (Esc)">DESELECT</button>` : '';
    row.innerHTML=`<div class="path-label">${escHtml(names)}</div>
      <div class="path-actions">
        ${deselectBtn}
        <button class="path-only" title="Show only this path">ONLY</button>
        <button class="path-vis" title="${p.hidden?'Show path':'Hide path'}">${p.hidden?'SHOW':'HIDE'}</button>
        <button class="path-edit" title="Edit path (add/remove/reorder nodes)">✎</button>
        <button class="path-del">✕</button>
      </div>`;
    const dsel = row.querySelector('.deselect-btn');
    if(dsel) dsel.addEventListener('click', ev => { ev.stopPropagation(); clearActiveView(); });
    row.querySelector('.path-only').addEventListener('click', ev => { ev.stopPropagation(); showOnlyPath(p.id); });
    row.querySelector('.path-vis').addEventListener('click', ev => { ev.stopPropagation(); setPathHidden(p.id, !p.hidden); });
    row.querySelector('.path-edit').addEventListener('click', ev => { ev.stopPropagation(); editPath(p.id); });
    row.querySelector('.path-del').addEventListener('click', ev => { ev.stopPropagation(); removePath(p.id); });
    row.addEventListener('click', () => {
      if (p.hidden) { setPathHidden(p.id, false); return; }
      selectPathView(p.id);
    });
    row.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      showPathCtx(ev.clientX, ev.clientY, p);
    });
    panel.appendChild(row);
  });
  document.getElementById('pathCount').textContent = S.paths.length;
}

function renameNode(id, name) {
  const node=S.nodes.find(n=>n.id===id); if(!node) return;
  node.name=cleanName(name, node.name); setNodeTooltip(node, node.name);
}
function setNodeColor(id, value) {
  const node=S.nodes.find(n=>n.id===id); if(!node) return;
  node.color = /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
  refreshAllIcons();                       // marker pin colour
  renderNodeList();                        // card number badge + border
  if(node.coverageLayer) renderCoveragePolygon(node);  // coverage fill + outline
}
// Collapse/expand a single node card — toggles the class directly (no re-render,
// so it can't disturb focus, drag, or markers).
function toggleNodeCollapse(id) {
  const node=S.nodes.find(n=>n.id===id); if(!node) return;
  node.collapsed=!node.collapsed;
  const card=document.querySelector(`.wp-card[data-id="${id}"]`);
  if(card) card.classList.toggle('collapsed', node.collapsed);
}
function setAllNodesCollapsed(collapsed) {
  S.nodes.forEach(n=>{ n.collapsed=collapsed; });
  renderNodeList();
}
function setNodeCoord(id, field, val) {
  const node=S.nodes.find(n=>n.id===id); if(!node) return;
  const nextLat = field === 'lat' ? val : node.lat;
  const nextLng = field === 'lng' ? val : node.lng;
  if (!validLatLng(nextLat, nextLng)) {
    toast('Enter a valid latitude (-90..90) and longitude (-180..180).', 3000);
    updateNodeFields(node);
    return;
  }
  node[field]=Number(val); node.elev=null;
  if(node.marker) node.marker.setLatLng([node.lat,node.lng]);
  redrawEdgeLines(); invalidateEdgesForNode(id); fetchElev(node);
  invalidateNodeCoverage(node, true);
  // Mirror the marker-drag behaviour: a moved node re-runs the analysis so the
  // links don't sit stale after a manual coordinate edit.
  if (S.edges.length > 0) runAnalysis();
}
function setNodeAntH(id, val) {
  const node=S.nodes.find(n=>n.id===id); if(!node) return;
  node.antH=clampNum(val, 0, LIMITS.antH, node.antH || 0); updateAmslDisplay(node); invalidateEdgesForNode(id);
  invalidateNodeCoverage(node, true);
}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

// ═══════════════════════════════════════════════════════════
//  CONTEXT MENU
// ═══════════════════════════════════════════════════════════
const ctxMenu=document.getElementById('ctxMenu'), ctxTitle=document.getElementById('ctxTitle');

function buildCtx(title, items) {
  ctxTitle.textContent=title;
  while(ctxMenu.children.length>1) ctxMenu.removeChild(ctxMenu.lastChild);
  items.forEach(item=>{
    if(item==='sep'){const s=document.createElement('div');s.className='ctx-sep';ctxMenu.appendChild(s);}
    else{
      const el=document.createElement('div');
      el.className='ctx-item'+(item.danger?' danger':'');
      const icon=document.createElement('span');
      icon.className='ctx-icon';
      icon.textContent=item.icon;
      el.appendChild(icon);
      el.appendChild(document.createTextNode(item.label));
      if (item.checked != null) {
        const check=document.createElement('span');
        check.className='ctx-check';
        check.textContent=item.checked?'ON':'OFF';
        el.appendChild(check);
      }
      el.addEventListener('click', () => { closeCtx(); item.action(); });
      ctxMenu.appendChild(el);
    }
  });
}
function posCtx(cx,cy){
  ctxMenu.style.display='block';
  const mw=ctxMenu.offsetWidth,mh=ctxMenu.offsetHeight,vw=window.innerWidth,vh=window.innerHeight;
  ctxMenu.style.left=(cx+mw>vw?cx-mw:cx)+'px'; ctxMenu.style.top=(cy+mh>vh?cy-mh:cy)+'px';
}
function closeCtx(){ctxMenu.style.display='none';}

function showMapCtx(cx,cy,latlng){
  const items=[{icon:'＋',label:'Add node here',action:()=>addNode(latlng.lat,latlng.lng)}];
  if(S.edges.length>=1){items.push('sep');items.push({icon:'▶',label:'Re-analyse',action:runAnalysis});}
  if(S.nodes.length>0){items.push('sep');items.push({icon:'✕',label:'Clear all',danger:true,action:clearAll});}
  buildCtx('MAP',items); posCtx(cx,cy);
}

function showNodeCtx(cx,cy,node){
  const idx=S.nodes.indexOf(node);
  // Build connect-to submenu options
  const connectItems = S.nodes.filter(n=>n.id!==node.id).map(n=>({
    icon:'↔', label:`Connect to ${n.name}`, action:()=>addEdge(node.id,n.id)
  }));
  const items=[
    {icon:'✎',label:'Rename…',action:()=>{const nm=prompt('Node name:',node.name);if(nm?.trim()){renameNode(node.id,nm.trim());renderNodeList();}}},
    'sep',
    ...connectItems,
    'sep',
    {icon:'↑',label:'Insert node before',action:()=>insertNodeAt(idx)},
    {icon:'↓',label:'Insert node after', action:()=>insertNodeAt(idx+1)},
    'sep',
    {icon:'🗑',label:`Delete "${node.name}"`,danger:true,action:()=>removeNode(node.id)},
  ];
  buildCtx(`NODE ${idx+1}`,items); posCtx(cx,cy);
}

function showEdgeCtx(cx,cy,edge){
  const a=S.nodes.find(n=>n.id===edge.aId), b=S.nodes.find(n=>n.id===edge.bId);
  const items=[
    {icon:edge.hidden?'◌':'●',label:edge.hidden?'Show link':'Hide link',action:()=>setEdgeHidden(edge.id,!edge.hidden)},
    {icon:'◉',label:'Show only this link',action:()=>showOnlyEdge(edge.id)},
    'sep',
    {icon:'🗑',label:`Delete link ${a?.name||'?'} ↔ ${b?.name||'?'}`,danger:true,action:()=>removeEdge(edge.id)},
  ];
  buildCtx('LINK',items); posCtx(cx,cy);
}

function showPathCtx(cx,cy,path){
  const names=path.nodeIds.map(id=>S.nodes.find(n=>n.id===id)?.name||'?').join(' → ');
  const items=[
    {icon:path.hidden?'◌':'●',label:path.hidden?'Show path':'Hide path',action:()=>setPathHidden(path.id,!path.hidden)},
    {icon:'◉',label:'Show only this path',action:()=>showOnlyPath(path.id)},
    'sep',
    {icon:'✎',label:'Edit path',action:()=>editPath(path.id)},
    {icon:'🗑',label:`Delete path ${names}`,danger:true,action:()=>removePath(path.id)},
  ];
  buildCtx('PATH',items); posCtx(cx,cy);
}

function attachEdgeHandlers(edge){
  const target=edge.hitLine||edge.line;
  if(!target) return;
  target.on('click',e=>{
    L.DomEvent.stopPropagation(e.originalEvent);
    selectEdgeView(edge.id);
  });
  target.on('mousemove',e=>handleMapLineHover(edge,e.latlng));
  target.on('mouseout',hideProfileCursor);
  target.on('contextmenu',e=>{
    L.DomEvent.preventDefault(e.originalEvent);
    L.DomEvent.stopPropagation(e.originalEvent);
    showEdgeCtx(e.originalEvent.clientX,e.originalEvent.clientY,edge);
  });
}

function insertNodeAt(idx){
  const ref=S.nodes[Math.min(idx,S.nodes.length-1)];
  const node={id:S.nextId++,name:defaultNodeName(S.nodes.length),lat:ref.lat+0.003,lng:ref.lng+0.003,antH:6,elev:null,marker:null,
    rfOverride:false,txDbm:null,gainDbi:null,rxDbm:null,
    coverageOn:false,coverageLayer:null,coverageDirty:true,coverageComputed:false};
  S.nodes.splice(idx,0,node);
  node.marker=makeMarker(node);
  refreshAllIcons(); renderNodeList(); fetchElev(node);
  document.getElementById('wpCount').textContent=S.nodes.length;
}

function isSelectionControlTarget(target){
  return !!target?.closest?.([
    '#ctxMenu',
    '.modal',
    '.wp-card',
    '.edge-row',
    '.path-row',
    '.hop-card',
    '.chart-tab',
    '.leaflet-marker-icon',
    '.leaflet-interactive',
    'button',
    'input',
    'select',
    'textarea',
    'label',
    'a'
  ].join(','));
}

document.addEventListener('click',e=>{
  if(!ctxMenu.contains(e.target)) closeCtx();
  if(!S.activeView||isSelectionControlTarget(e.target)) return;
  const blankPanel=e.target.closest?.('.wp-scroll,.edges-panel,.paths-panel,.results-area,.chart-panel,.sidebar');
  if(blankPanel) clearActiveView();
});
document.addEventListener('keydown',e=>{
  if(e.key!=='Escape') return;
  if(ctxMenu.style.display==='block'){closeCtx();return;}
  if(document.getElementById('settingsModal')?.classList.contains('open')){closeSettings();return;}
  if(document.getElementById('shareModal')?.classList.contains('open')){closeShare();return;}
  if(document.getElementById('pathModal')?.classList.contains('open')){closePathModal();return;}
  if(document.getElementById('helpModal')?.classList.contains('open')){closeHelp();return;}
  const t=e.target;
  if(t&&(t.tagName==='INPUT'||t.tagName==='SELECT'||t.tagName==='TEXTAREA'||t.isContentEditable)) return;
  if(S.activeView) clearActiveView();
});
document.getElementById('map').addEventListener('contextmenu',e=>e.preventDefault());

// ═══════════════════════════════════════════════════════════
//  GO TO MY LOCATION
// ═══════════════════════════════════════════════════════════
function goToMyLocation(){
  if(!navigator.geolocation){toast('Geolocation not supported by this browser.',3000);return;}
  toast('Finding your location…');
  navigator.geolocation.getCurrentPosition(pos=>{
    const{latitude:lat,longitude:lng}=pos.coords;
    S.map.setView([lat,lng],14);
    hideToast();
    // Add a temporary pulse circle
    const circle=L.circle([lat,lng],{radius:50,color:var_accent(),fillColor:var_accent(),fillOpacity:.2,weight:2}).addTo(S.map);
    setTimeout(()=>S.map.removeLayer(circle),4000);
  },err=>{hideToast();toast('Could not get location: '+err.message,3000);});
}
function var_accent(){return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#00c8f0';}

// ═══════════════════════════════════════════════════════════
//  ELEVATION — AWS Open Terrain Tiles (Terrarium PNG encoding)
//  Tiles are fetched once and decoded to Float32 elevation grids.
//  No API key, no rate limit, ~30 m global resolution.
// ═══════════════════════════════════════════════════════════
const TERRAIN_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const TERRAIN_Z = 12;            // ~38 m / pixel at the equator
const TILE_SIZE = 256;
const _tileCache = new Map();    // key "z/x/y" → Promise<Float32Array(256*256)>
const TILE_CACHE_MAX = 256;      // ~262 KB per decoded tile → caps at ~67 MB
const sleep = ms => new Promise(r => setTimeout(r, ms));

function lng2tileX(lng, z){ return (lng + 180) / 360 * Math.pow(2, z); }
function lat2tileY(lat, z){
  const r = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(r) + 1/Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
}

function loadTile(z, x, y){
  const key = `${z}/${x}/${y}`;
  if(_tileCache.has(key)){
    // LRU refresh: re-insert so tiles in active use aren't the first evicted.
    const hit = _tileCache.get(key);
    _tileCache.delete(key);
    _tileCache.set(key, hit);
    return hit;
  }
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try{
        const cvs = document.createElement('canvas');
        cvs.width = TILE_SIZE; cvs.height = TILE_SIZE;
        const ctx = cvs.getContext('2d');
        ctx.drawImage(img, 0, 0, TILE_SIZE, TILE_SIZE);
        const data = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
        const out = new Float32Array(TILE_SIZE * TILE_SIZE);
        for(let i = 0, j = 0; i < data.length; i += 4, j++){
          out[j] = (data[i] * 256 + data[i+1] + data[i+2] / 256) - 32768;
        }
        resolve(out);
      }catch(e){ reject(e); }
    };
    img.onerror = () => reject(new Error(`Tile load failed: ${key}`));
    img.src = TERRAIN_TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  });
  _tileCache.set(key, p);
  trimCache(_tileCache, TILE_CACHE_MAX);
  return p;
}

async function tileElevAt(lat, lng, z = TERRAIN_Z){
  const n = Math.pow(2, z);
  const fx = lng2tileX(lng, z), fy = lat2tileY(lat, z);
  const tx = ((Math.floor(fx) % n) + n) % n;
  const ty = Math.max(0, Math.min(n - 1, Math.floor(fy)));
  const grid = await loadTile(z, tx, ty);
  // Bilinear interp within the tile
  const px = (fx - Math.floor(fx)) * TILE_SIZE;
  const py = (fy - Math.floor(fy)) * TILE_SIZE;
  const x0 = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(px)));
  const y0 = Math.max(0, Math.min(TILE_SIZE - 1, Math.floor(py)));
  const x1 = Math.min(TILE_SIZE - 1, x0 + 1);
  const y1 = Math.min(TILE_SIZE - 1, y0 + 1);
  const dx = px - x0, dy = py - y0;
  const e00 = grid[y0 * TILE_SIZE + x0];
  const e10 = grid[y0 * TILE_SIZE + x1];
  const e01 = grid[y1 * TILE_SIZE + x0];
  const e11 = grid[y1 * TILE_SIZE + x1];
  return e00 * (1-dx)*(1-dy) + e10 * dx*(1-dy) + e01 * (1-dx)*dy + e11 * dx*dy;
}

// Kept for backward compatibility with the LOS analyser path
async function getElevationBatch(lats, lngs){
  return Promise.all(lats.map((lat, i) => tileElevAt(+lat, +lngs[i])));
}

async function fetchElevSingle(lat,lng){
  const key=`${(+lat).toFixed(5)},${(+lng).toFixed(5)}`;
  if(S.elevCache[key]!==undefined) return S.elevCache[key];
  const v=await tileElevAt(+lat,+lng);
  S.elevCache[key]=v??0;
  trimCache(S.elevCache, 5000);
  return S.elevCache[key];
}

async function fetchElev(node){
  const key=`${(+node.lat).toFixed(5)},${(+node.lng).toFixed(5)}`;
  try{
    const elev=await fetchElevSingle(node.lat,node.lng);
    if(key!==`${(+node.lat).toFixed(5)},${(+node.lng).toFixed(5)}`) return;
    node.elev=elev;
  }catch{
    if(key!==`${(+node.lat).toFixed(5)},${(+node.lng).toFixed(5)}`) return;
    node.elev=null;
  }
  updateElevDisplay(node);
}

function updateElevDisplay(node){
  const el=document.getElementById(`elev_${node.id}`);
  if(el) el.textContent=node.elev!==null?node.elev.toFixed(1)+'m':'?';
  updateAmslDisplay(node);
}

function updateAmslDisplay(node){
  const el=document.getElementById(`amsl_${node.id}`);
  if(el) el.textContent=node.elev!==null?(node.elev+node.antH).toFixed(1)+'m':'?';
  // Refresh icon tooltip
  setNodeTooltip(node, `${node.name}\nGND: ${node.elev!==null?node.elev.toFixed(1):'?'}m  ANT: +${node.antH}m  AMSL: ${node.elev!==null?(node.elev+node.antH).toFixed(1)+'m':'?'}`);
}

async function fetchProfile(lat1,lng1,lat2,lng2,N=80){
  const profileKey=[lat1,lng1,lat2,lng2,N].map(v=>Number(v).toFixed(5)).join(',');
  if(S.profileCache[profileKey]) return [...S.profileCache[profileKey]];
  const lats=[],lngs=[];
  for(let i=0;i<=N;i++){const t=i/N;lats.push((lat1+(lat2-lat1)*t).toFixed(5));lngs.push((lng1+(lng2-lng1)*t).toFixed(5));}
  const CHUNK=100; const elevs=[];
  for(let i=0;i<lats.length;i+=CHUNK){
    const bl=lats.slice(i,i+CHUNK),bg=lngs.slice(i,i+CHUNK);
    const batch=await getElevationBatch(bl,bg);
    if(!Array.isArray(batch)||batch.length!==bl.length||batch.some(v=>v===null||v===undefined||Number.isNaN(Number(v)))) {
      throw new Error('Elevation profile returned incomplete data');
    }
    batch.forEach(v=>elevs.push(Number(v)));
  }
  S.profileCache[profileKey]=[...elevs];
  trimCache(S.profileCache, 300);
  return elevs;
}

// ═══════════════════════════════════════════════════════════
//  SURFACE CLUTTER — ESA WorldCover via Terrascope WMS
//  Requests the exact bbox as one PNG, decodes WorldCover palette colours, then
//  maps each class to a clutter height. Failures are non-fatal: the caller falls
//  back to bare terrain.
// ═══════════════════════════════════════════════════════════
const _clutterImgCache = new Map(); // url → Promise<{data,w,h}>
let _clutterUnavailable = false;    // sticky: once load fails, stop retrying this session

function worldCoverClassFromRgb(r,g,b,a){
  if(a === 0) return 0;
  let best = 0, bestD = Infinity;
  WORLDCOVER_PALETTE.forEach(p=>{
    const dr=r-p.rgb[0], dg=g-p.rgb[1], db=b-p.rgb[2];
    const d=dr*dr+dg*dg+db*db;
    if(d<bestD){bestD=d;best=p.cls;}
  });
  return bestD <= 900 ? best : 0;
}

function loadClutterImage(url, w, h){
  if(_clutterImgCache.has(url)) return _clutterImgCache.get(url);
  const p = new Promise((resolve, reject)=>{
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try{
        const cvs = document.createElement('canvas');
        cvs.width = w; cvs.height = h;
        const ctx = cvs.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        resolve({data,w,h});
      }catch(e){ reject(new Error(`canvas decode failed (${e.message||e})`)); }
    };
    img.onerror = () => reject(new Error('image request failed'));
    img.src = url;
  });
  _clutterImgCache.set(url, p);
  // Decoded clutter images can be up to 2048×2048 RGBA (~16 MB) — keep few.
  trimCache(_clutterImgCache, 8);
  return p;
}

function makeClutterImpactStats(){
  return { total:0, hits:0, sum:0, max:0, maxDist:0, maxLatLng:null, maxAz:null, blockedByClutter:0, maxLossDb:0 };
}

function addClutterImpact(stats, h, dist, latlng, az){
  if(!stats) return;
  stats.total++;
  if(!(h > 0)) return;
  stats.hits++;
  stats.sum += h;
  if(h > stats.max){
    stats.max = h;
    stats.maxDist = dist || 0;
    stats.maxLatLng = latlng || null;
    stats.maxAz = az ?? null;
  }
}

function clutterImpactSummary(stats){
  if(!stats || !stats.total) return 'no sampled clutter points';
  const avg = stats.hits ? stats.sum / stats.hits : 0;
  const maxWhere = stats.maxLatLng
    ? ` @ ${(stats.maxDist/1000).toFixed(2)}km${stats.maxAz!=null?`, az ${stats.maxAz.toFixed(0)}°`:''} (${stats.maxLatLng[0].toFixed(5)},${stats.maxLatLng[1].toFixed(5)})`
    : '';
  return `${stats.hits}/${stats.total} sampled points had clutter; max +${stats.max.toFixed(1)}m${maxWhere}; avg +${avg.toFixed(1)}m where present`;
}

function clutterAttenDbPerM(freqMHz, refDbPerM = CLUTTER_ATTEN_DB_PER_M_915){
  // Foliage/building-edge loss rises with frequency; this is a pragmatic
  // wideband scaling around the 915 MHz reference, not a site-calibrated model.
  const f = clampNum(freqMHz, 1, 100000, 915);
  const ref = clampNum(refDbPerM, 0, 1, CLUTTER_ATTEN_DB_PER_M_915);
  return ref * Math.sqrt(f / 915);
}

function clutterAttenuationDb(clutterH, dists, losAt, bareEffAt, startIdx, endIdx, freqMHz, refDbPerM){
  if(!clutterH) return 0;
  const dbPerM = clutterAttenDbPerM(freqMHz, refDbPerM);
  let loss = 0;
  for(let j = startIdx; j < endIdx; j++){
    const h = clutterH[j] || 0;
    if(!(h > 0)) continue;
    const los = losAt(j);
    const bareEff = bareEffAt(j);
    if(los <= bareEff) continue; // bare terrain already owns the obstruction
    if(los >= bareEff + h) continue;
    const frac = Math.max(0.15, Math.min(1, (bareEff + h - los) / h));
    const segM = j > 0 ? Math.max(0, dists[j] - dists[j-1]) : 0;
    loss += segM * dbPerM * frac;
    if(loss >= CLUTTER_ATTEN_CAP_DB) return CLUTTER_ATTEN_CAP_DB;
  }
  return Math.min(CLUTTER_ATTEN_CAP_DB, loss);
}

function lonLatToTile(lng, lat, z){
  const latRad = lat * Math.PI / 180;
  const n = 2 ** z;
  return {
    x: Math.floor((lng + 180) / 360 * n),
    y: Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n)
  };
}

function tileToQuadKey(x, y, z){
  let q = '';
  for(let i = z; i > 0; i--){
    let digit = 0;
    const mask = 1 << (i - 1);
    if((x & mask) !== 0) digit += 1;
    if((y & mask) !== 0) digit += 2;
    q += digit;
  }
  return q;
}

function canopyTileKeysForBbox(minLat, minLng, maxLat, maxLng){
  const nw = lonLatToTile(minLng, maxLat, CANOPY_TILE_Z);
  const se = lonLatToTile(maxLng, minLat, CANOPY_TILE_Z);
  const keys = [];
  for(let y = Math.max(0, nw.y); y <= se.y; y++){
    for(let x = Math.max(0, nw.x); x <= se.x; x++){
      keys.push(tileToQuadKey(x, y, CANOPY_TILE_Z));
    }
  }
  return keys;
}

function canopyBboxUrl(tile, minLat, minLng, maxLat, maxLng, cols, rows){
  const cog = `${CANOPY_COG_BASE}${tile}.tif`;
  const qs = new URLSearchParams({
    url: cog,
    rescale: `0,${CANOPY_MAX_M}`,
    colormap_name: 'gray',
    return_mask: 'true',
    resampling: 'bilinear'
  });
  return `${CANOPY_GFW_BBOX}${minLng},${minLat},${maxLng},${maxLat}/${cols}x${rows}.png?${qs.toString()}`;
}

// Build a land-cover→clutter-height sampler over [minLat,minLng]–[maxLat,maxLng]
// at ~stepM resolution. `heights` maps WorldCover class → metres. Returns a
// sampler {heightAt(lat,lng)} or null if no data could be loaded (→ bare earth).
async function buildWorldCoverGrid(minLat, minLng, maxLat, maxLng, stepM, heights){
  if(_clutterUnavailable){ dlog('Clutter: skipped (data unavailable earlier this session)','warn'); return null; }
  const midLat = (minLat + maxLat) / 2;
  const dLat = stepM / 111320;
  const dLng = stepM / (111320 * Math.max(0.05, Math.cos(midLat * Math.PI/180)));
  const cols = Math.min(2048, Math.max(2, Math.ceil((maxLng - minLng) / dLng) + 1));
  const rows = Math.min(2048, Math.max(2, Math.ceil((maxLat - minLat) / dLat) + 1));
  for(const src of WORLDCOVER_WMS_SOURCES){
    const qs = new URLSearchParams({
      SERVICE:'WMS',
      VERSION:'1.3.0',
      REQUEST:'GetMap',
      LAYERS:src.layer,
      STYLES:'',
      CRS:'EPSG:4326',
      BBOX:`${minLat},${minLng},${maxLat},${maxLng}`,
      WIDTH:String(cols),
      HEIGHT:String(rows),
      FORMAT:'image/png',
      TRANSPARENT:'true'
    });
    if(src.time) qs.set('TIME', src.time);
    const url = `${src.url}?${qs.toString()}`;
    dlog(`WorldCover ${src.name}: fetching ${cols}×${rows} WMS image …`);
    let img;
    try{
      img = await loadClutterImage(url, cols, rows);
    }catch(e){
      dlog(`Clutter source status: ${src.name} FAILED — ${e.message||e}`,'err');
      continue;
    }
    const classes = new Uint8Array(cols * rows);
    let filled = 0;
    for(let i=0,j=0;i<img.data.length;i+=4,j++){
      const cls = worldCoverClassFromRgb(img.data[i],img.data[i+1],img.data[i+2],img.data[i+3]);
      classes[j] = cls;
      if(cls) filled++;
    }
    if(!filled){
      dlog('Clutter: Terrascope returned no class pixels (left as bare terrain)','warn');
      return null;
    }
    dlog(`Clutter source status: ${src.name} OK (${filled}/${classes.length} classified pixels)`,'ok');
    return {
      source: src.name,
      classAt(lat, lng){
        const c = Math.max(0, Math.min(cols-1, Math.floor((lng - minLng) / (maxLng - minLng) * cols)));
        const r = Math.max(0, Math.min(rows-1, Math.floor((maxLat - lat) / (maxLat - minLat) * rows)));
        return classes[r * cols + c] || 0;
      },
      heightAt(lat, lng){
        const cls = this.classAt(lat, lng);
        return heights[cls] || 0;
      }
    };
  }
  dlog('Clutter: all Terrascope WMS sources failed (left as bare terrain)','err');
  _clutterUnavailable = true;
  return null;
}

async function buildCanopyGrid(minLat, minLng, maxLat, maxLng, stepM){
  const midLat = (minLat + maxLat) / 2;
  const dLat = stepM / 111320;
  const dLng = stepM / (111320 * Math.max(0.05, Math.cos(midLat * Math.PI/180)));
  const cols = Math.min(2048, Math.max(2, Math.ceil((maxLng - minLng) / dLng) + 1));
  const rows = Math.min(2048, Math.max(2, Math.ceil((maxLat - minLat) / dLat) + 1));
  const tiles = canopyTileKeysForBbox(minLat, minLng, maxLat, maxLng);
  if(!tiles.length) return null;
  if(tiles.length > 12){
    dlog(`Canopy source status: skipped (${tiles.length} tiles would be needed for this bbox)`,'warn');
    return null;
  }
  const heights = new Float32Array(cols * rows);
  let loaded = 0, nonZero = 0, maxH = 0;
  dlog(`Meta/WRI canopy via GFW: fetching ${tiles.length} tile${tiles.length>1?'s':''} (${cols}×${rows}) in parallel …`);
  // Fetch all tiles concurrently — GFW's cold COG read dominates, so overlapping
  // them turns a sum of latencies into the slowest single one.
  const results = await Promise.all(tiles.map(async tile => {
    const url = canopyBboxUrl(tile, minLat, minLng, maxLat, maxLng, cols, rows);
    try { return { tile, img: await loadClutterImage(url, cols, rows) }; }
    catch(e){ dlog(`Canopy source status: tile ${tile} FAILED — ${e.message||e}`,'err'); return { tile, img: null }; }
  }));
  for(const { img } of results){
    if(!img) continue;
    loaded++;
    for(let i=0,j=0;i<img.data.length;i+=4,j++){
      if(img.data[i+3] === 0) continue;
      const h = (img.data[i] / 255) * CANOPY_MAX_M;
      if(!(h > 0.25)) continue;
      if(h > heights[j]){
        if(heights[j] === 0) nonZero++;
        heights[j] = h;
        if(h > maxH) maxH = h;
      }
    }
  }
  if(!loaded){
    dlog('Canopy source status: GFW/Meta-WRI unavailable (using WorldCover fallback)','warn');
    return null;
  }
  dlog(`Canopy source status: GFW/Meta-WRI OK (${loaded}/${tiles.length} tile${tiles.length>1?'s':''}, ${nonZero}/${heights.length} pixels >0m, max ${maxH.toFixed(1)}m)`,'ok');
  return {
    source: 'GFW/Meta-WRI canopy height',
    heightAt(lat, lng){
      const c = Math.max(0, Math.min(cols-1, Math.floor((lng - minLng) / (maxLng - minLng) * cols)));
      const r = Math.max(0, Math.min(rows-1, Math.floor((maxLat - lat) / (maxLat - minLat) * rows)));
      return heights[r * cols + c] || 0;
    }
  };
}

async function buildClutterGrid(minLat, minLng, maxLat, maxLng, stepM, heights){
  // Canopy and land-cover are independent fetches — run them concurrently.
  const [canopy, landCover] = await Promise.all([
    buildCanopyGrid(minLat, minLng, maxLat, maxLng, stepM),
    buildWorldCoverGrid(minLat, minLng, maxLat, maxLng, stepM, heights)
  ]);
  if(canopy && landCover){
    return {
      source: `${canopy.source} gated to WorldCover trees + ${landCover.source || 'WorldCover land cover'}`,
      heightAt(lat, lng){
        const cls = landCover.classAt?.(lat, lng);
        const landCoverH = landCover.heightAt(lat, lng);
        const canopyH = (cls === 10 || cls === 95) ? canopy.heightAt(lat, lng) : 0;
        return Math.max(canopyH, landCoverH);
      }
    };
  }
  if(canopy && !landCover){
    dlog('Canopy source status: loaded but not applied because WorldCover tree-class gate was unavailable','warn');
  }
  return landCover || null;
}

// Resolve the active per-class clutter height table from the UI (forest +
// built-up are user-set; the rest are fixed defaults).
function clutterHeightTable(){
  const t = { ...CLUTTER_HEIGHT_DEFAULT };
  const forest = parseFloat(document.getElementById('inpClutterForest')?.value);
  const urban = parseFloat(document.getElementById('inpClutterUrban')?.value);
  if(Number.isFinite(forest)) t[10] = t[95] = forest;
  if(Number.isFinite(urban)) t[50] = urban;
  return t;
}

function clutterEnabled(){
  return !!document.getElementById('inpClutterOn')?.checked;
}

// ═══════════════════════════════════════════════════════════
//  MATHS
// ═══════════════════════════════════════════════════════════
const R_EARTH=6371000;
const toRad=d=>d*Math.PI/180;
function haversine(la1,lo1,la2,lo2){
  const dLa=toRad(la2-la1),dLo=toRad(lo2-lo1);
  const a=Math.sin(dLa/2)**2+Math.cos(toRad(la1))*Math.cos(toRad(la2))*Math.sin(dLo/2)**2;
  return 2*R_EARTH*Math.asin(Math.sqrt(a));
}
function bulge(d1,d2,K){return d1*d2/(2*K*R_EARTH);}
function fresnel1(d1,d2,fMHz){const lam=3e8/(fMHz*1e6);return Math.sqrt(lam*d1*d2/(d1+d2));}

// Single knife-edge diffraction loss (dB) from the Fresnel-Kirchhoff diffraction
// parameter ν, using the ITU-R P.526 approximation J(ν). Valid for ν > -0.78;
// below that the obstruction clears the LOS line by enough that the loss is
// negligible (≈0 dB). At ν=0 (terrain grazing the LOS line) this returns ~6 dB,
// rising as the obstruction intrudes further into the path.
function knifeEdgeLossDb(nu){
  if(nu <= -0.78) return 0;
  const t = Math.sqrt((nu - 0.1)**2 + 1) + nu - 0.1;
  return 6.9 + 20 * Math.log10(t);
}

function fsplDb(distM, fMHz){
  return 20*Math.log10(Math.max(distM,1)/1000)+20*Math.log10(fMHz)+32.44;
}

// Coverage is drawn in each node's own colour so overlapping nodes stay
// distinguishable; signal strength is shown by fill opacity instead of hue —
// more opaque = stronger margin, fading out to the coverage edge. Below 0 dB the
// link budget doesn't close, so there's no coverage to paint (level 0 = blank).
const COVERAGE_GREEN_DB = 24;     // margin (dB) at/above which coverage is full strength
const COVERAGE_LEVELS = 5;        // strength quantisation so adjacent samples merge into runs
const COVERAGE_FILL_MIN = 0.1;    // fill opacity at the weakest covered level
const COVERAGE_FILL_MAX = 0.4;    // fill opacity at full strength (kept light/transparent)
function coverageLevel(marginDb){
  if(!(marginDb >= 0)) return 0;                    // no coverage
  const t = Math.min(1, marginDb / COVERAGE_GREEN_DB);
  return 1 + Math.round(t * (COVERAGE_LEVELS - 1)); // 1..COVERAGE_LEVELS
}
function coverageLevelOpacity(level){
  if(level <= 0) return 0;
  const t = COVERAGE_LEVELS > 1 ? (level - 1) / (COVERAGE_LEVELS - 1) : 1;
  return COVERAGE_FILL_MIN + t * (COVERAGE_FILL_MAX - COVERAGE_FILL_MIN);
}

// Bearing → destination point on a sphere (great-circle).
function destPoint(lat, lng, bearingDeg, distM){
  const R = R_EARTH, br = bearingDeg * Math.PI / 180;
  const ph1 = lat * Math.PI / 180, la1 = lng * Math.PI / 180;
  const d = distM / R;
  const ph2 = Math.asin(Math.sin(ph1)*Math.cos(d) + Math.cos(ph1)*Math.sin(d)*Math.cos(br));
  const la2 = la1 + Math.atan2(Math.sin(br)*Math.sin(d)*Math.cos(ph1), Math.cos(d) - Math.sin(ph1)*Math.sin(ph2));
  return [ph2 * 180 / Math.PI, ((la2 * 180 / Math.PI + 540) % 360) - 180];
}

// Friis free-space range (metres). Returns null if the link budget is non-positive.
function friisRangeMeters(txDbm, gainTx, gainRx, rxSensDbm, fMHz, marginDb){
  const allowed = txDbm + gainTx + gainRx - rxSensDbm - (marginDb || 0);
  if(!isFinite(allowed) || allowed <= 0) return null;
  // FSPL_dB = 20·log10(d_km) + 20·log10(fMHz) + 32.44
  const logKm = (allowed - 20 * Math.log10(fMHz) - 32.44) / 20;
  const m = Math.pow(10, logKm) * 1000;
  return Math.max(50, Math.min(m, 500000)); // clamp 50 m … 500 km
}

// ═══════════════════════════════════════════════════════════
//  COVERAGE  —  per-node radial sweep, polygon rendering
// ═══════════════════════════════════════════════════════════
// Per-preset full settings bundle: link budget + coverage modelling defaults.
// Meshtastic & ham VHF/UHF use Fresnel=40% + 6 dB margin: the Fresnel zone still
// matters (partial obstruction adds diffraction loss), but these links tolerate
// some encroachment — the few dB of loss at ~40% clearance is what the 6 dB
// margin absorbs. Requiring the full 60% here would double-count that margin.
// Wi-Fi presets use Fresnel=60% + 10 dB margin (sustained-link engineering).
const PRESET_RF = {
  '915':  {tx:22, gain:2, rx:-130, margin:6,  fresnel:'0.4', maxKm:50, clutterAtten:0.10},
  '868':  {tx:22, gain:2, rx:-130, margin:6,  fresnel:'0.4', maxKm:50, clutterAtten:0.10},
  '433':  {tx:22, gain:2, rx:-130, margin:6,  fresnel:'0.4', maxKm:50, clutterAtten:0.10},
  '146':  {tx:37, gain:0, rx:-120, margin:6,  fresnel:'0.4', maxKm:50, clutterAtten:0.10},
  '438':  {tx:37, gain:0, rx:-120, margin:6,  fresnel:'0.4', maxKm:30, clutterAtten:0.10},
  '2400': {tx:20, gain:2, rx:-85,  margin:10, fresnel:'0.6', maxKm:5,  clutterAtten:0.10},
  '5800': {tx:20, gain:3, rx:-80,  margin:10, fresnel:'0.6', maxKm:5,  clutterAtten:0.10}
};

function globalRf(){
  return {
    freq: clampNum(document.getElementById('inpFreq').value, LIMITS.freqMin, LIMITS.freqMax, 915),
    K: clampNum(document.getElementById('inpK').value, LIMITS.kMin, LIMITS.kMax, 1.333),
    tx: clampNum(document.getElementById('inpTx').value, -100, 100, 22),
    gain: clampNum(document.getElementById('inpGain').value, -100, 100, 0),
    rx: clampNum(document.getElementById('inpRx').value, -200, 0, -130),
    margin: clampNum(document.getElementById('inpMargin').value, 0, 100, 0),
    rxAntH: clampNum(document.getElementById('inpRxAntH').value, 0, LIMITS.rxAntH, 2),
    rays: optionNum(parseInt(document.getElementById('inpCovRays').value), COVERAGE_RAY_OPTIONS, 72),
    samples: optionNum(parseInt(document.getElementById('inpCovSamples').value), COVERAGE_SAMPLE_OPTIONS, 50),
    fresnelPct: optionNum(parseFloat(document.getElementById('inpCovFresnel').value), FRESNEL_OPTIONS, 0.4),
    maxKm: clampNum(document.getElementById('inpCovMaxKm').value, 1, LIMITS.covMaxKm, 30),
    clutterOn: clutterEnabled(),
    clutterExcludeM: clampNum(document.getElementById('inpClutterExclude')?.value, 0, 5000, 100),
    clutterAttenRef: clampNum(document.getElementById('inpClutterAtten')?.value, 0, 1, CLUTTER_ATTEN_DB_PER_M_915),
    clutterHeights: clutterHeightTable()
  };
}

function effectiveRf(node){
  const g = globalRf();
  if(node.rfOverride){
    return {
      tx:   node.txDbm   ?? g.tx,
      gain: node.gainDbi ?? g.gain,
      rx:   node.rxDbm   ?? g.rx
    };
  }
  return {tx:g.tx, gain:g.gain, rx:g.rx};
}

function onGlobalRfChanged(){
  // Any change to global TX/Gain/Sens/Margin invalidates non-overridden node coverage.
  S.nodes.forEach(n => { if(!n.rfOverride) invalidateNodeCoverage(n, true); });
  renderNodeList();
  refreshSettingsSummary();
}

// Coverage-shape params (freq, K, Fresnel %, rays, samples, max range, RX ant)
// affect every node regardless of override status.
function onCoverageParamChanged(){
  S.nodes.forEach(n => invalidateNodeCoverage(n, true));
  renderNodeList();
  refreshSettingsSummary();
}

function applyPresetRf(presetVal){
  const rf = PRESET_RF[presetVal];
  if(!rf) return;
  document.getElementById('inpTx').value = rf.tx;
  document.getElementById('inpGain').value = rf.gain;
  document.getElementById('inpRx').value = rf.rx;
  if(rf.margin   != null) document.getElementById('inpMargin').value     = rf.margin;
  if(rf.fresnel  != null) document.getElementById('inpCovFresnel').value = rf.fresnel;
  if(rf.maxKm    != null) document.getElementById('inpCovMaxKm').value   = rf.maxKm;
  if(rf.clutterAtten != null) document.getElementById('inpClutterAtten').value = rf.clutterAtten;
  // Preset change touches freq + RF + coverage modelling — invalidate every node.
  S.nodes.forEach(n => invalidateNodeCoverage(n, true));
  renderNodeList();
  refreshSettingsSummary();
}

function setNodeRf(id, field, val){
  const node = S.nodes.find(n => n.id === id); if(!node) return;
  node[field] = val;
  invalidateNodeCoverage(node, true);
  renderNodeList();
}

function toggleNodeRfOverride(id){
  const node = S.nodes.find(n => n.id === id); if(!node) return;
  node.rfOverride = !node.rfOverride;
  if(node.rfOverride && node.txDbm == null){
    const g = globalRf();
    node.txDbm = g.tx; node.gainDbi = g.gain; node.rxDbm = g.rx;
  }
  invalidateNodeCoverage(node, true);
  renderNodeList();
}

function invalidateNodeCoverage(node, redraw){
  node.coverageDirty = true;
  if(redraw && node.coverageLayer && node.coverageOn){
    styleCoverageLayer(node.coverageLayer,{dashArray:'4 4', fillOpacity:0.05});
  }
  updateCovBtn(node);
}

function styleCoverageLayer(layer, style){
  if(layer?.setStyle) layer.setStyle(style);
  else layer?.eachLayer?.(child=>child.setStyle?.(style));
}

function updateCovBtn(node){
  const b = document.getElementById(`covBtn_${node.id}`);
  if(!b) return;
  b.classList.remove('dirty','ok');
  if(!node.coverageComputed) b.textContent = 'COMPUTE';
  else if(node.coverageDirty){ b.textContent = 'RECOMPUTE'; b.classList.add('dirty'); }
  else { b.textContent = '✓ RECOMPUTE'; b.classList.add('ok'); }
  const st = document.getElementById(`covStat_${node.id}`);
  if(st) st.textContent = coverageStatusText(node);
}

function coverageStatusText(node){
  if(!node.coverageComputed) return '';
  if(node.coverageDirty) return 'stale';
  if(node.coverageReachMax == null || node.coverageMaxRange == null) return 'cached';
  const reason = node.coverageLimitedByBudget ? 'budget' : 'cap';
  return `max ${(node.coverageReachMax/1000).toFixed(1)}/${(node.coverageMaxRange/1000).toFixed(0)}km ${reason}`;
}

function setNodeCoverageOn(id, on){
  const node = S.nodes.find(n => n.id === id); if(!node) return;
  node.coverageOn = on;
  if(node.coverageLayer){
    if(on) node.coverageLayer.addTo(S.map);
    else S.map.removeLayer(node.coverageLayer);
  }
  updateCovCount();
  refreshOverlap();
}

function setAllCoverage(on){
  S.nodes.forEach(n => {
    n.coverageOn = on;
    if(n.coverageLayer){
      if(on) n.coverageLayer.addTo(S.map);
      else S.map.removeLayer(n.coverageLayer);
    }
    const cb = document.getElementById(`cov_${n.id}`); if(cb) cb.checked = on;
  });
  updateCovCount();
  refreshOverlap();
}

function updateCovCount(){
  refreshSettingsSummary();
}

async function computeNodeCoverage(id, _fromBatch = false){
  if(S._coverageComputing || (S._coverageBatch && !_fromBatch)){ toast('Coverage compute already running.', 2000); return; }
  S._coverageComputing = true;
  let node = null, btn = null;
  try{
    node = (typeof id === 'object') ? id : S.nodes.find(n => n.id === id);
    if(!node) return;
    btn = document.getElementById(`covBtn_${node.id}`);
    if(btn){ btn.disabled = true; btn.textContent = '…'; }
    await _computeNodeCoverageImpl(node);
  }catch(err){
    console.error('Coverage compute failed', err);
    toast(`Coverage compute failed: ${err.message||err}`, 5000);
  }finally{
    S._coverageComputing = false;
    if(btn) btn.disabled = false;
    if(node) updateCovBtn(node);
    if(!_fromBatch) refreshOverlap();
  }
}

async function _computeNodeCoverageImpl(node){
  const g = globalRf();
  const rf = effectiveRf(node);
  const friisRange = friisRangeMeters(rf.tx, rf.gain, rf.gain, rf.rx, g.freq, g.margin);
  if(!friisRange){ toast(`${node.name}: link budget too low — no coverage`, 3000); return; }
  // Cap to user-configured search radius so we don't fetch tiles forever, but
  // also honour the free-space RF link budget. The smaller one is the search
  // range the terrain sweep can actually test.
  const searchCap = g.maxKm * 1000;
  const maxRange = Math.min(friisRange, searchCap);
  const limitedByBudget = friisRange < searchCap;

  // Make sure source elevation is available
  if(node.elev == null){
    toast(`${node.name}: fetching elevation…`);
    try{ node.elev = await tileElevAt(node.lat, node.lng); updateElevDisplay(node); }
    catch(e){ throw new Error(`elevation tile fetch failed (${e.message||e})`); }
  }

  const srcH = node.elev + node.antH;
  const rays = g.rays;
  // The terrain sample step must resolve near-field hills, not just divide the
  // whole search radius into a fixed count. At a 50 km cap, 50 samples = 1 km
  // steps, which steps clean over every hill in the first kilometre and reports
  // false coverage straight through them. The DEM is ~30-40 m, so step at about
  // that resolution. The Samples setting acts as a quality floor; a hard cap
  // keeps very large search radii responsive.
  const samples = Math.max(g.samples, Math.min(COVERAGE_MAX_SAMPLES,
    Math.ceil(maxRange / COVERAGE_STEP_M)));
  const rangeReason = limitedByBudget
    ? `budget ${(friisRange/1000).toFixed(1)} km, cap ${(searchCap/1000).toFixed(0)} km`
    : `cap ${(searchCap/1000).toFixed(0)} km, Friis ${(friisRange/1000).toFixed(0)} km`;
  toast(`${node.name}: computing rays (${rangeReason}, ${(maxRange/samples).toFixed(0)} m steps)…`);
  const reach = [];   // [{az, dist, latlng}]
  const heatRays = []; // [{az, samples:[{dist, latlng, marginDb}]}]
  const clutterImpact = makeClutterImpactStats();
  // Free-space link budget (constant across the sweep): TX + both antenna gains
  // − RX sensitivity − required margin. marginDb = linkBudget − path loss.
  const linkBudget = rf.tx + rf.gain + rf.gain - rf.rx - g.margin;

  dlog(`▶ COVERAGE "${node.name}" @ ${node.lat.toFixed(5)},${node.lng.toFixed(5)}  gnd=${node.elev.toFixed(0)}m antH=${node.antH}m (src tip ${srcH.toFixed(0)}m)`);
  dlog(`  RF: ${g.freq}MHz K=${g.K} · TX ${rf.tx} +G ${rf.gain}×2 −RX ${rf.rx} −margin ${g.margin} = budget ${linkBudget.toFixed(0)}dB`);
  dlog(`  Range: Friis ${(friisRange/1000).toFixed(1)}km, cap ${g.maxKm}km → max ${(maxRange/1000).toFixed(1)}km${limitedByBudget?' (budget-limited)':''}`);
  dlog(`  Sweep: ${rays} rays × ${samples} samples (~${(maxRange/samples).toFixed(0)}m step) · Fresnel ${(g.fresnelPct*100).toFixed(0)}% · RX ant ${g.rxAntH}m`);

  // Optional land-cover clutter over the sweep bbox (null = bare terrain).
  let clutter = null;
  if(g.clutterOn){
    const dLat = maxRange / 111320;
    const dLng = maxRange / (111320 * Math.max(0.05, Math.cos(node.lat * Math.PI/180)));
    dlog(`  Clutter ON: forest ${g.clutterHeights[10]}m, urban ${g.clutterHeights[50]}m, clear-radius ${g.clutterExcludeM}m, atten ${clutterAttenDbPerM(g.freq, g.clutterAttenRef).toFixed(3)}dB/m — loading…`);
    toast(`${node.name}: loading land cover…`);
    clutter = await buildClutterGrid(node.lat - dLat, node.lng - dLng,
      node.lat + dLat, node.lng + dLng, COVERAGE_STEP_M, g.clutterHeights);
    dlog(clutter ? `  Clutter: APPLIED ✓ (${clutter.source || 'WorldCover WMS'})`
                 : `  Clutter: NOT applied — bare terrain used`, clutter?'ok':'warn');
    toast(clutter ? `${node.name}: land cover loaded.`
                  : `${node.name}: land cover unavailable — using bare terrain.`, 3500);
  } else {
    dlog('  Clutter OFF (bare-earth terrain only)');
  }

  for(let r = 0; r < rays; r++){
    const az = r * 360 / rays;
    if(r % 6 === 0) toast(`${node.name}: ray ${r+1}/${rays}…`);
    // Sample terrain along this ray (tiles are lazy-loaded; first hit may pull a few tiles)
    const dists = [], points = [];
    for(let s = 0; s <= samples; s++){
      const d = maxRange * s / samples;
      const [la, ln] = destPoint(node.lat, node.lng, az, d);
      dists.push(d);
      points.push([la, ln]);
    }
    // Fetch elevations for this ray in parallel — duplicate tile requests are de-duped by cache
    let elevs;
    try {
      elevs = await Promise.all(points.map(([la, ln]) => tileElevAt(la, ln)));
    } catch(e){
      throw new Error(`terrain tile fetch failed at ray ${r}: ${e.message||e}`);
    }
    // Per-point clutter height (m), excluded near the node (own site assumed clear).
    const clutterH = clutter ? points.map(([la, ln], i) =>
      dists[i] >= g.clutterExcludeM ? clutter.heightAt(la, ln) : 0) : null;
    if(clutterH){
      clutterH.forEach((h, i) => addClutterImpact(clutterImpact, h, dists[i], points[i], az));
    }
    const raySamples = [{dist:0, latlng:[node.lat,node.lng], marginDb:Infinity}];
    // Walk outward computing the link margin at every sample. The heatmap paints
    // every covered sample and the outline traces the farthest covered sample per
    // ray (so a node on a hill shows its true far reach, not a tiny near blob).
    let farthestIdx = 0;
    for(let s = 1; s <= samples; s++){
      const dS = dists[s];                       // distance src→candidate RX
      const rxAlt = elevs[s] + g.rxAntH;         // RX antenna tip elevation
      // Bare terrain is the hard LOS gate. Surface clutter influences Fresnel /
      // diffraction loss, but trees/buildings are not treated as new mountains:
      // otherwise one forest class around a low site collapses every ray.
      let maxNu = -Infinity, blocked = false, clutterIntrudes = false;
      const losAt = j => srcH + (rxAlt - srcH) * (dists[j] / dS);
      const bareEffAt = j => elevs[j] + bulge(dists[j], dS - dists[j], g.K);
      for(let j = 1; j < s; j++){
        const dJ = dists[j];                     // distance src→intermediate point
        const los = losAt(j);                    // LOS height above the point
        const fz = fresnel1(dJ, dS - dJ, g.freq);
        const bareEff = bareEffAt(j);
        const bareNu = fz > 0 ? Math.SQRT2*(bareEff - los)/fz : -Infinity;
        if(bareNu >= 0){ blocked = true; break; }
        const eff = bareEff + (clutterH ? clutterH[j] : 0);   // terrain + clutter + earth curvature
        const nu = fz > 0 ? Math.SQRT2*(eff - los)/fz : -Infinity;
        if(clutterH && nu >= 0) clutterIntrudes = true;
        if(nu > maxNu) maxNu = nu;
      }
      if(clutterIntrudes) clutterImpact.blockedByClutter++;
      const clutterLossDb = clutterH && !blocked ? clutterAttenuationDb(clutterH, dists, losAt, bareEffAt, 1, s, g.freq, g.clutterAttenRef) : 0;
      if(clutterLossDb > clutterImpact.maxLossDb) clutterImpact.maxLossDb = clutterLossDb;
      // Below the LOS line: free-space loss plus the (≤6 dB) grazing diffraction
      // loss from the dominant near-LOS obstruction.
      const marginDb = blocked ? -Infinity
        : linkBudget - fsplDb(dS, g.freq) - knifeEdgeLossDb(maxNu) - clutterLossDb;
      raySamples.push({dist:dS, latlng:points[s], marginDb});
      if(marginDb >= 0) farthestIdx = s;
    }
    const reachDist = dists[farthestIdx];
    const [la, ln] = destPoint(node.lat, node.lng, az, Math.max(reachDist, 1));
    reach.push({az, dist:reachDist, latlng:[la, ln]});
    heatRays.push({az, samples:raySamples});
  }

  node.coverageRays = reach;
  node.coverageHeatRays = heatRays;
  node.coverageMaxRange = maxRange;
  node.coverageSearchCap = searchCap;
  node.coverageFriisRange = friisRange;
  node.coverageLimitedByBudget = limitedByBudget;
  node.coverageReachMax = reach.reduce((m,r)=>Math.max(m,r.dist),0);
  node.coverageComputed = true;
  node.coverageDirty = false;
  const reachedRays = reach.filter(r=>r.dist>0).length;
  if(clutter){
    dlog(`  Clutter impact: ${clutterImpactSummary(clutterImpact)}; ${clutterImpact.blockedByClutter} candidate samples had clutter above LOS; max attenuation ${clutterImpact.maxLossDb.toFixed(1)}dB (cap ${CLUTTER_ATTEN_CAP_DB}dB)`,'warn');
  }
  dlog(`  ✓ "${node.name}" done: farthest reach ${(node.coverageReachMax/1000).toFixed(2)}km · ${reachedRays}/${rays} rays have coverage`,'ok');
  const limitText = limitedByBudget
    ? `budget-limited ${(maxRange/1000).toFixed(2)} km from ${(searchCap/1000).toFixed(0)} km cap`
    : `${(maxRange/1000).toFixed(0)} km cap`;
  toast(`${node.name}: terrain max ${(node.coverageReachMax/1000).toFixed(2)} km of ${limitText}.`, 3500);
  renderCoveragePolygon(node);
  updateCovBtn(node);
}

function renderCoveragePolygon(node){
  if(node.coverageLayer){ S.map.removeLayer(node.coverageLayer); node.coverageLayer = null; }
  if(!node.coverageHeatRays || node.coverageHeatRays.length < 2) return;
  const col = nodeColorFor(node);
  const group = L.layerGroup();
  const rays = node.coverageHeatRays;
  const R = rays.length;
  // Render each ray as its OWN wedge, spanning the half-angle to each neighbour
  // (so adjacent wedges tile seamlessly), and fill it to that ray's own reach.
  // Colouring by each ray independently — rather than the min of two neighbours —
  // means a ray that reaches far is shown all the way out to its edge, instead of
  // being blanked wherever a neighbouring ray happens to be shorter. Samples are
  // fine (~40 m); consecutive same-strength samples merge into one polygon, so a
  // ray collapses to a few bands (plus any disconnected far patches). Strength is
  // shown by fill opacity; blank (no-coverage) stretches are skipped.
  const mid = (P, Q, s) => [ (P[s].latlng[0]+Q[s].latlng[0])/2, (P[s].latlng[1]+Q[s].latlng[1])/2 ];
  for(let r=0;r<R;r++){
    const cur = rays[r].samples;
    const prev = rays[(r-1+R)%R].samples;
    const next = rays[(r+1)%R].samples;
    const n = Math.min(cur.length, prev.length, next.length);
    // Wedge bounded by the midline to the previous ray (left) and next ray (right).
    const addWedge = (i0, i1, level) => {
      group.addLayer(L.polygon([ mid(prev,cur,i0), mid(cur,next,i0), mid(cur,next,i1), mid(prev,cur,i1) ], {
        color: col, weight: 0, opacity: 0, fillColor: col, fillOpacity: coverageLevelOpacity(level), interactive: false
      }));
    };
    let runStart = -1, runLevel = 0;
    const flush = endIdx => { if(runStart > 0 && runLevel > 0) addWedge(runStart-1, endIdx, runLevel); runStart = -1; runLevel = 0; };
    for(let s=1;s<n;s++){
      const level = coverageLevel(cur[s].marginDb);
      if(level !== runLevel){ flush(s-1); if(level > 0){ runStart = s; runLevel = level; } }
    }
    flush(n-1);
  }
  // Outline the coverage edge — the farthest covered point per ray.
  if(node.coverageRays?.length){
    const outline = node.coverageRays.map(r=>r.latlng);
    outline.push(node.coverageRays[0].latlng);
    group.addLayer(L.polyline(outline, {
      color: col, weight: 1.5, opacity: 0.85, interactive: false
    }));
  }
  node.coverageLayer = group;
  if(node.coverageOn) node.coverageLayer.addTo(S.map);
  node.coverageLayer.eachLayer?.(layer=>layer.bringToBack?.());
}

// ── Coverage overlap highlight ──────────────────────────────
// Highlights where two or more nodes' coverage footprints overlap, intersected
// pairwise via polygon-clipping then unioned. Toggled by a button; redrawn when
// coverage changes while on. Coords are GeoJSON [lng,lat] for the clipper,
// converted back to Leaflet [lat,lng] for rendering.
//
// Each node's coverage is built as PETALS, not the simple outline: a run of
// consecutive covered rays becomes one polygon (centre → ray tips → centre),
// and blocked rays (reach ≈ 0) break the run. This matches the real, notchy
// coverage — connecting every ray tip with straight lines (the old approach)
// cross-cut across blocked directions and grossly over-stated the area.
function nodeCoveragePolygon(node){
  const rays = node.coverageRays;
  if(!rays || rays.length < 3) return null;
  const center = [node.lng, node.lat];
  const polys = [];
  let cur = null;
  const flush = () => {
    if(cur && cur.length >= 2) polys.push([[center, ...cur, center]]);
    cur = null;
  };
  for(let i = 0; i < rays.length; i++){
    if(rays[i].dist > 1) (cur || (cur = [])).push([rays[i].latlng[1], rays[i].latlng[0]]);
    else flush();
  }
  flush();
  return polys.length ? polys : null;   // GeoJSON MultiPolygon (array of polygons)
}

function renderCoverageOverlap(){
  if(S.overlapLayer){ S.map.removeLayer(S.overlapLayer); S.overlapLayer = null; }
  if(!S.showOverlap) return;
  if(typeof polygonClipping === 'undefined') return;
  const polys = S.nodes
    .filter(n => n.coverageOn)
    .map(nodeCoveragePolygon)
    .filter(Boolean);
  if(polys.length < 2) return;
  const inters = [];
  for(let i = 0; i < polys.length; i++){
    for(let j = i + 1; j < polys.length; j++){
      try{
        const r = polygonClipping.intersection(polys[i], polys[j]);
        if(r && r.length) inters.push(r);
      }catch{ /* skip degenerate pair */ }
    }
  }
  if(!inters.length) return;
  let merged;
  try{ merged = polygonClipping.union(...inters); }
  catch{ merged = inters.flat(); }
  const group = L.layerGroup();
  for(const poly of merged){
    const latlngs = poly.map(ring => ring.map(pt => [pt[1], pt[0]])); // → [lat,lng]
    // Solid, saturated fill so the overlap AREA reads as a region, not an
    // outline (a lens boundary sits on the coverage perimeters, so a heavy
    // stroke looks like "the perimeter is highlighted").
    group.addLayer(L.polygon(latlngs, {
      color: '#ffffff', weight: 1, opacity: 0.5,
      fillColor: '#ff2fd0', fillOpacity: 0.45, interactive: false
    }));
  }
  S.overlapLayer = group.addTo(S.map);
  group.eachLayer(l => l.bringToFront?.());
}

// Redraw the overlap only when the toggle is active (cheap no-op otherwise),
// so coverage-changing actions can call it unconditionally.
function refreshOverlap(){ if(S.showOverlap) renderCoverageOverlap(); }

function updateOverlapBtn(){
  const b = document.getElementById('btnCovOverlap');
  if(b) b.classList.toggle('primary', !!S.showOverlap);
}

function toggleOverlap(){
  S.showOverlap = !S.showOverlap;
  updateOverlapBtn();
  if(S.showOverlap){
    const covered = S.nodes.filter(n => n.coverageOn && n.coverageRays && n.coverageRays.length >= 3);
    if(covered.length < 2)
      toast('Compute coverage on at least 2 nodes to see overlap.', 3000);
  }
  renderCoverageOverlap();
}

async function computeAllCoverage(){
  if(S._coverageComputing || S._coverageBatch){ toast('Coverage compute already running.', 2000); return; }
  // Only sweep nodes whose COVERAGE box is ticked — computing the rest would
  // download terrain/clutter for layers that are never shown.
  const targets = S.nodes.filter(n => n.coverageOn);
  if(!targets.length){ toast('No nodes have coverage enabled — tick COVERAGE on a node first.', 3000); return; }
  S._coverageBatch = true;
  try{
    for(let i = 0; i < targets.length; i++){
      toast(`Coverage ${i+1}/${targets.length}: ${targets[i].name}`);
      await computeNodeCoverage(targets[i], true);
      await sleep(20);
    }
    toast('Coverage compute complete.', 2500);
  }finally{
    S._coverageBatch = false;
    refreshOverlap();
  }
}

// ═══════════════════════════════════════════════════════════
//  ANALYSIS  —  runs on every edge
// ═══════════════════════════════════════════════════════════
async function runAnalysis(){
  if(S._analysing){toast('Analysis is already running. Please wait for it to finish.',2500);return;}
  if(S.nodes.length<2||S.edges.length<1){toast('Add at least 2 nodes and 1 link.',3000);return;}
  S._analysing=true;
  const freq=parseFloat(document.getElementById('inpFreq').value)||900;
  const K=parseFloat(document.getElementById('inpK').value)||1.333;
  // Fresnel clearance threshold (preset-driven): 0.4 for forgiving links (Meshtastic/ham VHF/UHF),
  // 0.6 for engineered links (Wi-Fi). Used to scale the marginal-vs-clear boundary.
  const fresnelPct=Math.max(0,Math.min(1,parseFloat(document.getElementById('inpCovFresnel').value)||0));
  // Surface clutter (land cover): same model as the coverage sweep, so the two stay consistent.
  const clutterOn=clutterEnabled();
  const clutterHeights=clutterHeightTable();
  const clutterExcludeM=clampNum(document.getElementById('inpClutterExclude')?.value, 0, 5000, 100);
  const clutterAttenRef=clampNum(document.getElementById('inpClutterAtten')?.value, 0, 1, CLUTTER_ATTEN_DB_PER_M_915);
  const N=80;
  const MAX_TERRAIN_ERRORS=2;
  let terrainErrors=0;
  const preferredView=S.activeView?{...S.activeView}:null;
  toast('Analysing…');
  dlog(`▶ ANALYSE ${S.edges.length} link(s): ${freq}MHz K=${K} Fresnel ${(fresnelPct*100).toFixed(0)}%${clutterOn?` · clutter ON (forest ${clutterHeights[10]}m urban ${clutterHeights[50]}m atten ${clutterAttenDbPerM(freq, clutterAttenRef).toFixed(3)}dB/m)`:' · clutter OFF'}`);
  try{
    const nodesById=nodeByIdMap();
    for(let ei=0;ei<S.edges.length;ei++){
      const e=S.edges[ei];
      const a=nodesById.get(e.aId),b=nodesById.get(e.bId);
      if(!a||!b) continue;
      toast(`Fetching terrain: ${a.name} ↔ ${b.name} (${ei+1}/${S.edges.length})`);
      const dist=haversine(a.lat,a.lng,b.lat,b.lng);
      let elevs;
      try{
        elevs=await fetchProfile(a.lat,a.lng,b.lat,b.lng,N);
      }catch(err){
        terrainErrors++;
        e.result={dist,status:'error',error:err.message||'Terrain lookup failed'};
        e.profile=null;
        if(e.line) e.line.setStyle(edgeBaseStyle(e));
        renderResults();
        renderEdgesPanel();
        if(terrainErrors>=MAX_TERRAIN_ERRORS){
          toast(`Stopped after ${terrainErrors} terrain lookup failures. Wait a bit, then try Analyse again.`,6000);
          break;
        }
        continue;
      }
      terrainErrors=0;
      const dists=elevs.map((_,s)=>dist*s/N);

      // Ground elevation from profile endpoints (same dataset = consistent datum)
      const aGnd=elevs[0], bGnd=elevs[N];
      a.elev=aGnd; updateElevDisplay(a);
      b.elev=bGnd; updateElevDisplay(b);

      // Antenna tip = ground + antenna height
      const aH=aGnd+a.antH, bH=bGnd+b.antH;

      // Per-point clutter height (m), excluded near both endpoints (own sites clear).
      let clutterH=null;
      let clutterImpact=null;
      if(clutterOn){
        const pad=0.005;
        const grid=await buildClutterGrid(
          Math.min(a.lat,b.lat)-pad, Math.min(a.lng,b.lng)-pad,
          Math.max(a.lat,b.lat)+pad, Math.max(a.lng,b.lng)+pad,
          Math.max(20, dist/N), clutterHeights);
        if(grid){
          clutterImpact=makeClutterImpactStats();
          clutterH=dists.map((d,s)=>{
            if(d<clutterExcludeM || (dist-d)<clutterExcludeM) return 0;
            const t=s/N;
            const lat=a.lat+(b.lat-a.lat)*t, lng=a.lng+(b.lng-a.lng)*t;
            const h=grid.heightAt(lat, lng);
            addClutterImpact(clutterImpact, h, d, [lat,lng], null);
            return h;
          });
        }
      }

      let minLosClear=Infinity,minFzClear=Infinity,minScaledFzClear=Infinity,maxNu=-Infinity;
      let minBareLosClear=Infinity,minBareScaledFzClear=Infinity;
      const losAt = s => aH + (bH - aH) * (s / N);
      const bareEffAt = s => elevs[s] + bulge(dists[s], dist - dists[s], K);
      for(let s=1;s<N;s++){
        const d1=dists[s],d2=dist-dists[s];
        const bareEff=bareEffAt(s);
        const eff=bareEff+(clutterH?clutterH[s]:0);
        const los=losAt(s);
        const bareClear=los-bareEff;
        if(bareClear<minBareLosClear) minBareLosClear=bareClear;
        const clear=los-eff;
        if(clear<minLosClear) minLosClear=clear;
        const fz=fresnel1(d1,d2,freq);
        if(bareClear-fz*fresnelPct<minBareScaledFzClear) minBareScaledFzClear=bareClear-fz*fresnelPct;
        if(clear-fz<minFzClear) minFzClear=clear-fz;
        if(clear-fz*fresnelPct<minScaledFzClear) minScaledFzClear=clear-fz*fresnelPct;
        // Fresnel-Kirchhoff diffraction parameter at this point: the terrain
        // height above the LOS line is h = -clear, and ν = √2·h/r₁ (r₁ = fz).
        // Track the dominant (highest-ν) obstruction along the path.
        const nu=Math.SQRT2*(-clear)/fz;
        if(nu>maxNu) maxNu=nu;
      }
      const status=minBareLosClear<=0?'blocked':minScaledFzClear<=0?'marginal':'clear';
      const clutterLossDb = clutterH ? clutterAttenuationDb(clutterH, dists, losAt, bareEffAt, 1, N, freq, clutterAttenRef) : 0;
      if(clutterImpact && clutterLossDb > clutterImpact.maxLossDb) clutterImpact.maxLossDb = clutterLossDb;
      // First-order excess loss beyond free space: single knife-edge diffraction
      // over the dominant obstruction (Deygout principal edge). ≈0 dB on a fully
      // Fresnel-clear path, ~6 dB at grazing, rising as terrain intrudes.
      const diffLossDb=knifeEdgeLossDb(maxNu) + clutterLossDb;
      e.result={dist,minLosClear,minFzClear,minScaledFzClear,fresnelPct,status,diffLossDb};
      e.profile={elevs,dists,dist,aH,bH,a,b,freq,K,N};
      const lvl = status==='clear'?'ok':status==='blocked'?'err':'warn';
      let clutterNote='';
      if(clutterH){
        const bareStatus=minBareLosClear<=0?'blocked':minBareScaledFzClear<=0?'marginal':'clear';
        clutterNote=` · +clutter (${clutterImpactSummary(clutterImpact)}; atten ${clutterLossDb.toFixed(1)}dB)`;
        if(bareStatus!==status) clutterNote+=` · bare would be ${bareStatus.toUpperCase()}`;
      }
      dlog(`  ${a.name}↔${b.name}: ${(dist/1000).toFixed(2)}km · ${status.toUpperCase()} · LOS clr ${minLosClear.toFixed(1)}m · Fz clr ${minScaledFzClear.toFixed(1)}m · ν ${maxNu.toFixed(2)} · diff ${diffLossDb.toFixed(1)}dB${clutterNote}`, lvl);

      // Colour the line on map
      if(e.line) e.line.setStyle(edgeBaseStyle(e));
    }

    if(terrainErrors<MAX_TERRAIN_ERRORS) hideToast();
    renderResults();
    renderEdgesPanel();
    renderChartTabs();

    // Preserve the current chart selection when it is still valid.
    const edgesByPair=edgeByNodePairMap();
    const preferredPath=S.showPaths&&preferredView?.type==='path'?S.paths.find(p=>p.id===preferredView.id&&!p.hidden):null;
    const preferredEdge=preferredView?.type==='edge'?S.edges.find(e=>e.id===preferredView.id&&!e.hidden&&e.profile):null;
    const preferredNode=preferredView?.type==='node'?nodesById.get(preferredView.id):null;
    const analysedPath=S.showPaths?S.paths.find(p=>!p.hidden&&pathHasAnalysedProfiles(p,edgesByPair)):null;
    const analysedEdge=S.edges.find(e=>!e.hidden&&e.profile);
    if(preferredNode){
      S.activeView={type:'node',id:preferredNode.id};
      clearCanvas();
    } else if(preferredPath&&pathHasAnalysedProfiles(preferredPath,edgesByPair)){
      S.activeView={type:'path',id:preferredPath.id};
      showPathProfile(preferredPath.id);
    } else if(preferredEdge){
      S.activeView={type:'edge',id:preferredEdge.id};
      showEdgeProfile(preferredEdge.id);
    } else if(analysedPath){
      S.activeView={type:'path',id:analysedPath.id};
      showPathProfile(analysedPath.id);
    } else if(analysedEdge){
      S.activeView={type:'edge',id:analysedEdge.id};
      showEdgeProfile(analysedEdge.id);
    } else {
      S.activeView=null;
      clearCanvas();
    }
    renderPathsPanel();
    highlightActiveMapView();
  }finally{
    S._analysing=false;
  }
}

// ═══════════════════════════════════════════════════════════
//  RESULTS PANEL
// ═══════════════════════════════════════════════════════════
function renderResults(){
  const el=document.getElementById('resultsArea');
  const analysed=S.edges.filter(e=>S.showLinks&&!e.hidden&&e.result);
  if(!analysed.length){
    el.innerHTML=S.edges.some(e=>e.result)?'<div class="no-data">No visible analysed links.</div>':'<div class="no-data">Add nodes, links, then analyse.</div>';
    return;
  }
  const nodesById=nodeByIdMap();
  el.innerHTML='';
  analysed.forEach(e=>{
    const r=e.result;
    const a=nodesById.get(e.aId),b=nodesById.get(e.bId);
    const active=S.activeView?.type==='edge'&&S.activeView?.id===e.id;
    const div=document.createElement('div');
    div.className='hop-card'+(active?' active-hop':'');
    if(r.status==='error'){
      div.innerHTML=`<div class="hop-top">
        <span class="hop-name">${escHtml(a.name)} ↔ ${escHtml(b.name)}</span>
        <span class="badge blocked">! TERRAIN ERROR</span>
      </div>
      <div class="hop-stats">
        <div class="hop-stat"><span class="lbl">Dist: </span><span class="val">${(r.dist/1000).toFixed(2)}km</span></div>
        <div class="hop-stat"><span class="lbl">Error: </span><span class="val" style="color:var(--red)">${escHtml(r.error||'Unable to fetch elevation')}</span></div>
      </div>`;
    }else{
      div.innerHTML=`<div class="hop-top">
        <span class="hop-name">${escHtml(a.name)} ↔ ${escHtml(b.name)}</span>
        <span class="badge ${r.status}">${r.status==='clear'?'✓ CLEAR':r.status==='marginal'?'⚠ MARGINAL':'✕ BLOCKED'}</span>
      </div>
      <div class="hop-stats">
        <div class="hop-stat"><span class="lbl">Dist: </span><span class="val">${(r.dist/1000).toFixed(2)}km</span></div>
        <div class="hop-stat"><span class="lbl">LOS: </span><span class="val" style="color:${r.minLosClear>0?'var(--green)':'var(--red)'}">${r.minLosClear.toFixed(1)}m</span></div>
        <div class="hop-stat"><span class="lbl">Fz1: </span><span class="val" style="color:${r.minFzClear>0?'var(--green)':'var(--orange)'}">${r.minFzClear.toFixed(1)}m</span></div>
        <div class="hop-stat" title="Estimated single knife-edge diffraction loss over the dominant obstruction (excess over free space)"><span class="lbl">Diff: </span><span class="val" style="color:${(r.diffLossDb??0)<=0.5?'var(--green)':(r.diffLossDb??0)<6?'var(--orange)':'var(--red)'}">${(r.diffLossDb??0).toFixed(1)}dB</span></div>
      </div>`;
    }
    div.addEventListener('click', () => selectEdgeView(e.id));
    el.appendChild(div);
  });
}

// ═══════════════════════════════════════════════════════════
//  CHART TABS
// ═══════════════════════════════════════════════════════════
function renderChartTabs(){
  const tabs=document.getElementById('chartTabs');
  const nodesById=nodeByIdMap();
  tabs.innerHTML='';
  // Path tabs first
  if(S.showPaths){
    S.paths.filter(p=>!p.hidden).forEach(p=>{
      const names=pathLabel(p,nodesById);
      const btn=document.createElement('button');
      btn.className='chart-tab'+(S.activeView?.type==='path'&&S.activeView?.id===p.id?' active':'');
      btn.textContent=names; btn.title=names;
      btn.addEventListener('click', () => selectPathView(p.id));
      tabs.appendChild(btn);
    });
  }
  // Individual edge tabs
  if(S.showLinks){
    S.edges.filter(e=>!e.hidden&&e.result&&e.profile).forEach(e=>{
      const a=nodesById.get(e.aId),b=nodesById.get(e.bId);
      const label=`${a?.name||'?'} ↔ ${b?.name||'?'}`;
      const btn=document.createElement('button');
      btn.className='chart-tab'+(S.activeView?.type==='edge'&&S.activeView?.id===e.id?' active':'');
      btn.textContent=label; btn.title=label;
      btn.addEventListener('click', () => selectEdgeView(e.id));
      tabs.appendChild(btn);
    });
  }
}

// ═══════════════════════════════════════════════════════════
//  PROFILE DRAWING — SINGLE EDGE
// ═══════════════════════════════════════════════════════════
function showEdgeProfile(edgeId){
  const e=S.edges.find(x=>x.id===edgeId);
  if(!e?.profile) return;
  S.redrawProfile=()=>showEdgeProfile(edgeId);
  const{elevs,dists,dist,aH,bH,a,b,freq,K,N}=e.profile;
  const r=e.result;
  const diffTxt=(r&&r.diffLossDb!=null)?`  |  Diff: ${r.diffLossDb.toFixed(1)} dB`:'';
  const title=`${a.name} ↔ ${b.name}  |  ${(dist/1000).toFixed(2)} km  |  GND+ANT: ${aH.toFixed(1)}m → ${bH.toFixed(1)}m${diffTxt}`;
  document.getElementById('chartTitle').textContent=title;
  drawProfile({elevs,dists,dist,aH,bH,freq,K,N,result:r,labels:[a.name,b.name]});
  highlightActiveMapView();
}

// ═══════════════════════════════════════════════════════════
//  PROFILE DRAWING — PATH (multi-hop)
// ═══════════════════════════════════════════════════════════
function showPathProfile(pathId){
  const path=S.paths.find(p=>p.id===pathId);
  if(!path) return;
  S.redrawProfile=()=>showPathProfile(pathId);
  highlightActiveMapView();

  // Collect edges in order — each consecutive pair of nodeIds
  const nodesById=nodeByIdMap();
  const edgesByPair=edgeByNodePairMap();
  const hops=[];
  for(let i=0;i<path.nodeIds.length-1;i++){
    const aId=path.nodeIds[i],bId=path.nodeIds[i+1];
    const e=edgeBetween(aId,bId,edgesByPair);
    if(!e?.profile){
      S.profileHover=null;
      hideProfileHoverMarker();
      toast(`Link ${nodesById.get(aId)?.name} ↔ ${nodesById.get(bId)?.name} not yet analysed. Run Analyse first.`,3000);
      return;
    }
    // Flip if needed so direction matches path order
    const flip=e.aId===bId;
    hops.push({e,flip});
  }

  const names=path.nodeIds.map(id=>nodesById.get(id)?.name||'?');
  const totalDist=hops.reduce((s,h)=>s+h.e.profile.dist,0);
  document.getElementById('chartTitle').textContent=`${names.join(' → ')}  |  Total ${(totalDist/1000).toFixed(2)} km`;

  drawPathProfile(hops,names);
}

// ═══════════════════════════════════════════════════════════
//  CANVAS DRAWING ENGINE
// ═══════════════════════════════════════════════════════════
function setupCanvas(){
  const canvas=document.getElementById('profileCanvas');
  const panel=canvas.parentElement;
  const headerH=panel.querySelector('.chart-header').offsetHeight;
  const availH=panel.offsetHeight-headerH-2;
  canvas.style.height=availH+'px';
  const dpr=window.devicePixelRatio||1;
  canvas.width=canvas.offsetWidth*dpr;
  canvas.height=availH*dpr;
  const ctx=canvas.getContext('2d');
  ctx.scale(dpr,dpr);
  return{ctx,W:canvas.offsetWidth,H:availH};
}

function drawProfile({elevs,dists,dist,aH,bH,freq,K,N,result,labels}){
  const{ctx,W,H}=setupCanvas();
  initProfileHover();
  const PAD={l:46,r:12,t:14,b:22};
  const pw=W-PAD.l-PAD.r,ph=H-PAD.t-PAD.b;
  const activeEdge=S.activeView?.type==='edge'?S.edges.find(e=>e.id===S.activeView.id):null;
  if(activeEdge?.profile){
    S.profileHover={PAD,totalDist:dist,segments:[{start:0,dist,a:activeEdge.profile.a,b:activeEdge.profile.b}]};
  }

  // Per-sample series: earth-bulge-corrected terrain, the LOS line, and the
  // upper edge of the Fresnel zone (endpoints have zero Fresnel radius).
  const eff=elevs.map((e,s)=>s===0||s===N?e:e+bulge(dists[s],dist-dists[s],K));
  const losH=s=>aH+(bH-aH)*(s/N);
  const fz1=s=>(s===0||s===N)?0:fresnel1(dists[s],dist-dists[s],freq);
  // Fit the vertical axis to everything we draw (terrain, endpoints, Fresnel top)
  // with a little headroom (-5 m below, +15 m above) so nothing clips the panel.
  const allVals=[...eff,aH,bH];
  for(let s=1;s<N;s++) allVals.push(losH(s)+fz1(s));
  const minV=Math.min(...allVals)-5,maxV=Math.max(...allVals)+15,rng=maxV-minV||1;
  // Sample index → x pixel; elevation value → y pixel (canvas y grows downward).
  const xp=s=>PAD.l+(s/N)*pw, yp=v=>PAD.t+ph-((v-minV)/rng)*ph;

  ctx.fillStyle='#0b0f17';ctx.fillRect(0,0,W,H);
  drawGrid(ctx,PAD,pw,ph,W,H,minV,rng);
  drawFresnel(ctx,N,xp,yp,losH,fz1,'#00c8f0');
  drawTerrain(ctx,N,xp,yp,eff,H);
  drawBlockedAreas(ctx,N,xp,yp,eff,losH);
  const losCol=result?(result.status==='clear'?'#2ecc71':result.status==='marginal'?'#f39c12':'#e74c3c'):'#00c8f0';
  drawLosLine(ctx,xp,yp,0,N,aH,bH,losCol);
  drawEndpoints(ctx,xp,yp,0,N,aH,bH,losCol,labels[0],labels[1]);
  drawXAxis(ctx,PAD,pw,H,dist);
}

function drawPathProfile(hops,names){
  const{ctx,W,H}=setupCanvas();
  initProfileHover();
  const PAD={l:46,r:12,t:14,b:22};
  const pw=W-PAD.l-PAD.r,ph=H-PAD.t-PAD.b;

  // Stitch samples
  const totalDist=hops.reduce((s,h)=>s+h.e.profile.dist,0);
  const samples=[];
  const hoverSegments=[];
  let cumDist=0;
  hops.forEach((h,hi)=>{
    const{elevs,dists,dist,aH,bH,K,N}=h.e.profile;
    hoverSegments.push({start:cumDist,dist,a:h.flip?h.e.profile.b:h.e.profile.a,b:h.flip?h.e.profile.a:h.e.profile.b});
    const eArr=h.flip?[...elevs].reverse():elevs;
    const dArr=h.flip?dists.map(d=>dist-d).reverse():dists;
    const hAstart=h.flip?bH:aH, hAend=h.flip?aH:bH;
    for(let s=0;s<=N;s++){
      if(hi>0&&s===0) continue;
      const d1=dArr[s],d2=dist-d1;
      const eff=(s===0||s===N)?eArr[s]:eArr[s]+bulge(Math.abs(d1),Math.abs(d2),K);
      const los=hAstart+(hAend-hAstart)*(s/N);
      samples.push({cumDist:cumDist+dArr[s],elev:eArr[s],eff,los,hopIdx:hi});
    }
    cumDist+=dist;
  });
  S.profileHover={PAD,totalDist,segments:hoverSegments};

  const allVals=samples.flatMap(s=>[s.eff,s.los]);
  const minV=Math.min(...allVals)-5,maxV=Math.max(...allVals)+15,rng=maxV-minV||1;
  const xp=d=>PAD.l+(d/totalDist)*pw, yp=v=>PAD.t+ph-((v-minV)/rng)*ph;

  ctx.fillStyle='#0b0f17';ctx.fillRect(0,0,W,H);
  drawGrid(ctx,PAD,pw,ph,W,H,minV,rng);

  // Fresnel per hop
  hops.forEach((h,hi)=>{
    const{dists,dist,aH,bH,freq,K,N}=h.e.profile;
    const hAstart=h.flip?bH:aH, hAend=h.flip?aH:bH;
    const startCum=hops.slice(0,hi).reduce((s,x)=>s+x.e.profile.dist,0);
    ctx.beginPath();
    for(let s=0;s<=N;s++){
      const los=hAstart+(hAend-hAstart)*(s/N);
      const fz=(s===0||s===N)?0:fresnel1(dists[s],dist-dists[s],freq);
      const x=xp(startCum+dists[s]),y=yp(los+fz);
      s===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    }
    for(let s=N;s>=0;s--){
      const los=hAstart+(hAend-hAstart)*(s/N);
      const fz=(s===0||s===N)?0:fresnel1(dists[s],dist-dists[s],freq);
      ctx.lineTo(xp(startCum+dists[s]),yp(los-fz));
    }
    ctx.closePath();
    ctx.fillStyle=hexAlpha(COLORS[hi%COLORS.length],.07);ctx.fill();
    ctx.strokeStyle=hexAlpha(COLORS[hi%COLORS.length],.2);ctx.lineWidth=1;ctx.stroke();
  });

  // Terrain
  ctx.beginPath();
  ctx.moveTo(xp(samples[0].cumDist),yp(samples[0].eff));
  samples.forEach(s=>ctx.lineTo(xp(s.cumDist),yp(s.eff)));
  ctx.lineTo(xp(samples[samples.length-1].cumDist),H);
  ctx.lineTo(xp(samples[0].cumDist),H);ctx.closePath();
  const tGrad=ctx.createLinearGradient(0,PAD.t,0,H);
  tGrad.addColorStop(0,'rgba(80,110,140,.65)');tGrad.addColorStop(1,'rgba(20,35,55,.85)');
  ctx.fillStyle=tGrad;ctx.fill();
  ctx.beginPath();ctx.moveTo(xp(samples[0].cumDist),yp(samples[0].eff));
  samples.forEach(s=>ctx.lineTo(xp(s.cumDist),yp(s.eff)));
  ctx.strokeStyle='rgba(120,160,190,.8)';ctx.lineWidth=1.5;ctx.stroke();

  // Blocked highlights
  samples.forEach((s,i)=>{
    if(i===0) return;
    const prev=samples[i-1];
    if(s.los<s.eff){
      ctx.fillStyle='rgba(231,76,60,.22)';
      const x0=xp(prev.cumDist),x1=xp(s.cumDist);
      const tt=Math.min(yp(prev.eff),yp(s.eff)),lb=Math.max(yp(prev.los),yp(s.los));
      if(tt<lb) ctx.fillRect(x0,tt,x1-x0,lb-tt);
    }
  });

  // LOS lines per hop
  let cum=0;
  hops.forEach((h,hi)=>{
    const{dist,aH,bH,N}=h.e.profile;
    const hAstart=h.flip?bH:aH,hAend=h.flip?aH:bH;
    const r=h.e.result;
    const col=r?(r.status==='clear'?'#2ecc71':r.status==='marginal'?'#f39c12':'#e74c3c'):'#00c8f0';
    ctx.beginPath();ctx.moveTo(xp(cum),yp(hAstart));ctx.lineTo(xp(cum+dist),yp(hAend));
    ctx.strokeStyle=col;ctx.lineWidth=2;ctx.setLineDash([]);ctx.stroke();
    cum+=dist;
  });

  // Waypoint labels + dividers
  let cumW=0;
  names.forEach((name,wi)=>{
    const hopIdx=Math.min(wi,hops.length-1);
    const h=hops[hopIdx];
    const prevHop=wi>0?hops[wi-1]:null;
    const wpH=wi===0
      ? (h.flip?h.e.profile.bH:h.e.profile.aH)
      : wi===names.length-1
        ? (hops[hops.length-1].flip?hops[hops.length-1].e.profile.aH:hops[hops.length-1].e.profile.bH)
        : (prevHop.flip?prevHop.e.profile.aH:prevHop.e.profile.bH);
    if(wi>0&&wi<names.length-1){
      ctx.strokeStyle='rgba(200,218,234,.15)';ctx.lineWidth=1;ctx.setLineDash([4,3]);
      ctx.beginPath();ctx.moveTo(xp(cumW),PAD.t);ctx.lineTo(xp(cumW),H-PAD.b);ctx.stroke();ctx.setLineDash([]);
    }
    ctx.beginPath();ctx.arc(xp(cumW),yp(wpH),4,0,Math.PI*2);
    ctx.fillStyle=COLORS[Math.min(wi,hops.length-1)%COLORS.length];ctx.fill();
    ctx.fillStyle='#e0eaf4';ctx.font='bold 9px "Barlow Condensed"';
    ctx.textAlign=wi===0?'left':wi===names.length-1?'right':'center';
    ctx.fillText(name,xp(cumW)+(wi===0?5:wi===names.length-1?-5:0),PAD.t-2);
    if(wi<names.length-1) cumW+=hops[wi].e.profile.dist;
  });

  drawXAxis(ctx,PAD,pw,H,totalDist);
}

// ── Drawing helpers ──────────────────────────────────────
function drawGrid(ctx,PAD,pw,ph,W,H,minV,rng){
  ctx.strokeStyle='rgba(0,200,240,.06)';ctx.lineWidth=1;
  for(let g=0;g<=5;g++){
    const v=minV+(rng/5)*g,y=PAD.t+ph-((v-minV)/rng)*ph;
    ctx.beginPath();ctx.moveTo(PAD.l,y);ctx.lineTo(PAD.l+pw,y);ctx.stroke();
    ctx.fillStyle='rgba(74,98,120,.9)';ctx.font='9px "Share Tech Mono"';ctx.textAlign='right';
    ctx.fillText(v.toFixed(0)+'m',PAD.l-4,y+3);
  }
}
function drawFresnel(ctx,N,xp,yp,losH,fz1,color){
  ctx.beginPath();
  for(let s=0;s<=N;s++) s===0?ctx.moveTo(xp(s),yp(losH(s)+fz1(s))):ctx.lineTo(xp(s),yp(losH(s)+fz1(s)));
  for(let s=N;s>=0;s--) ctx.lineTo(xp(s),yp(losH(s)-fz1(s)));
  ctx.closePath();ctx.fillStyle=hexAlpha(color,.07);ctx.fill();
  ctx.strokeStyle=hexAlpha(color,.2);ctx.lineWidth=1;ctx.stroke();
}
function drawTerrain(ctx,N,xp,yp,eff,H){
  ctx.beginPath();ctx.moveTo(xp(0),yp(eff[0]));
  for(let s=1;s<=N;s++) ctx.lineTo(xp(s),yp(eff[s]));
  ctx.lineTo(xp(N),H);ctx.lineTo(xp(0),H);ctx.closePath();
  const tGrad=ctx.createLinearGradient(0,0,0,H);
  tGrad.addColorStop(0,'rgba(80,110,140,.65)');tGrad.addColorStop(1,'rgba(20,35,55,.85)');
  ctx.fillStyle=tGrad;ctx.fill();
  ctx.beginPath();ctx.moveTo(xp(0),yp(eff[0]));
  for(let s=1;s<=N;s++) ctx.lineTo(xp(s),yp(eff[s]));
  ctx.strokeStyle='rgba(120,160,190,.8)';ctx.lineWidth=1.5;ctx.stroke();
}
function drawBlockedAreas(ctx,N,xp,yp,eff,losH){
  for(let s=1;s<=N;s++){
    if(losH(s)<eff[s]){
      ctx.fillStyle='rgba(231,76,60,.22)';
      const x0=xp(s-1),x1=xp(s);
      const tt=Math.min(yp(eff[s-1]),yp(eff[s])),lb=Math.max(yp(losH(s-1)),yp(losH(s)));
      if(tt<lb) ctx.fillRect(x0,tt,x1-x0,lb-tt);
    }
  }
}
function drawLosLine(ctx,xp,yp,s0,sN,aH,bH,color){
  ctx.beginPath();ctx.moveTo(xp(s0),yp(aH));ctx.lineTo(xp(sN),yp(bH));
  ctx.strokeStyle=color;ctx.lineWidth=2;ctx.setLineDash([]);ctx.stroke();
}
function drawEndpoints(ctx,xp,yp,s0,sN,aH,bH,color,nameA,nameB){
  [[s0,aH,nameA],[sN,bH,nameB]].forEach(([s,h,nm])=>{
    ctx.beginPath();ctx.arc(xp(s),yp(h),4,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
    ctx.fillStyle='#e0eaf4';ctx.font='bold 9px "Barlow Condensed"';
    ctx.textAlign=s===s0?'left':'right';
    ctx.fillText(nm,xp(s)+(s===s0?6:-6),yp(h)-7);
  });
}
function drawXAxis(ctx,PAD,pw,H,totalDist){
  ctx.fillStyle='rgba(74,98,120,.9)';ctx.font='9px "Share Tech Mono"';
  [0,.25,.5,.75,1].forEach(t=>{ctx.textAlign='center';ctx.fillText(((totalDist/1000)*t).toFixed(1)+'km',PAD.l+pw*t,H-5);});
}
function hexAlpha(hex,alpha){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return `rgba(${r},${g},${b},${alpha})`;}

function interpLatLng(a,b,t){
  return [a.lat+(b.lat-a.lat)*t,a.lng+(b.lng-a.lng)*t];
}

function ensureProfileHoverMarker(){
  if(S.hoverMarker) return S.hoverMarker;
  S.hoverMarker=L.circleMarker([0,0],{
    radius:10,
    color:'#ffffff',
    weight:3,
    fillColor:'#ff2bd6',
    fillOpacity:.9,
    opacity:1,
    pane:'profileHoverPane'
  });
  S.hoverMarker.bindTooltip('Profile cursor',{direction:'top',offset:[0,-10]});
  return S.hoverMarker;
}

function hideProfileHoverMarker(){
  if(S.hoverMarker&&S.map.hasLayer(S.hoverMarker)) S.map.removeLayer(S.hoverMarker);
}

function handleProfileHover(ev){
  if(!S.profileHover||!S.map) return;
  const canvas=document.getElementById('profileCanvas');
  const rect=canvas.getBoundingClientRect();
  const x=ev.clientX-rect.left;
  const {PAD,totalDist,segments}=S.profileHover;
  const pw=canvas.offsetWidth-PAD.l-PAD.r;
  if(x<PAD.l||x>PAD.l+pw){hideProfileHoverMarker();return;}
  const dist=((x-PAD.l)/pw)*totalDist;
  const seg=segments.find(s=>dist>=s.start&&dist<=s.start+s.dist)||segments[segments.length-1];
  if(!seg) return;
  const t=Math.max(0,Math.min(1,(dist-seg.start)/seg.dist));
  const marker=ensureProfileHoverMarker();
  marker.setLatLng(interpLatLng(seg.a,seg.b,t));
  if(!S.map.hasLayer(marker)) marker.addTo(S.map);
  marker.setStyle({opacity:1,fillOpacity:.9});
  marker.bringToFront();
}

function drawProfileCursorAtDistance(dist){
  if(!S.profileHover||!S.redrawProfile) return;
  S.redrawProfile();
  const canvas=document.getElementById('profileCanvas');
  const ctx=canvas.getContext('2d');
  const {PAD,totalDist}=S.profileHover;
  const pw=canvas.offsetWidth-PAD.l-PAD.r;
  const x=PAD.l+(Math.max(0,Math.min(totalDist,dist))/totalDist)*pw;
  ctx.save();
  ctx.strokeStyle='#ff2bd6';
  ctx.lineWidth=2;
  ctx.setLineDash([5,3]);
  ctx.beginPath();
  ctx.moveTo(x,PAD.t);
  ctx.lineTo(x,canvas.offsetHeight-PAD.b);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle='#ff2bd6';
  ctx.beginPath();
  ctx.arc(x,PAD.t+6,4,0,Math.PI*2);
  ctx.fill();
  ctx.restore();
}

function projectPointToSegment(latlng,a,b){
  const p=S.map.latLngToLayerPoint(latlng);
  const p0=S.map.latLngToLayerPoint([a.lat,a.lng]);
  const p1=S.map.latLngToLayerPoint([b.lat,b.lng]);
  const vx=p1.x-p0.x,vy=p1.y-p0.y;
  const len2=vx*vx+vy*vy||1;
  return Math.max(0,Math.min(1,((p.x-p0.x)*vx+(p.y-p0.y)*vy)/len2));
}

function profileDistanceForEdgeHover(edge,latlng){
  if(!S.profileHover) return null;
  if(S.activeView?.type==='edge'&&S.activeView.id===edge.id){
    const t=projectPointToSegment(latlng,edge.profile.a,edge.profile.b);
    return t*edge.profile.dist;
  }
  if(S.activeView?.type==='path'){
    const seg=S.profileHover.segments.find(s=>
      (s.a.id===edge.aId&&s.b.id===edge.bId)||(s.a.id===edge.bId&&s.b.id===edge.aId)
    );
    if(!seg) return null;
    const t=projectPointToSegment(latlng,seg.a,seg.b);
    return seg.start+t*seg.dist;
  }
  return null;
}

function handleMapLineHover(edge,latlng){
  if(!edge.profile) return;
  if(S.profileCursorHideFrame){
    cancelAnimationFrame(S.profileCursorHideFrame);
    S.profileCursorHideFrame=null;
  }
  const dist=profileDistanceForEdgeHover(edge,latlng);
  if(dist===null) return;
  drawProfileCursorAtDistance(dist);
}

function hideProfileCursor(){
  if(S.profileCursorHideFrame) cancelAnimationFrame(S.profileCursorHideFrame);
  S.profileCursorHideFrame=requestAnimationFrame(()=>{
    S.profileCursorHideFrame=null;
    if(S.redrawProfile) S.redrawProfile();
  });
}

function initProfileHover(){
  const canvas=document.getElementById('profileCanvas');
  if(canvas.dataset.hoverBound==='1') return;
  canvas.dataset.hoverBound='1';
  canvas.addEventListener('mousemove',handleProfileHover);
  canvas.addEventListener('mouseleave',hideProfileHoverMarker);
}

function clearCanvas(){
  const canvas=document.getElementById('profileCanvas');
  const ctx=canvas.getContext('2d');
  canvas.width=canvas.offsetWidth;canvas.height=canvas.offsetHeight;
  ctx.fillStyle='#0b0f17';ctx.fillRect(0,0,canvas.width,canvas.height);
  document.getElementById('chartTitle').textContent='TERRAIN PROFILE';
  document.getElementById('chartTabs').innerHTML='';
  S.profileHover=null;
  S.redrawProfile=null;
  hideProfileHoverMarker();
}

// ═══════════════════════════════════════════════════════════
//  SHARE via URL hash
// ═══════════════════════════════════════════════════════════
// Serialise the full map to the compact v4 hash payload. The format lives in
// share-codec.js (CPShareCodec) so the Repeater Finder produces identical links.
const inpVal=id=>document.getElementById(id).value;
function buildShareHash(){
  const idx=new Map(S.nodes.map((n,i)=>[n.id,i]));
  return CPShareCodec.encode({
    rf:{
      f:inpVal('inpFreq'), k:inpVal('inpK'), tx:inpVal('inpTx'), gn:inpVal('inpGain'),
      rx:inpVal('inpRx'), mg:inpVal('inpMargin'), ra:inpVal('inpRxAntH'),
      cr:inpVal('inpCovRays'), cs:inpVal('inpCovSamples'), cf:inpVal('inpCovFresnel'),
      cm:inpVal('inpCovMaxKm'), co:clutterEnabled()?1:0,
      fh:inpVal('inpClutterForest'), uh:inpVal('inpClutterUrban'),
      xe:inpVal('inpClutterExclude'), ca:inpVal('inpClutterAtten')
    },
    nodes:S.nodes.map(n=>({
      lat:n.lat, lng:n.lng, antH:n.antH, name:n.name, rfOverride:n.rfOverride,
      txDbm:n.txDbm, gainDbi:n.gainDbi, rxDbm:n.rxDbm, coverageOn:n.coverageOn, color:n.color
    })),
    edges:S.edges.map(e=>({a:idx.get(e.aId), b:idx.get(e.bId), hidden:e.hidden})),
    paths:S.paths.map(p=>({name:p.name, hidden:p.hidden, nodeIdx:p.nodeIds.map(id=>idx.get(id))}))
  });
}

function openShare(){
  const url=window.location.href.split('#')[0]+'#'+buildShareHash();
  document.getElementById('shareUrl').textContent=url;
  document.getElementById('shareModal').classList.add('open');
}

// Keep the address bar in sync with the current map so the URL is always a
// copy-pasteable share link. Debounced, and suppressed until the initial
// load-from-hash has run so we never clobber an incoming shared link.
let _urlSyncTimer=null;
function syncShareUrl(){
  if(!S._ready) return;
  clearTimeout(_urlSyncTimer);
  _urlSyncTimer=setTimeout(()=>{
    try{
      const base=window.location.pathname+window.location.search;
      // Empty map → strip the hash entirely rather than encode nothing.
      const url=S.nodes.length ? base+'#'+buildShareHash() : base;
      history.replaceState(null,'',url);
    }catch(err){ console.warn('URL sync failed',err); }
  },400);
}
function closeShare(){document.getElementById('shareModal').classList.remove('open');}
function openSettings(){
  refreshSettingsSummary();
  const links=document.getElementById('inpShowLinks');
  const paths=document.getElementById('inpShowPaths');
  if(links) links.checked=S.showLinks;
  if(paths) paths.checked=S.showPaths;
  document.getElementById('settingsModal').classList.add('open');
}
function closeSettings(){ document.getElementById('settingsModal').classList.remove('open'); refreshSettingsSummary(); }
function refreshSettingsSummary(){
  const f = document.getElementById('inpFreq')?.value || '915';
  const tx = document.getElementById('inpTx')?.value || '?';
  const gn = document.getElementById('inpGain')?.value || '?';
  const cov = S.nodes.filter(n => n.coverageOn).length;
  const total = S.nodes.length;
  const band = document.getElementById('ssBand'); if(band) band.textContent = `${f} MHz`;
  const bud = document.getElementById('ssBudget'); if(bud) bud.textContent = `${tx} dBm / ${(+gn>=0?'+':'')}${gn} dBi`;
  const cc = document.getElementById('ssCovCount'); if(cc) cc.textContent = `${cov}/${total}`;
  const cv = document.getElementById('covCount'); if(cv) cv.textContent = cov;
}
function copyShareUrl(){
  const url=document.getElementById('shareUrl').textContent;
  navigator.clipboard.writeText(url).then(()=>{toast('Link copied!',2000);closeShare();}).catch(()=>{toast('Copy failed — select & copy manually.',3000);});
}

// ═══════════════════════════════════════════════════════════
//  HELP
// ═══════════════════════════════════════════════════════════
function openHelp(){document.getElementById('helpModal').classList.add('open');}
function closeHelp(){
  document.getElementById('helpModal').classList.remove('open');
  try{localStorage.setItem('rfLosHelpSeen','1');}catch{}
}
function maybeShowHelp(){
  if(!window.location.hash.slice(1).trim()) openHelp();
}

// ═══════════════════════════════════════════════════════════
//  FREQUENCY PRESETS
// ═══════════════════════════════════════════════════════════
function applyPreset(){
  const v=document.getElementById('inpPreset').value;
  if(v){
    document.getElementById('inpFreq').value=v;
    applyPresetRf(v);
  }
}
function syncPresetFromFreq(){
  const f=document.getElementById('inpFreq').value;
  const sel=document.getElementById('inpPreset');
  sel.value=[...sel.options].some(o=>o.value===f)?f:'';
}

function setInputValue(id, value) {
  if (value == null) return;
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function edgeKey(aId, bId) {
  return aId < bId ? `${aId}:${bId}` : `${bId}:${aId}`;
}

function normaliseV3Hash(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Shared data is not an object');
  const v = Number(raw.v) || 3;
  const rawNodes = Array.isArray(raw.n) ? raw.n.slice(0, LIMITS.nodes) : [];
  const rawEdges = Array.isArray(raw.e) ? raw.e.slice(0, LIMITS.edges) : [];
  const rawPaths = Array.isArray(raw.p) ? raw.p.slice(0, LIMITS.paths) : [];
  const presetRf = PRESET_RF[String(raw.f)];
  const legacyCoverageDefaults = raw.cm == null && raw.cf === 0 && presetRf;
  let id = 1;
  const indexToId = new Map();
  const nodes = [];

  rawNodes.forEach((nd, i) => {
    if (!Array.isArray(nd) || !validLatLng(nd[0], nd[1])) return;
    const nodeId = id++;
    indexToId.set(i, nodeId);
    const rfOverride = !!nd[4];
    nodes.push({
      id: nodeId,
      lat: clampNum(nd[0], -90, 90, 0),
      lng: clampNum(nd[1], -180, 180, 0),
      antH: clampNum(nd[2], 0, LIMITS.antH, 6),
      name: cleanName(nd[3], defaultNodeName(nodes.length)),
      rfOverride,
      txDbm: rfOverride ? clampNum(nd[5], -100, 100, null) : null,
      gainDbi: rfOverride ? clampNum(nd[6], -100, 100, null) : null,
      rxDbm: rfOverride ? clampNum(nd[7], -200, 0, null) : null,
      coverageOn: !!nd[8],
      color: /^#[0-9a-fA-F]{6}$/.test(nd[9]) ? String(nd[9]).toLowerCase() : null
    });
  });

  const edgeKeys = new Set();
  const edges = [];
  rawEdges.forEach(ed => {
    if (!Array.isArray(ed)) return;
    const aId = indexToId.get(Number(ed[0]));
    const bId = indexToId.get(Number(ed[1]));
    if (!aId || !bId || aId === bId) return;
    const key = edgeKey(aId, bId);
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: id++, aId, bId, hidden: v >= 4 ? !!ed[2] : false });
  });

  const paths = [];
  rawPaths.forEach(p => {
    if (!Array.isArray(p) || p.length < 3) return;
    const hidden = v >= 4 ? !!p[1] : false;
    const ids = v >= 4 ? p.slice(2) : p.slice(1);
    const nodeIds = ids.slice(0, LIMITS.pathNodes).map(j => indexToId.get(Number(j))).filter(Boolean);
    if (nodeIds.length < 2 || new Set(nodeIds).size !== nodeIds.length) return;
    if (!nodeIds.slice(0, -1).every((nid, i) => edgeKeys.has(edgeKey(nid, nodeIds[i + 1])))) return;
    paths.push({ id: id++, name: cleanName(p[0], 'Path'), hidden, nodeIds });
  });

  return {
    freq: clampNum(raw.f, LIMITS.freqMin, LIMITS.freqMax, 915),
    k: clampNum(raw.k, LIMITS.kMin, LIMITS.kMax, 1.333),
    tx: clampNum(raw.tx, -100, 100, presetRf?.tx ?? 22),
    gain: clampNum(raw.gn, -100, 100, presetRf?.gain ?? 2),
    rx: clampNum(raw.rx, -200, 0, presetRf?.rx ?? -130),
    margin: clampNum(raw.mg, 0, 100, presetRf?.margin ?? 6),
    rxAntH: clampNum(raw.ra, 0, LIMITS.rxAntH, 2),
    covRays: optionNum(parseInt(raw.cr), COVERAGE_RAY_OPTIONS, 72),
    covSamples: optionNum(parseInt(raw.cs), COVERAGE_SAMPLE_OPTIONS, 50),
    covFresnel: optionNum(parseFloat(legacyCoverageDefaults ? presetRf.fresnel : raw.cf), FRESNEL_OPTIONS, 0.4),
    covMaxKm: clampNum(raw.cm ?? presetRf?.maxKm, 1, LIMITS.covMaxKm, 30),
    clutterOn: !!raw.co,
    clutterForest: clampNum(raw.fh, 0, 200, 15),
    clutterUrban: clampNum(raw.uh, 0, 200, 8),
    clutterExclude: clampNum(raw.xe, 0, 5000, 100),
    clutterAtten: clampNum(raw.ca, 0, 1, presetRf?.clutterAtten ?? CLUTTER_ATTEN_DB_PER_M_915),
    nodes,
    edges,
    paths,
    nextId: id
  };
}

function normaliseLegacyHash(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Shared data is not an object');
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes.slice(0, LIMITS.nodes) : [];
  const rawEdges = Array.isArray(raw.edges) ? raw.edges.slice(0, LIMITS.edges) : [];
  const rawPaths = Array.isArray(raw.paths) ? raw.paths.slice(0, LIMITS.paths) : [];
  let id = 1;
  const oldToId = new Map();
  const nodes = [];

  rawNodes.forEach((nd, i) => {
    const lat = nd?.lat ?? nd?.[0];
    const lng = nd?.lng ?? nd?.[1];
    if (!validLatLng(lat, lng)) return;
    const nodeId = id++;
    const oldId = nd?.id ?? i;
    oldToId.set(oldId, nodeId);
    oldToId.set(String(oldId), nodeId);
    oldToId.set(i, nodeId);
    oldToId.set(String(i), nodeId);
    nodes.push({
      id: nodeId,
      lat: clampNum(lat, -90, 90, 0),
      lng: clampNum(lng, -180, 180, 0),
      antH: clampNum(nd?.antH ?? nd?.[2], 0, LIMITS.antH, 6),
      name: cleanName(nd?.name ?? nd?.[3], defaultNodeName(nodes.length)),
      rfOverride: false, txDbm: null, gainDbi: null, rxDbm: null, coverageOn: false
    });
  });

  const edgeKeys = new Set();
  const edges = [];
  rawEdges.forEach(ed => {
    const aId = oldToId.get(ed?.aId ?? ed?.a ?? ed?.[0]);
    const bId = oldToId.get(ed?.bId ?? ed?.b ?? ed?.[1]);
    if (!aId || !bId || aId === bId) return;
    const key = edgeKey(aId, bId);
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: id++, aId, bId, hidden: !!(ed?.hidden ?? ed?.[2]) });
  });

  const paths = [];
  rawPaths.forEach(p => {
    const ids = Array.isArray(p?.nodeIds) ? p.nodeIds : Array.isArray(p) ? p.slice(1) : [];
    const nodeIds = ids.slice(0, LIMITS.pathNodes).map(nid => oldToId.get(nid)).filter(Boolean);
    if (nodeIds.length < 2 || new Set(nodeIds).size !== nodeIds.length) return;
    if (!nodeIds.slice(0, -1).every((nid, i) => edgeKeys.has(edgeKey(nid, nodeIds[i + 1])))) return;
    paths.push({ id: id++, name: cleanName(p?.name ?? p?.[0], 'Path'), hidden: !!p?.hidden, nodeIds });
  });

  return {
    freq: clampNum(raw.freq, LIMITS.freqMin, LIMITS.freqMax, 915),
    k: clampNum(raw.k, LIMITS.kMin, LIMITS.kMax, 1.333),
    tx: clampNum(raw.tx, -100, 100, 22),
    gain: clampNum(raw.gain, -100, 100, 2),
    rx: clampNum(raw.rx, -200, 0, -130),
    margin: clampNum(raw.margin, 0, 100, 6),
    rxAntH: clampNum(raw.rxAntH, 0, LIMITS.rxAntH, 2),
    covRays: optionNum(parseInt(raw.covRays), COVERAGE_RAY_OPTIONS, 72),
    covSamples: optionNum(parseInt(raw.covSamples), COVERAGE_SAMPLE_OPTIONS, 50),
    covFresnel: optionNum(parseFloat(raw.covFresnel), FRESNEL_OPTIONS, 0.4),
    covMaxKm: clampNum(raw.covMaxKm, 1, LIMITS.covMaxKm, 30),
    clutterOn: !!raw.clutterOn,
    clutterForest: clampNum(raw.clutterForest, 0, 200, 15),
    clutterUrban: clampNum(raw.clutterUrban, 0, 200, 8),
    clutterExclude: clampNum(raw.clutterExclude, 0, 5000, 100),
    clutterAtten: clampNum(raw.clutterAtten, 0, 1, CLUTTER_ATTEN_DB_PER_M_915),
    nodes,
    edges,
    paths,
    nextId: id
  };
}

function parseSharedHash(hash) {
  if (hash.length > LIMITS.hashChars) throw new Error('Shared link is too large');
  const isV4 = hash.startsWith('v4:');
  const isV3 = hash.startsWith('v3:');
  const isV2 = hash.startsWith('v2:');
  if (isV4 || isV3 || isV2) {
    const json = LZString.decompressFromEncodedURIComponent(hash.slice(3));
    if (!json || json.length > LIMITS.hashChars * 4) throw new Error('Shared link could not be decompressed');
    return normaliseV3Hash(JSON.parse(json));
  }
  return normaliseLegacyHash(JSON.parse(decodeURIComponent(atob(hash))));
}

function loadFromHash(){
  const hash=window.location.hash.slice(1);
  if(!hash) return;
  try{
    const data=parseSharedHash(hash);
    setInputValue('inpFreq',data.freq);
    setInputValue('inpK',data.k);
    setInputValue('inpTx',data.tx);
    setInputValue('inpGain',data.gain);
    setInputValue('inpRx',data.rx);
    setInputValue('inpMargin',data.margin);
    setInputValue('inpRxAntH',data.rxAntH);
    setInputValue('inpCovRays',data.covRays);
    setInputValue('inpCovSamples',data.covSamples);
    setInputValue('inpCovFresnel',data.covFresnel);
    setInputValue('inpCovMaxKm',data.covMaxKm);
    setInputValue('inpClutterForest',data.clutterForest);
    setInputValue('inpClutterUrban',data.clutterUrban);
    setInputValue('inpClutterExclude',data.clutterExclude);
    setInputValue('inpClutterAtten',data.clutterAtten);
    const clutterCb=document.getElementById('inpClutterOn');
    if(clutterCb) clutterCb.checked=!!data.clutterOn;
    S.nextId=data.nextId;
    // Restore nodes
    data.nodes.forEach(nd=>{
      const node={...nd, elev:null, marker:null,
        coverageLayer:null, coverageDirty:true, coverageComputed:false};
      S.nodes.push(node);
      node.marker=makeMarker(node);
      fetchElev(node);
    });
    refreshAllIcons();
    // Restore edges (lines only, no profile/result yet)
    data.edges.forEach(ed=>{
      const a=S.nodes.find(n=>n.id===ed.aId),b=S.nodes.find(n=>n.id===ed.bId);
      if(!a||!b) return;
      const edge={id:ed.id,aId:ed.aId,bId:ed.bId,hidden:!!ed.hidden,line:null,hitLine:null,result:null,profile:null};
      edge.line=L.polyline([[a.lat,a.lng],[b.lat,b.lng]],{color:'#4a6278',weight:2,opacity:.7,dashArray:'5 4',interactive:false}).addTo(S.map);
      edge.hitLine=L.polyline([[a.lat,a.lng],[b.lat,b.lng]],{color:'#ffffff',weight:24,opacity:0,interactive:true}).addTo(S.map);
      attachEdgeHandlers(edge);
      S.edges.push(edge);
    });
    // Restore paths
    data.paths.forEach(p=>S.paths.push({...p}));
    renderNodeList(); renderEdgesPanel(); renderPathsPanel();
    highlightActiveMapView();
    document.getElementById('wpCount').textContent=S.nodes.length;
    document.getElementById('edgeCount').textContent=S.edges.length;
    document.getElementById('pathCount').textContent=S.paths.length;
    if(S.nodes.length>0){
      document.getElementById('mapHint').style.display='none';
      const bounds=L.latLngBounds(S.nodes.map(n=>[n.lat,n.lng]));
      S.map.fitBounds(bounds,{padding:[40,40]});
    }
    toast('Map loaded from shared link. Click Analyse to run.',4000);
  }catch(err){
    console.warn('Failed to load from hash',err);
    toast('Shared link was rejected: invalid or unsafe data.',5000);
  }
}

// ═══════════════════════════════════════════════════════════
//  TOAST
// ═══════════════════════════════════════════════════════════
let _toastTimer;
function toast(msg,duration){
  const el=document.getElementById('toast');
  if(!msg){el.style.display='none';return;}
  el.style.display='block';
  el.textContent='';
  const spinner=document.createElement('span');
  spinner.style.cssText='display:inline-block;width:8px;height:8px;border:2px solid #4a6278;border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite;margin-right:8px;vertical-align:middle';
  el.appendChild(spinner);
  el.appendChild(document.createTextNode(msg));
  if(_toastTimer) clearTimeout(_toastTimer);
  if(duration) _toastTimer=setTimeout(()=>el.style.display='none',duration);
}
function hideToast(){document.getElementById('toast').style.display='none';}

// ═══════════════════════════════════════════════════════════
//  DEBUG LOG  —  records the inputs/outputs of each calculation
// ═══════════════════════════════════════════════════════════
const DEBUG_LOG_MAX = 1500;
// level: '' info | 'ok' | 'warn' | 'err'
function dlog(msg, level){
  const d = new Date();
  const t = d.toLocaleTimeString('en-GB',{hour12:false}) + '.' + String(d.getMilliseconds()).padStart(3,'0');
  const entry = { t, msg: String(msg), level: level || '' };
  S.debugLog.push(entry);
  if(S.debugLog.length > DEBUG_LOG_MAX) S.debugLog.shift();
  const panel = document.getElementById('debugPanel');
  if(panel && panel.classList.contains('open')){
    if(S.debugLog.length === 1) renderDebug();   // clear the "no activity" placeholder
    else appendDebugLine(entry);
  }
}
function appendDebugLine(e){
  const body = document.getElementById('debugBody'); if(!body) return;
  const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
  const div = document.createElement('div');
  if(e.level) div.className = 'dl-' + e.level;
  div.innerHTML = `<span class="dl-time">${e.t}</span> ${escHtml(e.msg)}`;
  body.appendChild(div);
  if(atBottom) body.scrollTop = body.scrollHeight;
}
function renderDebug(){
  const body = document.getElementById('debugBody'); if(!body) return;
  body.innerHTML = '';
  if(!S.debugLog.length){ body.innerHTML = '<div class="dl-time">No activity yet. Run Analyse or Compute coverage.</div>'; return; }
  S.debugLog.forEach(appendDebugLine);
  body.scrollTop = body.scrollHeight;
}
function toggleDebug(force){
  const panel = document.getElementById('debugPanel');
  const open = force === undefined ? !panel.classList.contains('open') : force;
  panel.classList.toggle('open', open);
  if(open) renderDebug();
}
function clearDebug(){ S.debugLog = []; renderDebug(); }
function copyDebug(){
  const text = S.debugLog.map(e => `${e.t} ${e.msg}`).join('\n');
  if(navigator.clipboard?.writeText){
    navigator.clipboard.writeText(text).then(()=>toast('Debug log copied.',1500), ()=>toast('Copy failed.',2000));
  } else { toast('Clipboard unavailable.',2000); }
}

// ═══════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════
// Wire up every static control. Inline on*= attributes are forbidden by the
// CSP (script-src has no 'unsafe-inline'), so all handlers attach here.
function initStaticHandlers(){
  const on = (id, ev, fn) => document.getElementById(id).addEventListener(ev, fn);
  // Header
  on('btnHelp','click',openHelp);
  on('btnSettings','click',openSettings);
  on('btnShare','click',openShare);
  on('btnClearAll','click',clearAll);
  on('btnDebug','click',()=>toggleDebug());
  // Modals
  on('btnHelpClose','click',closeHelp);
  on('btnShareCopy','click',copyShareUrl);
  on('btnShareClose','click',closeShare);
  on('btnPathCancel','click',closePathModal);
  on('pbSaveBtn','click',savePathModal);
  on('btnSettingsClose','click',closeSettings);
  // Settings modal tabs — show one panel at a time.
  document.querySelectorAll('.settings-tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      const target=tab.dataset.stab;
      document.querySelectorAll('.settings-tab').forEach(t=>t.classList.toggle('active', t===tab));
      document.querySelectorAll('.settings-panel').forEach(p=>{ p.hidden = p.dataset.spanel !== target; });
    });
  });
  // Settings — RF + coverage parameters
  on('inpPreset','change',applyPreset);
  on('inpFreq','input',syncPresetFromFreq);
  ['inpTx','inpGain','inpRx','inpMargin'].forEach(id=>on(id,'change',onGlobalRfChanged));
  ['inpFreq','inpK','inpRxAntH','inpCovMaxKm','inpCovRays','inpCovSamples','inpCovFresnel',
   'inpClutterOn','inpClutterForest','inpClutterUrban','inpClutterExclude','inpClutterAtten']
    .forEach(id=>on(id,'change',onCoverageParamChanged));
  on('inpShowLinks','change',function(){ setDisplayVisibility('links', this.checked); });
  on('inpShowPaths','change',function(){ setDisplayVisibility('paths', this.checked); });
  on('btnCovAllOn','click',()=>setAllCoverage(true));
  on('btnCovAllOff','click',()=>setAllCoverage(false));
  on('btnCovComputeAll','click',computeAllCoverage);
  on('btnCovOverlap','click',toggleOverlap);
  // Sidebar
  on('settingsSummary','click',openSettings);
  on('btnNodesCollapse','click',ev=>{ ev.stopPropagation(); setAllNodesCollapsed(true); });
  on('btnNodesExpand','click',ev=>{ ev.stopPropagation(); setAllNodesCollapsed(false); });
  on('btnLinksAll','click',ev=>{ ev.stopPropagation(); showAllLinks(); });
  on('btnLinksNone','click',ev=>{ ev.stopPropagation(); hideAllLinks(); });
  on('btnPathsAll','click',ev=>{ ev.stopPropagation(); showAllPaths(); });
  on('btnPathsNone','click',ev=>{ ev.stopPropagation(); hideAllPaths(); });
  on('btnNewPath','click',addPath);
  on('btnAnalyse','click',runAnalysis);
  // Map + debug panel
  on('btnLocate','click',goToMyLocation);
  on('btnDebugCopy','click',copyDebug);
  on('btnDebugClear','click',clearDebug);
  on('btnDebugClose','click',()=>toggleDebug(false));
}
initStaticHandlers();

function initCollapsibles(){
  let state={};
  try{ state=JSON.parse(localStorage.getItem('rfLosSidebar')||'{}'); }catch{}
  document.querySelectorAll('.sb-toggle').forEach(toggle=>{
    const key=toggle.dataset.sb;
    const apply=collapsed=>{
      toggle.classList.toggle('collapsed',collapsed);
      document.querySelectorAll(`[data-sb-body="${key}"]`).forEach(el=>{
        if(collapsed) el.setAttribute('hidden','');
        else el.removeAttribute('hidden');
      });
    };
    apply(!!state[key]);
    toggle.addEventListener('click',()=>{
      const next=!toggle.classList.contains('collapsed');
      state[key]=next;
      try{ localStorage.setItem('rfLosSidebar',JSON.stringify(state)); }catch{}
      apply(next);
    });
  });
}

window.addEventListener('load',()=>{
  initMap();
  initProfileHover();
  initCollapsibles();
  renderNodeList();
  setTimeout(()=>S.map.invalidateSize(),200);
  setTimeout(()=>{S.map.invalidateSize();loadFromHash();syncPresetFromFreq();refreshSettingsSummary();maybeShowHelp();S._ready=true;},600);
});
window.addEventListener('resize',()=>{
  if(S.map) S.map.invalidateSize();
  if(S.activeView){
    if(S.activeView.type==='edge') showEdgeProfile(S.activeView.id);
    else if(S.activeView.type==='path') showPathProfile(S.activeView.id);
    else if(S.activeView.type==='node') highlightActiveMapView();
  }
});
