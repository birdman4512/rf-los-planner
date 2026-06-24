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
// Target sample step (m) along each coverage ray. Finer than the ~30-40 m DEM
// on purpose: it oversamples terrain (cheap interpolation) so the 1 m measured
// canopy resolves narrow tree lines and clearings the old 40 m step walked over.
// The Samples setting is a floor; COVERAGE_MAX_SAMPLES caps total samples per ray.
const COVERAGE_STEP_M = 20;
const COVERAGE_MAX_SAMPLES = 3200; // 20 m step holds out to ~64 km before capping
const FRESNEL_OPTIONS = [0, 0.4, 0.6, 1];

// ── Surface clutter via Meta/WRI canopy height + ESA WorldCover land cover ──
// Bare-earth terrain misses trees/buildings; clutter adds obstruction pressure
// and diffraction loss, while bare terrain remains the hard LOS blocker.
// Optional and off by default; degrades gracefully to bare terrain if data fails.
const WORLDCOVER_WMS_SOURCES = [
  { name:'Terrascope TiTiler', url:'https://titiler.terrascope.be/wms', layer:'esa-worldcover-map-10m-2021-v2_map', time:'2021-01-01' },
  { name:'Terrascope legacy', url:'https://services.terrascope.be/wms/v2', layer:'WORLDCOVER_2021_MAP' }
];
// Per-pixel Meta/WRI canopy height refines tree clutter. The source COGs have NO
// overviews and are 1 m (65536²), so they are read SERVER-SIDE by a self-hosted
// titiler (docs/canopy-titiler.md): one small downsampled PNG per source tile,
// uncapped, so dense-forest coverage works. When titiler is unavailable, tree
// pixels fall back to WorldCover's flat Forest(m).
const CANOPY_TILE_Z = 9;
const TITILER_BASE = 'https://tracker.quirkyit.com.au';
// Rescale ceiling: PNG gray 0–255 ↔ 0–CANOPY_HMAX m. The <img>/canvas decode is
// 8-bit (256 levels), so a lower ceiling is the only browser-side precision lever.
// The Meta CHM rarely exceeds ~40 m (the model saturates below that), so 40 gives
// 0.157 m/level vs 0.235 at 60 with negligible clipping. MUST equal nginx rescale.
const CANOPY_HMAX = 40;
// Public endpoint is a narrow reverse proxy, not titiler's generic /cog?url=
// surface. It only serves local /cogs/<quadkey>.cog.tif files through titiler.
function canopyTitilerUrl(qk, w, s, e, n, cols, rows, cacheKey=''){
  const suffix = cacheKey ? `?v=${encodeURIComponent(cacheKey)}` : '';
  return `${TITILER_BASE}/canopy/${qk}/bbox/${w},${s},${e},${n}/${cols}x${rows}.png${suffix}`;
}
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
// Distance in metres → lat/lng degree deltas at a given latitude (the cos guard
// keeps longitude finite near the poles). Used to build sample/scan bboxes.
function metresToDegrees(lat, m) {
  return { dLat: m / 111320, dLng: m / (111320 * Math.max(0.05, Math.cos(lat * Math.PI / 180))) };
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
  // Coverage polygons render on a dedicated CANVAS renderer in a low pane (below
  // the overlay paths/markers). Canvas avoids the SVG renderer repainting every
  // polygon on each pan/zoom frame, which made coverage flicker.
  S.map.createPane('coveragePane');
  S.map.getPane('coveragePane').style.zIndex=350;
  S._covRenderer = L.canvas({ pane:'coveragePane', padding:0.5 });
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
    // Re-scan the sun/skyline view if this node's info panel is open (it moved).
    if (NI.node?.id === node.id){ node._horizon = null; niRenderLinks(node); niRescan(); }
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
  if(NI.node?.id===id) closeNodeInfo();
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
  closeNodeInfo();
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
  if(NI.node&&NI.node.id!==id) closeNodeInfo();   // selecting a different node drops the open info panel
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
  closeNodeInfo();
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
    {icon:'ⓘ',label:'More info…',action:()=>openNodeInfo(node)},
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
    const circle=L.circle([lat,lng],{radius:50,color:accentColor(),fillColor:accentColor(),fillOpacity:.2,weight:2}).addTo(S.map);
    setTimeout(()=>S.map.removeLayer(circle),4000);
  },err=>{hideToast();toast('Could not get location: '+err.message,3000);});
}
function accentColor(){return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#00c8f0';}

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
let _clutterFailedAt = 0;           // when all WMS clutter sources last failed (0 = healthy); gates a short retry cooldown, not a session-long give-up
let _titilerFailedAt = 0;           // when the titiler VM was last unreachable (it's part-time); also a cooldown, not sticky
const _canopyLocalCogMisses = new Set(); // qk values that failed this session; cleared when a newer manifest generation appears (i.e. a COG was built)
let _canopyManifestPromise = null;       // in-flight manifest fetch, shared by concurrent callers
let _canopyManifest = null;              // last resolved manifest
let _canopyManifestFetchedAt = 0;        // Date.now() of last successful fetch (TTL gate)
let _canopyManifestGenerated = '';       // 'generated' stamp last seen; a change means a COG was (re)built → drop stale misses
const CANOPY_MANIFEST_TTL_MS = 60000;    // re-poll at most this often so COGs built mid-session appear without a page reload
const CLUTTER_RETRY_COOLDOWN_MS = 90000; // after a fetch failure, skip the source for this long, then retry — one timeout no longer disables clutter for the whole session
const CLUTTER_IMG_TIMEOUT_MS = 20000; // base per-tile timeout; scaled up for larger tiles by clutterTimeoutForPixels()
const WMS_MAX_TILE_PX = 512;          // split big WorldCover GetMap requests into chunks ≤ this per side so one large image can't hang/abort the whole fetch

function clutterInCooldown(){ return _clutterFailedAt > 0 && (Date.now() - _clutterFailedAt) < CLUTTER_RETRY_COOLDOWN_MS; }
function titilerInCooldown(){ return _titilerFailedAt > 0 && (Date.now() - _titilerFailedAt) < CLUTTER_RETRY_COOLDOWN_MS; }
// Bigger tiles legitimately take longer; give ~15s extra per megapixel over the base, capped at 60s.
function clutterTimeoutForPixels(px){ return Math.min(60000, CLUTTER_IMG_TIMEOUT_MS + Math.round(px / 1e6 * 15000)); }

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

function loadClutterImage(url, w, h, timeoutMs = CLUTTER_IMG_TIMEOUT_MS){
  if(_clutterImgCache.has(url)) return _clutterImgCache.get(url);
  const p = new Promise((resolve, reject)=>{
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let done = false;
    const timer = setTimeout(() => {
      if(done) return;
      done = true;
      img.src = '';   // abort the in-flight request
      reject(new Error('image request timed out'));
    }, timeoutMs);
    img.onload = () => {
      if(done) return; done = true; clearTimeout(timer);
      try{
        const cvs = document.createElement('canvas');
        cvs.width = w; cvs.height = h;
        const ctx = cvs.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        resolve({data,w,h});
      }catch(e){ reject(new Error(`canvas decode failed (${e.message||e})`)); }
    };
    img.onerror = () => { if(done) return; done = true; clearTimeout(timer); reject(new Error('image request failed')); };
    img.src = url;
  });
  _clutterImgCache.set(url, p);
  // Decoded clutter images can be up to 2048×2048 RGBA (~16 MB) — keep few.
  trimCache(_clutterImgCache, 8);
  return p;
}

async function loadCanopyManifest(force){
  if(titilerInCooldown()) return null;
  if(!force && _canopyManifest && (Date.now() - _canopyManifestFetchedAt) < CANOPY_MANIFEST_TTL_MS){
    return _canopyManifest; // fresh enough — skip the network round-trip
  }
  if(_canopyManifestPromise) return _canopyManifestPromise; // a fetch is already in flight — share it
  _canopyManifestPromise = fetch(`${TITILER_BASE}/canopy/manifest.json`, { cache:'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(m => {
      _canopyManifestPromise = null;
      if(m){
        _canopyManifest = m;
        _canopyManifestFetchedAt = Date.now();
        const gen = canopyManifestCacheKey(m);
        if(gen !== _canopyManifestGenerated){
          // refresh-manifest.sh stamps a new 'generated' on every build, so a
          // changed stamp means tiles we previously gave up on may now exist.
          _canopyManifestGenerated = gen;
          _canopyLocalCogMisses.clear();
        }
      }
      return m;
    })
    .catch(e => {
      _canopyManifestPromise = null;
      _titilerFailedAt = Date.now();
      dlog(`Canopy: manifest unavailable — ${e.message||e}`,'warn');
      return null;
    });
  return _canopyManifestPromise;
}

function canopyManifestHasTile(manifest, qk){
  if(!manifest) return true; // old proxy or offline manifest: probe the image endpoint.
  if(Array.isArray(manifest.tiles)) return manifest.tiles.includes(qk);
  return !!(manifest.tiles && manifest.tiles[qk]);
}

function canopyManifestCacheKey(manifest){
  return manifest && manifest.generated ? manifest.generated : '';
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

// Geographic bounds of an x/y/z tile, [west, south, east, north] in degrees.
function tileLonLatBounds(x, y, z){
  const n = 2 ** z;
  const lng1 = x / n * 360 - 180, lng2 = (x + 1) / n * 360 - 180;
  const lat1 = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
  const lat2 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
  return [lng1, Math.min(lat1, lat2), lng2, Math.max(lat1, lat2)];
}

// Build a land-cover→clutter-height sampler over [minLat,minLng]–[maxLat,maxLng]
// at ~stepM resolution. `heights` maps WorldCover class → metres. Returns a
// sampler {heightAt(lat,lng)} or null if no data could be loaded (→ bare earth).
async function buildWorldCoverGrid(minLat, minLng, maxLat, maxLng, stepM, heights){
  if(clutterInCooldown()){ dlog('Clutter: skipped (source failed recently — will retry shortly)','warn'); return null; }
  const midLat = (minLat + maxLat) / 2;
  const { dLat, dLng } = metresToDegrees(midLat, stepM);
  const cols = Math.min(2048, Math.max(2, Math.ceil((maxLng - minLng) / dLng) + 1));
  const rows = Math.min(2048, Math.max(2, Math.ceil((maxLat - minLat) / dLat) + 1));
  // Split the request into ≤ WMS_MAX_TILE_PX chunks: a single 1200²-ish GetMap is
  // what hangs/aborts (HTTP2_PROTOCOL_ERROR) under load — small tiles fetch reliably.
  const chunkCols = Math.ceil(cols / WMS_MAX_TILE_PX);
  const chunkRows = Math.ceil(rows / WMS_MAX_TILE_PX);
  const totalChunks = chunkCols * chunkRows;
  for(const src of WORLDCOVER_WMS_SOURCES){
    dlog(`WorldCover ${src.name}: fetching ${cols}×${rows} WMS image${totalChunks > 1 ? ` in ${totalChunks} tiles` : ''} …`);
    const classes = new Uint8Array(cols * rows);
    let filled = 0;
    let failedTile = '';
    for(let cy = 0; cy < chunkRows && !failedTile; cy++){
      for(let cx = 0; cx < chunkCols && !failedTile; cx++){
        const c0 = cx * WMS_MAX_TILE_PX, c1 = Math.min(cols, c0 + WMS_MAX_TILE_PX);
        const r0 = cy * WMS_MAX_TILE_PX, r1 = Math.min(rows, r0 + WMS_MAX_TILE_PX);
        const cw = c1 - c0, ch = r1 - r0;
        // Sub-bbox for this pixel block (row 0 = north). Edges share coords with
        // neighbours, so the assembled grid lines up with the full classAt() mapping.
        const w = minLng + (c0 / cols) * (maxLng - minLng);
        const e = minLng + (c1 / cols) * (maxLng - minLng);
        const n = maxLat - (r0 / rows) * (maxLat - minLat);
        const s = maxLat - (r1 / rows) * (maxLat - minLat);
        const qs = new URLSearchParams({
          SERVICE:'WMS',
          VERSION:'1.3.0',
          REQUEST:'GetMap',
          LAYERS:src.layer,
          STYLES:'',
          CRS:'EPSG:4326',
          BBOX:`${s},${w},${n},${e}`,
          WIDTH:String(cw),
          HEIGHT:String(ch),
          FORMAT:'image/png',
          TRANSPARENT:'true'
        });
        if(src.time) qs.set('TIME', src.time);
        const url = `${src.url}?${qs.toString()}`;
        let img;
        try{
          img = await loadClutterImage(url, cw, ch, clutterTimeoutForPixels(cw * ch));
        }catch(err){
          failedTile = err.message || String(err);
          break;
        }
        for(let yy = 0; yy < ch; yy++){
          for(let xx = 0; xx < cw; xx++){
            const i = (yy * cw + xx) * 4;
            const cls = worldCoverClassFromRgb(img.data[i], img.data[i+1], img.data[i+2], img.data[i+3]);
            classes[(r0 + yy) * cols + (c0 + xx)] = cls;
            if(cls) filled++;
          }
        }
      }
    }
    if(failedTile){
      dlog(`Clutter source status: ${src.name} FAILED — ${failedTile}`,'err');
      continue;
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
  _clutterFailedAt = Date.now();
  return null;
}

// Build a measured-canopy sampler over [minLat,minLng]–[maxLat,maxLng] from the
// self-hosted titiler: one downsampled gray PNG per source COG tile the bbox
// touches (rescale 0–CANOPY_HMAX, return_mask=true). Decodes height = R/255*HMAX,
// alpha 0 = no data. Uncapped, so dense-forest coverage is a handful of fetches.
// Returns {heightAt(lat,lng)→metres or NaN, tiles} or null if titiler is
// unreachable (caller then falls back to WorldCover's flat Forest(m)).
async function buildCanopyGrid(minLat, minLng, maxLat, maxLng, stepM){
  if(titilerInCooldown()) return null;
  // If we gave up on any tiles earlier this session, force a fresh manifest read:
  // a COG built since then bumps the manifest's 'generated' stamp, which clears
  // those misses so the newly built tile is picked up without a page reload.
  const manifest = await loadCanopyManifest(_canopyLocalCogMisses.size > 0);
  if(titilerInCooldown()) return null;
  const midLat = (minLat + maxLat) / 2;
  const { dLat, dLng } = metresToDegrees(midLat, stepM);
  const tl = lonLatToTile(minLng, maxLat, CANOPY_TILE_Z);   // top-left source tile
  const br = lonLatToTile(maxLng, minLat, CANOPY_TILE_Z);   // bottom-right source tile
  const images = [];
  let attempted = 0;
  let failed = 0;
  let missing = 0;
  for(let tx = tl.x; tx <= br.x; tx++){
    for(let ty = tl.y; ty <= br.y; ty++){
      const tb = tileLonLatBounds(tx, ty, CANOPY_TILE_Z);
      const w = Math.max(minLng, tb[0]), s = Math.max(minLat, tb[1]);
      const e = Math.min(maxLng, tb[2]), n = Math.min(maxLat, tb[3]);
      if(e <= w || n <= s) continue;                        // no real overlap
      attempted++;
      const cols = Math.min(1024, Math.max(2, Math.ceil((e - w) / dLng) + 1));
      const rows = Math.min(1024, Math.max(2, Math.ceil((n - s) / dLat) + 1));
      const qk = tileToQuadKey(tx, ty, CANOPY_TILE_Z);
      if(_canopyLocalCogMisses.has(qk) || !canopyManifestHasTile(manifest, qk)){
        _canopyLocalCogMisses.add(qk);
        failed++;
        missing++;
        dlog(`Canopy: local COG ${qk} not built — using flat Forest(m); run build-cog.sh ${qk} to enable measured canopy here`,'warn');
        continue;
      }
      const url = canopyTitilerUrl(qk, w, s, e, n, cols, rows, canopyManifestCacheKey(manifest));
      let img = null;
      try{
        img = await loadClutterImage(url, cols, rows);
      }catch(err){
        _canopyLocalCogMisses.add(qk);
        dlog(`Canopy: local COG ${qk} failed — ${err.message||err}; using flat Forest(m)`,'warn');
      }
      if(img){
        images.push({ qk, w, s, e, n, cols: img.w, rows: img.h, data: img.data });
      }else{
        failed++;
      }
    }
  }
  if(failed || !images.length){
    if(attempted && !images.length && failed > missing){
      _titilerFailedAt = Date.now();
      dlog('Canopy: titiler unreachable — using flat Forest(m)','warn');
    }else if(failed){
      dlog(`Canopy: titiler loaded ${images.length}/${attempted} source tile(s); using flat Forest(m) to avoid partial canopy data`,'warn');
    }
    return null;
  }
  return {
    tiles: images.length,
    heightAt(lat, lng){
      for(const im of images){
        if(lng < im.w || lng > im.e || lat < im.s || lat > im.n) continue;
        const c = Math.max(0, Math.min(im.cols-1, Math.floor((lng - im.w) / (im.e - im.w) * im.cols)));
        const r = Math.max(0, Math.min(im.rows-1, Math.floor((im.n - lat) / (im.n - im.s) * im.rows)));
        const idx = (r * im.cols + c) * 4;
        if(im.data[idx+3] === 0) return NaN;                // mask: no canopy data here
        return im.data[idx] / 255 * CANOPY_HMAX;            // gray R → metres
      }
      return NaN;
    }
  };
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
function canopyEnabled(){
  return !!document.getElementById('inpCanopyOn')?.checked;
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
// Initial great-circle bearing (deg, 0–360) from point 1 to point 2.
function bearingTo(la1,lo1,la2,lo2){
  const φ1=toRad(la1),φ2=toRad(la2),Δλ=toRad(lo2-lo1);
  const y=Math.sin(Δλ)*Math.cos(φ2);
  const x=Math.cos(φ1)*Math.sin(φ2)-Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
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
  // WorldCover gives class + flat per-class height; the opt-in canopy toggle
  // additionally reads measured Meta/WRI canopy at grazing tree points.
  let clutter = null;
  if(g.clutterOn){
    const { dLat, dLng } = metresToDegrees(node.lat, maxRange);
    dlog(`  Clutter ON: forest ${g.clutterHeights[10]}m, urban ${g.clutterHeights[50]}m, clear-radius ${g.clutterExcludeM}m, atten ${clutterAttenDbPerM(g.freq, g.clutterAttenRef).toFixed(3)}dB/m — loading…`);
    toast(`${node.name}: loading land cover…`);
    const wc = await buildWorldCoverGrid(node.lat - dLat, node.lng - dLng,
      node.lat + dLat, node.lng + dLng, COVERAGE_STEP_M, g.clutterHeights);
    if(wc){
      let canopySrc = null, canopyLabel = '';
      if(canopyEnabled()){
        // Measured canopy: one downsampled titiler PNG per source tile over the
        // sweep bbox (uncapped — dense forest works). If titiler is unavailable,
        // tree pixels fall back to WorldCover's flat Forest(m).
        toast(`${node.name}: loading canopy (titiler)…`);
        const cg = await buildCanopyGrid(node.lat - dLat, node.lng - dLng,
          node.lat + dLat, node.lng + dLng, COVERAGE_STEP_M);
        if(cg){
          canopySrc = cg; canopyLabel = ' + measured canopy (titiler)';
          dlog(`  Canopy: titiler grid loaded over ${cg.tiles} source tile(s)`,'ok');
        } else {
          dlog('  Canopy: titiler unavailable — using flat Forest(m)','warn');
        }
      }
      clutter = {
        source: canopySrc ? `${wc.source}${canopyLabel}` : wc.source,
        heightAt(la, ln){
          if(canopySrc){ const h = canopySrc.heightAt(la, ln); if(isFinite(h) && h > 0) return h; }
          return wc.heightAt(la, ln);
        }
      };
    }
    dlog(clutter ? `  Clutter: APPLIED ✓ (${clutter.source})`
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
        renderer: S._covRenderer, color: col, weight: 0, opacity: 0, fillColor: col, fillOpacity: coverageLevelOpacity(level), interactive: false
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
      renderer: S._covRenderer, color: col, weight: 1.5, opacity: 0.85, interactive: false
    }));
  }
  node.coverageLayer = group;
  if(node.coverageOn) node.coverageLayer.addTo(S.map);
}

// ── Coverage overlap highlight ──────────────────────────────
// Highlights where two or more nodes' coverage footprints overlap. Tests the
// REAL per-sample coverage (coverageHeatRays, which already bakes in terrain +
// clutter), not the coverage outline — so shadows and radial gaps are honoured
// instead of filling them in. A grid is sampled over the combined bounds and
// cells covered by ≥2 nodes are painted onto a canvas image overlay.

// Is (lat,lng) inside this node's computed coverage? Maps the point to the
// nearest sweep ray + sample and checks that sample's margin.
function pointInCoverage(node, lat, lng){
  const rays = node.coverageHeatRays;
  const maxR = node.coverageMaxRange;
  if(!rays || !rays.length || !maxR) return false;
  const d = haversine(node.lat, node.lng, lat, lng);
  if(d > maxR) return false;
  const R = rays.length;
  const ri = ((Math.round(bearingTo(node.lat, node.lng, lat, lng) * R / 360) % R) + R) % R;
  const samples = rays[ri].samples;
  if(!samples || !samples.length) return false;
  // Samples are uniform along the ray: sample k sits at maxR*(k+1)/N.
  let k = Math.round(d / maxR * samples.length) - 1;
  if(k < 0) k = 0; else if(k >= samples.length) k = samples.length - 1;
  return samples[k].marginDb >= 0;
}

function renderCoverageOverlap(){
  if(S.overlapLayer){ S.map.removeLayer(S.overlapLayer); S.overlapLayer = null; }
  if(!S.showOverlap) return;
  const nodes = S.nodes.filter(n => n.coverageOn && n.coverageHeatRays?.length && n.coverageMaxRange);
  if(nodes.length < 2) return;
  // Combined bounds across every node's reach.
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for(const n of nodes){
    const { dLat, dLng } = metresToDegrees(n.lat, n.coverageMaxRange);
    minLat = Math.min(minLat, n.lat - dLat); maxLat = Math.max(maxLat, n.lat + dLat);
    minLng = Math.min(minLng, n.lng - dLng); maxLng = Math.max(maxLng, n.lng + dLng);
  }
  // Grid resolution: ~120 m cells, capped so a huge bbox stays cheap.
  const midLat = (minLat + maxLat) / 2;
  const wM = (maxLng - minLng) * 111320 * Math.cos(midLat * Math.PI/180);
  const hM = (maxLat - minLat) * 111320;
  const W = Math.max(2, Math.min(600, Math.round(wM / 120)));
  const H = Math.max(2, Math.min(600, Math.round(hM / 120)));
  const latSpan = maxLat - minLat, lngSpan = maxLng - minLng;
  // "all" → a cell must be reached by every coverage-enabled node; "2+" → ≥2.
  const need = S.overlapMode === 'all' ? nodes.length : 2;
  const over = new Uint8Array(W * H);
  for(let yy = 0; yy < H; yy++){
    const lat = maxLat - (yy + 0.5) / H * latSpan;
    for(let xx = 0; xx < W; xx++){
      const lng = minLng + (xx + 0.5) / W * lngSpan;
      let cnt = 0;
      for(const n of nodes) if(pointInCoverage(n, lat, lng)) cnt++;
      if(cnt >= need) over[yy * W + xx] = 1;
    }
  }
  const at = (g, x, y) => (x >= 0 && x < W && y >= 0 && y < H) ? g[y * W + x] : 0;
  // Light morphological close (dilate then erode) merges speckle and fills
  // single-cell shadow holes so the outline is coherent rather than noisy.
  const dil = new Uint8Array(W * H);
  for(let y = 0; y < H; y++) for(let x = 0; x < W; x++)
    dil[y*W+x] = (at(over,x,y)||at(over,x-1,y)||at(over,x+1,y)||at(over,x,y-1)||at(over,x,y+1)) ? 1 : 0;
  const grid = new Uint8Array(W * H);
  for(let y = 0; y < H; y++) for(let x = 0; x < W; x++)
    grid[y*W+x] = (at(dil,x,y)&&at(dil,x-1,y)&&at(dil,x+1,y)&&at(dil,x,y-1)&&at(dil,x,y+1)) ? 1 : 0;
  // Trace boundary: each cell edge facing a non-overlap cell becomes a thin
  // line segment (a true outline, never a fill — even for 1-cell-wide patches).
  const latAt = r => maxLat - r / H * latSpan, lngAt = c => minLng + c / W * lngSpan;
  const segs = [];
  for(let y = 0; y < H; y++){
    for(let x = 0; x < W; x++){
      if(!grid[y*W+x]) continue;
      const T = latAt(y), B = latAt(y+1), Ln = lngAt(x), Rn = lngAt(x+1);
      if(!at(grid,x-1,y)) segs.push([[T,Ln],[B,Ln]]);
      if(!at(grid,x+1,y)) segs.push([[T,Rn],[B,Rn]]);
      if(!at(grid,x,y-1)) segs.push([[T,Ln],[T,Rn]]);
      if(!at(grid,x,y+1)) segs.push([[B,Ln],[B,Rn]]);
    }
  }
  if(!segs.length) return;
  // Dedicated pane above the coverage fills (overlayPane=400) but below markers (600).
  if(!S.map.getPane('overlapPane')){
    S.map.createPane('overlapPane');
    const p = S.map.getPane('overlapPane');
    p.style.zIndex = 450;
    p.style.pointerEvents = 'none';
  }
  S.overlapLayer = L.polyline(segs, {
    color: '#ff2fd0', weight: 2, opacity: 0.95, interactive: false, pane: 'overlapPane'
  }).addTo(S.map);
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

      const losAt = s => aH + (bH - aH) * (s / N);
      const bareEffAt = s => elevs[s] + bulge(dists[s], dist - dists[s], K);
      const llAt = s => { const t=s/N; return [a.lat+(b.lat-a.lat)*t, a.lng+(b.lng-a.lng)*t]; };

      // Per-point clutter height (m), excluded near both endpoints (own sites clear).
      // WorldCover gives a class + flat per-class height; where the path GRAZES
      // tree cover (Fresnel zone within the tallest possible canopy) we replace
      // the flat value with the measured Meta/WRI canopy height at just those
      // points — accurate where it can change the result, cheap everywhere else.
      let clutterH=null, clutterClass=null, clutterImpact=null;
      if(clutterOn){
        const pad=0.005;
        const wc=await buildWorldCoverGrid(
          Math.min(a.lat,b.lat)-pad, Math.min(a.lng,b.lng)-pad,
          Math.max(a.lat,b.lat)+pad, Math.max(a.lng,b.lng)+pad,
          Math.max(20, dist/N), clutterHeights);
        if(wc){
          // Measured canopy from the titiler grid (one fetch over the link bbox);
          // where titiler is unavailable, tree pixels use WorldCover Forest(m).
          const canopySrc = await buildCanopyGrid(
            Math.min(a.lat,b.lat)-pad, Math.min(a.lng,b.lng)-pad,
            Math.max(a.lat,b.lat)+pad, Math.max(a.lng,b.lng)+pad, Math.max(20, dist/N));
          if(canopySrc) dlog(`  Canopy: titiler grid loaded over ${canopySrc.tiles} source tile(s)`,'ok');
          clutterImpact=makeClutterImpactStats();
          // Parallel land-cover class per sample (0 where excluded/none) so the
          // profile can colour the clutter band by type — see drawClutterBand.
          clutterClass=new Array(dists.length).fill(0);
          clutterH=dists.map((d,s)=>{
            if(d<clutterExcludeM || (dist-d)<clutterExcludeM) return 0;
            const [lat,lng]=llAt(s);
            const cls=wc.classAt(lat,lng);
            clutterClass[s]=cls;
            let h = wc.heightAt(lat,lng);
            if(canopySrc){ const c = canopySrc.heightAt(lat,lng); if(isFinite(c) && c>0) h=c; }
            addClutterImpact(clutterImpact, h, d, [lat,lng], null);
            return h;
          });
        }
      }

      let minLosClear=Infinity,minFzClear=Infinity,minScaledFzClear=Infinity,maxNu=-Infinity;
      let minBareLosClear=Infinity,minBareScaledFzClear=Infinity;
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
      e.profile={elevs,dists,dist,aH,bH,a,b,freq,K,N,clutterH,clutterClass};
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
  const{elevs,dists,dist,aH,bH,a,b,freq,K,N,clutterH,clutterClass}=e.profile;
  const r=e.result;
  const diffTxt=(r&&r.diffLossDb!=null)?`  |  Diff: ${r.diffLossDb.toFixed(1)} dB`:'';
  const title=`${a.name} ↔ ${b.name}  |  ${(dist/1000).toFixed(2)} km  |  GND+ANT: ${aH.toFixed(1)}m → ${bH.toFixed(1)}m${diffTxt}`;
  document.getElementById('chartTitle').textContent=title;
  drawProfile({elevs,dists,dist,aH,bH,freq,K,N,clutterH,clutterClass,result:r,labels:[a.name,b.name]});
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

function drawProfile({elevs,dists,dist,aH,bH,freq,K,N,clutterH,clutterClass,result,labels}){
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
  // Tall canopy/buildings can sit above the Fresnel ceiling — fit to them too.
  if(clutterH) for(let s=0;s<=N;s++) allVals.push(eff[s]+(clutterH[s]||0));
  const minV=Math.min(...allVals)-5,maxV=Math.max(...allVals)+15,rng=maxV-minV||1;
  // Sample index → x pixel; elevation value → y pixel (canvas y grows downward).
  const xp=s=>PAD.l+(s/N)*pw, yp=v=>PAD.t+ph-((v-minV)/rng)*ph;

  ctx.fillStyle='#0b0f17';ctx.fillRect(0,0,W,H);
  drawGrid(ctx,PAD,pw,ph,W,H,minV,rng);
  drawFresnel(ctx,N,xp,yp,losH,fz1,'#00c8f0');
  drawTerrain(ctx,N,xp,yp,eff,H);
  // Surface clutter band sits on the terrain, beneath the bare-LOS blocked tint.
  let clutterClassesPresent=null;
  if(clutterH){
    const pts=[];
    for(let s=0;s<=N;s++) pts.push({x:xp(s),ground:eff[s],top:eff[s]+(clutterH[s]||0),
      cls:clutterClass?clutterClass[s]:0,los:losH(s),fz:fz1(s)});
    clutterClassesPresent=drawClutterBand(ctx,pts,yp);
  }
  drawBlockedAreas(ctx,N,xp,yp,eff,losH);
  const losCol=result?(result.status==='clear'?'#2ecc71':result.status==='marginal'?'#f39c12':'#e74c3c'):'#00c8f0';
  drawLosLine(ctx,xp,yp,0,N,aH,bH,losCol);
  drawEndpoints(ctx,xp,yp,0,N,aH,bH,losCol,labels[0],labels[1]);
  drawXAxis(ctx,PAD,pw,H,dist);
  drawClutterLegend(ctx,PAD,clutterClassesPresent);
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
    const{elevs,dists,dist,aH,bH,freq,K,N,clutterH,clutterClass}=h.e.profile;
    hoverSegments.push({start:cumDist,dist,a:h.flip?h.e.profile.b:h.e.profile.a,b:h.flip?h.e.profile.a:h.e.profile.b});
    const eArr=h.flip?[...elevs].reverse():elevs;
    const dArr=h.flip?dists.map(d=>dist-d).reverse():dists;
    const cH=clutterH?(h.flip?[...clutterH].reverse():clutterH):null;
    const cC=clutterClass?(h.flip?[...clutterClass].reverse():clutterClass):null;
    const hAstart=h.flip?bH:aH, hAend=h.flip?aH:bH;
    for(let s=0;s<=N;s++){
      if(hi>0&&s===0) continue;
      const d1=dArr[s],d2=dist-d1;
      const eff=(s===0||s===N)?eArr[s]:eArr[s]+bulge(Math.abs(d1),Math.abs(d2),K);
      const los=hAstart+(hAend-hAstart)*(s/N);
      const fz=(s===0||s===N)?0:fresnel1(Math.abs(d1),Math.abs(d2),freq);
      samples.push({cumDist:cumDist+dArr[s],elev:eArr[s],eff,los,fz,hopIdx:hi,
        clutterH:cH?(cH[s]||0):0, clutterClass:cC?(cC[s]||0):0, hasClutter:!!cH});
    }
    cumDist+=dist;
  });
  S.profileHover={PAD,totalDist,segments:hoverSegments};

  const allVals=samples.flatMap(s=>[s.eff,s.los,s.eff+s.clutterH]);
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

  // Surface clutter band per hop (heights captured at analyse time; hops with
  // clutter off contribute zero-height samples and are skipped by the drawer).
  let pathClutterClasses=null;
  if(samples.some(s=>s.hasClutter)){
    const pts=samples.map(s=>({x:xp(s.cumDist),ground:s.eff,top:s.eff+s.clutterH,
      cls:s.clutterClass,los:s.los,fz:s.fz}));
    pathClutterClasses=drawClutterBand(ctx,pts,yp);
  }

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
  drawClutterLegend(ctx,PAD,pathClutterClasses);
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

// ── Surface clutter on the profile ─────────────────────────────────────────
// ESA WorldCover class → band colour: vegetation greens, built-up slate, crops
// tan, wetland teal; anything else a muted green. Returned as [r,g,b].
function clutterClassColor(cls){
  switch(cls){
    case 10: case 95: return [46,160,90];    // tree cover / mangrove
    case 20:          return [120,165,75];   // shrubland
    case 50:          return [150,162,180];  // built-up
    case 40:          return [185,170,95];   // cropland
    case 90:          return [80,150,150];   // herbaceous wetland
    default:          return [110,140,110];  // other vegetated
  }
}
function clutterClassLabel(cls){
  return {10:'Tree',20:'Shrub',40:'Crop',50:'Built-up',90:'Wetland',95:'Mangrove'}[cls]||'Clutter';
}

// ═══════════════════════════════════════════════════════════
//  NODE INFO + SUN EXPOSURE
//  A bottom-right panel showing node facts plus a sky view of the surrounding
//  skyline (terrain + surface clutter) with the sun's daily arc across it, so
//  you can see when direct sun is blocked by hills, canopy or buildings.
// ═══════════════════════════════════════════════════════════
const NI = { node:null, horizon:null, wired:false };
const NI_AZ_STEP = 2;              // degrees between skyline samples (180 rays)
const NI_MIN_RANGE = 2;            // m: start scanning close so overhead canopy bites
const NI_TERRAIN_RANGE = 30000;    // m: how far to scan terrain for the skyline (catches distant mountains)
const NI_CLUTTER_RANGE = 5000;     // m: how far to sample surface clutter (far clutter is angularly negligible)
const NI_MAX_ELEV_ANGLE = 90;      // deg: full sky (zenith at the top / centre)
const NI_EARTH_R = 6371000;        // m: geometric earth radius (sunlight is straight)
const NI_PANO_COPIES = 3;          // identical 360° copies tiled across the canvas for seamless wrap-around scroll

// Panorama vertical axis is LINEAR (uniform grading) so the sun traces a smooth,
// even curve with no warp. The maximum angle is framed per-day in niDrawPanorama
// to fit the full sun arc + the skyline, which keeps distant hills visible.

function niEl(id){ return document.getElementById(id); }

// Low-precision solar position (NOAA), good to ~0.01°. `date` is a JS Date in
// local time; lng is east-positive. Returns degrees: elevation above horizon
// and azimuth measured clockwise from true north.
function solarPosition(date, lat, lng){
  const rad = Math.PI/180, deg = 180/Math.PI;
  const jd = date.getTime()/86400000 + 2440587.5;   // Julian day from epoch ms
  const n  = jd - 2451545.0;                          // days since J2000.0
  let L = (280.460 + 0.9856474*n) % 360; if(L<0) L+=360;   // mean longitude
  let g = (357.528 + 0.9856003*n) % 360; if(g<0) g+=360;   // mean anomaly
  const lambda  = L + 1.915*Math.sin(g*rad) + 0.020*Math.sin(2*g*rad); // ecliptic long
  const epsilon = 23.439 - 0.0000004*n;                    // obliquity
  const alpha = Math.atan2(Math.cos(epsilon*rad)*Math.sin(lambda*rad), Math.cos(lambda*rad))*deg;
  const delta = Math.asin(Math.sin(epsilon*rad)*Math.sin(lambda*rad))*deg;     // declination
  let GMST = (280.46061837 + 360.98564736629*n) % 360; if(GMST<0) GMST+=360;
  let H = ((GMST + lng - alpha) % 360 + 540) % 360 - 180;  // hour angle, -180..180
  const latR=lat*rad, decR=delta*rad, hR=H*rad;
  const alt = Math.asin(Math.sin(latR)*Math.sin(decR) + Math.cos(latR)*Math.cos(decR)*Math.cos(hR));
  let az = Math.atan2(-Math.sin(hR), Math.tan(decR)*Math.cos(latR) - Math.sin(latR)*Math.cos(hR));
  return { elevation: alt*deg, azimuth: (az*deg + 360) % 360 };
}

// Build a Date from the panel's date input (YYYY-MM-DD) + minutes-of-day.
function niWhen(dateVal, mins){
  const [Y,M,D] = (dateVal||'').split('-').map(Number);
  const base = (Y && M && D) ? new Date(Y, M-1, D) : new Date();
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(mins/60), mins%60, 0);
}

// Interpolate a per-azimuth skyline array (indexed every NI_AZ_STEP degrees).
function niHorizonAt(arr, azDeg){
  const n = arr.length;
  const f = (((azDeg % 360) + 360) % 360) / NI_AZ_STEP;
  const i0 = Math.floor(f) % n, i1 = (i0+1) % n, fr = f - Math.floor(f);
  return arr[i0]*(1-fr) + arr[i1]*fr;
}
function niClassAt(arr, azDeg){
  return arr[Math.round((((azDeg % 360) + 360) % 360) / NI_AZ_STEP) % arr.length];
}

// March a ring of azimuths out to NI_TERRAIN_RANGE, sampling terrain (and, within
// NI_CLUTTER_RANGE, surface clutter). For each bearing record the highest
// obstruction angle seen: terrain-only and terrain+clutter. The long terrain
// reach catches distant mountains; scanning from NI_MIN_RANGE means a node that
// sits *inside* tall canopy reads a near-vertical obstruction in every direction,
// which is exactly the "you're under the trees" badness we want to show.
async function computeHorizon(node){
  const useClutter = niEl('niClutter').checked;
  const eyeAbove = Math.max(0, parseFloat(niEl('niEye').value) || 0);
  const key = `${node.lat.toFixed(5)},${node.lng.toFixed(5)},${eyeAbove},${useClutter}`;
  if(node._horizonKey === key && node._horizon) return node._horizon;

  const groundElev = node.elev != null ? node.elev : await tileElevAt(node.lat, node.lng);
  const eye = groundElev + eyeAbove;
  const cosLat = Math.max(0.05, Math.cos(node.lat * Math.PI/180));

  // Surface-clutter samplers over a (near) bbox around the node — clutter only
  // bites the skyline close in, so this stays small even though terrain scans far.
  // Use the most accurate source available: the self-hosted measured canopy
  // (titiler) where it's built, falling back to ESA WorldCover land cover where it
  // isn't. The popup always tries titiler — it doesn't wait on the global
  // "measured canopy" setting, which only governs the link/coverage analysis.
  let wcGrid = null, canopyGrid = null;
  if(useClutter){
    const { dLat, dLng } = metresToDegrees(node.lat, NI_CLUTTER_RANGE);
    const heights = clutterHeightTable();
    try { canopyGrid = await buildCanopyGrid(node.lat-dLat, node.lng-dLng, node.lat+dLat, node.lng+dLng, 30); } catch {}
    try { wcGrid = await buildWorldCoverGrid(node.lat-dLat, node.lng-dLng, node.lat+dLat, node.lng+dLng, 30, heights); } catch {}
    dlog(canopyGrid
      ? `Sun view: measured canopy (titiler) loaded over ${canopyGrid.tiles} tile(s) — used where available, WorldCover elsewhere`
      : 'Sun view: no titiler canopy here — using WorldCover land cover', canopyGrid ? 'ok' : 'warn');
  }
  const clutterAt = (lat,lng) => {
    if(canopyGrid){ const c = canopyGrid.heightAt(lat,lng); if(Number.isFinite(c)) return { h:c, cls:10 }; }
    if(wcGrid){ const cls = wcGrid.classAt(lat,lng); return { h: wcGrid.heightAt(lat,lng), cls }; }
    return { h:0, cls:0 };
  };

  // Distance steps along every ray (denser near the node, where small obstructions
  // set the skyline; coarser far out). Shared across all bearings.
  const steps = [];
  for(let d = NI_MIN_RANGE; d <= NI_TERRAIN_RANGE; d += Math.max(15, d*0.03)) steps.push(d);

  const az=[], terr=[], top=[], cls=[];
  for(let a=0; a<360; a+=NI_AZ_STEP){
    const ar = a*Math.PI/180, sin=Math.sin(ar), cos=Math.cos(ar);
    const pts = steps.map(d => [node.lat + (d*cos)/111320, node.lng + (d*sin)/(111320*cosLat)]);
    // Fetch this ray's terrain in parallel; duplicate tile requests de-dupe in cache.
    const gs = await Promise.all(pts.map(([la,ln]) => tileElevAt(la, ln)));
    let maxT=-90, maxTop=-90, topCls=0;
    for(let k=0; k<steps.length; k++){
      const d = steps[k], g = gs[k];
      const drop = d*d/(2*NI_EARTH_R);                 // earth curvature drop
      const tAng = Math.atan2(g - eye - drop, d) * 180/Math.PI;
      if(tAng > maxT) maxT = tAng;
      if(tAng > maxTop) maxTop = tAng;   // bare terrain feeds the top skyline at every range
      if(useClutter && d <= NI_CLUTTER_RANGE){
        const cl = clutterAt(pts[k][0], pts[k][1]);
        const topAng = Math.atan2(g + cl.h - eye - drop, d) * 180/Math.PI;
        if(topAng > maxTop){ maxTop = topAng; topCls = cl.cls; }
      }
    }
    az.push(a); terr.push(Math.max(0,maxT)); top.push(Math.max(0,maxTop)); cls.push(topCls);
  }

  const nodeClutter = useClutter ? clutterAt(node.lat, node.lng) : { h:0, cls:0 };
  const h = { az, terr, top, cls, eye, groundElev, eyeAbove, useClutter,
              clutterSource: canopyGrid ? 'titiler' : (wcGrid ? 'WorldCover' : null),
              nodeClutter: nodeClutter.h, nodeClutterCls: nodeClutter.cls,
              underCanopy: nodeClutter.h > eyeAbove };
  node._horizon = h; node._horizonKey = key;
  return h;
}

function openNodeInfo(node){
  closeCtx();
  selectNodeView(node.id, { force:true });
  S.map.panTo([node.lat, node.lng], { animate:true });
  NI.node = node;
  niWire();
  niEl('nodeInfoPanel').classList.add('open');
  if(!niEl('niDate').value){
    const d = new Date();
    niEl('niDate').value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  // Eye sits at the antenna tip by default (the app models the radio at
  // ground + antH); drop it to ~2 m to check sun/shade for a person or panel.
  niEl('niEye').value = node.antH ?? 2;
  niEl('niTitle').textContent = `NODE INFO · ${node.name}`;
  niRenderFacts();
  niRenderLinks(node);
  niEl('niStatus').textContent = 'Scanning skyline…';
  // Centre the (wider-than-viewport) panorama on North, where the sun's arc sits.
  requestAnimationFrame(() => { const wrap = niEl('niPanoWrap'); if(wrap) wrap.scrollLeft = (wrap.scrollWidth - wrap.clientWidth) / 2; });
  niRescan();
}

function niRescan(){
  const node = NI.node;
  if(!node) return;
  niEl('niStatus').textContent = 'Scanning skyline…';
  computeHorizon(node).then(h => {
    if(NI.node !== node) return;        // panel changed/closed mid-scan
    NI.horizon = h;
    niRenderFacts();
    niRender();
  }).catch(e => { if(NI.node===node) niEl('niStatus').textContent = 'Skyline scan failed: ' + (e.message||e); });
}

function closeNodeInfo(){
  niEl('nodeInfoPanel').classList.remove('open');
  NI.node = null; NI.horizon = null;
}

// List the links touching this node with their bearing + distance. Clicking a
// row selects that link, which highlights it on the map and draws its terrain
// cross-section in the profile panel below — the popup stays open throughout.
function niRenderLinks(node){
  const box = niEl('niLinks'); box.innerHTML = '';
  const edges = S.edges.filter(e => e.aId === node.id || e.bId === node.id);
  if(!edges.length){ box.style.display = 'none'; return; }
  box.style.display = '';
  const title = document.createElement('div');
  title.className = 'ni-links-title'; title.textContent = 'LINKS';
  box.appendChild(title);
  edges.forEach(e => {
    const other = S.nodes.find(n => n.id === (e.aId === node.id ? e.bId : e.aId));
    if(!other) return;
    const brg = bearingTo(node.lat, node.lng, other.lat, other.lng);
    const km = haversine(node.lat, node.lng, other.lat, other.lng) / 1000;
    const isActive = S.activeView?.type === 'edge' && S.activeView.id === e.id;
    const analysed = !!e.profile;
    const btn = document.createElement('button');
    btn.className = 'ni-link' + (isActive ? ' active' : '');
    btn.title = analysed ? 'Show this link in the terrain profile' : 'Analyse, then show this link in the terrain profile';
    const nm = document.createElement('span'); nm.className = 'ni-link-name'; nm.textContent = '→ ' + other.name;
    const meta = document.createElement('span'); meta.className = 'ni-link-meta';
    meta.textContent = `${String(Math.round(brg)).padStart(3,'0')}° · ${km.toFixed(2)} km`;
    btn.appendChild(nm); btn.appendChild(meta);
    // Show the analysed link status (clear / marginal / blocked); a muted hint
    // until the link has been analysed (clicking will run the analysis).
    const tag = document.createElement('span'); tag.className = 'ni-link-status';
    const st = e.result?.status;
    if(st){
      tag.style.color = st==='clear' ? '#2ecc71' : st==='marginal' ? '#f39c12' : '#e74c3c';
      tag.textContent = (st==='error' ? 'ERROR' : st).toUpperCase();
    }else{
      tag.style.color = 'var(--muted)'; tag.textContent = 'ANALYSE';
    }
    btn.appendChild(tag);
    btn.addEventListener('click', async () => {
      // The terrain profile + status only exist after analysis — run it on demand.
      if(!e.profile && S.edges.length && !S._analysing) await runAnalysis();
      selectEdgeView(e.id, { force:true });
      if(NI.node === node) niRenderLinks(node);
    });
    box.appendChild(btn);
  });
}

function niWire(){
  if(NI.wired) return; NI.wired = true;
  niEl('niClose').addEventListener('click', closeNodeInfo);
  niEl('niTime').addEventListener('input', niRender);
  niEl('niDate').addEventListener('change', niRender);
  niEl('niEye').addEventListener('change', niRescan);
  niEl('niClutter').addEventListener('change', () => { if(NI.node) niRescan(); });
  // Seamless wrap-around: the panorama is NI_PANO_COPIES identical copies; when a
  // scroll crosses into the first or last copy, snap back by one copy so panning
  // around the compass never hits an edge.
  const wrap = niEl('niPanoWrap');
  wrap.addEventListener('scroll', () => {
    const one = wrap.scrollWidth / NI_PANO_COPIES;
    if(wrap.scrollLeft < one) wrap.scrollLeft += one;
    else if(wrap.scrollLeft >= 2 * one) wrap.scrollLeft -= one;
  });
  // Click-and-drag to pan horizontally (mouse only — touch already pans natively).
  // Incremental deltas so it stays seamless across the wrap-around snap.
  let dragging = false, lastX = 0;
  wrap.addEventListener('pointerdown', e => {
    if(e.pointerType !== 'mouse') return;
    dragging = true; lastX = e.clientX;
    wrap.classList.add('dragging');
    wrap.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  wrap.addEventListener('pointermove', e => {
    if(!dragging) return;
    wrap.scrollLeft -= (e.clientX - lastX);
    lastX = e.clientX;
  });
  const endDrag = e => {
    if(!dragging) return;
    dragging = false;
    wrap.classList.remove('dragging');
    try { wrap.releasePointerCapture(e.pointerId); } catch {}
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);
}

function niFmtHM(mins){
  const m = Math.round(mins);
  return `${Math.floor(m/60)}h ${String(m%60).padStart(2,'0')}m`;
}

function niRenderFacts(){
  const node = NI.node; if(!node) return;
  const h = NI.horizon;
  const rows = [
    ['Name', node.name],
    ['Lat, Lng', `${node.lat.toFixed(5)}, ${node.lng.toFixed(5)}`],
    ['Ground elev', node.elev != null ? `${node.elev.toFixed(0)} m` : '…'],
    ['Antenna h', `${node.antH} m`],
  ];
  if(h){
    rows.push(['Eye height', `${h.eyeAbove} m above ground`]);
    // Always show the clutter-at-node row, with its current state.
    let clutterVal;
    if(!h.useClutter){
      clutterVal = 'not applied (clutter off)';
    }else if(h.nodeClutter > 0){
      const label = clutterClassLabel(h.nodeClutterCls);
      const src = h.clutterSource ? ` · ${h.clutterSource}` : '';
      clutterVal = `${h.nodeClutter.toFixed(0)} m ${label}${h.underCanopy ? ' — under it ⚠' : ''}${src}`;
    }else{
      clutterVal = `none here${h.clutterSource ? ` · ${h.clutterSource}` : ''}`;
    }
    rows.push(['Clutter @ node', clutterVal]);
  }
  const f = niEl('niFacts'); f.innerHTML = '';
  for(const [k,v] of rows){
    const b = document.createElement('b'); b.textContent = k;
    const s = document.createElement('span'); s.textContent = v;
    f.appendChild(b); f.appendChild(s);
  }
}

function niSetupCanvas(cv){
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, hh = cv.clientHeight;
  cv.width = Math.round(w*dpr); cv.height = Math.round(hh*dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: hh };
}

// Map compass azimuth → panorama x. North is centred, west on the left, east on
// the right, south at both edges — natural when facing north (true for the
// southern-hemisphere sun, which tracks across the northern sky).
function niAzToX(az, w){ return (((az + 180) % 360) / 360) * w; }

function niRender(){
  const node = NI.node, h = NI.horizon;
  if(!node || !h) return;
  const dateVal = niEl('niDate').value;
  const mins = +niEl('niTime').value;
  niEl('niTimeLabel').textContent = `${String(Math.floor(mins/60)).padStart(2,'0')}:${String(mins%60).padStart(2,'0')}`;
  const when = niWhen(dateVal, mins);
  const sun = solarPosition(when, node.lat, node.lng);
  const skyAtSun = niHorizonAt(h.top, sun.azimuth);
  const terrAtSun = niHorizonAt(h.terr, sun.azimuth);
  const exposed = sun.elevation > 0 && sun.elevation > skyAtSun;

  // Daily totals: step through the chosen day counting daylight vs direct-sun.
  let daylight = 0, sunlit = 0;
  for(let m=0; m<=1439; m+=5){
    const s = solarPosition(niWhen(dateVal, m), node.lat, node.lng);
    if(s.elevation > 0){ daylight += 5; if(s.elevation > niHorizonAt(h.top, s.azimuth)) sunlit += 5; }
  }

  let cur;
  if(sun.elevation <= 0){
    cur = '<span class="sun-off">Sun below horizon (night)</span>';
  }else if(exposed){
    cur = `<span class="sun-on">☀ Direct sun</span> — alt ${sun.elevation.toFixed(0)}°, az ${sun.azimuth.toFixed(0)}°`;
  }else{
    const by = sun.elevation <= terrAtSun ? 'terrain' : 'canopy/clutter';
    cur = `<span class="sun-off">⛅ Sun blocked</span> by ${by} — alt ${sun.elevation.toFixed(0)}°, az ${sun.azimuth.toFixed(0)}°`;
  }
  const daily = daylight ? `Direct sun ${niFmtHM(sunlit)} of ${niFmtHM(daylight)} daylight (${Math.round(sunlit/daylight*100)}%)`
                         : 'No daylight on this date';
  niEl('niStatus').innerHTML = cur + '<br>' + daily + (h.underCanopy ? ' · <span class="sun-off">⚠ under canopy</span>' : '');

  niDrawPanorama(node, h, sun, dateVal);
  niDrawPolar(node, h, sun);
}

function niDrawPanorama(node, h, sun, dateVal){
  const { ctx, w, h:H } = niSetupCanvas(niEl('niPanorama'));
  // The canvas holds NI_PANO_COPIES identical 360° copies side by side; the
  // scroll wrapper snaps back by one copy at the edges (see niWire) so panning
  // around the compass is seamless and endless. ONE = width of a single copy.
  const ONE = w / NI_PANO_COPIES;

  // Frame the LINEAR vertical axis to fit the day's full sun arc plus the skyline
  // (with a little headroom). Uniform grading → the sun path is a smooth, even
  // curve; framing tight keeps distant hills visible rather than lost at 90°.
  let maxSun = 0;
  for(let m=0; m<=1439; m+=15){ const e = solarPosition(niWhen(dateVal, m), node.lat, node.lng).elevation; if(e > maxSun) maxSun = e; }
  const maxSky = h.top.reduce((m,v) => Math.max(m,v), 0);
  const maxAngle = Math.min(90, Math.max(30, maxSun + 6, maxSky + 6));
  const y = a => H * (1 - Math.max(0, Math.min(maxAngle, a)) / maxAngle);

  const sky = ctx.createLinearGradient(0,0,0,H);
  sky.addColorStop(0,'#0a1830'); sky.addColorStop(1,'#244a72');
  ctx.fillStyle = sky; ctx.fillRect(0,0,w,H);

  // elevation gridlines (even spacing — uniform scale)
  const gstep = maxAngle <= 30 ? 5 : maxAngle <= 60 ? 10 : 15;
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.fillStyle = 'rgba(200,218,234,.5)';
  ctx.font = '9px monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  for(let a = gstep; a < maxAngle; a += gstep){
    ctx.beginPath(); ctx.moveTo(0,y(a)); ctx.lineTo(w,y(a)); ctx.stroke();
    ctx.fillText(`${a}°`, 2, y(a)-1);
  }

  // terrain (solid) + clutter (translucent class colour) — tiled: each pixel maps
  // to its azimuth within the copy it falls in, so the bands repeat seamlessly.
  const azAtPx = px => ((((px % ONE) / ONE) * 360) - 180 + 360) % 360;
  for(let px=0; px<w; px++){
    const az = azAtPx(px);
    const tA = niHorizonAt(h.terr, az);
    const cA = niHorizonAt(h.top, az);
    ctx.fillStyle = '#0e1d2b';
    ctx.fillRect(px, y(tA), 1, H - y(tA));
    if(cA > tA + 0.05){
      const [r,g,b] = clutterClassColor(niClassAt(h.cls, az) || 10);
      ctx.fillStyle = `rgba(${r},${g},${b},.78)`;
      ctx.fillRect(px, y(cA), 1, y(tA) - y(cA));
    }
  }
  // crisp terrain ridge line (copy boundaries meet at S=180°, so it stays continuous)
  ctx.strokeStyle = '#3a5a72'; ctx.beginPath();
  for(let px=0; px<w; px++){
    const yy = y(niHorizonAt(h.terr, azAtPx(px)));
    px ? ctx.lineTo(px,yy) : ctx.moveTo(px,yy);
  }
  ctx.stroke();

  // Sunrise / sunset minutes (first & last the sun is up) — computed once.
  let riseM = null, setM = null;
  for(let m=0; m<=1439; m+=2){
    if(solarPosition(niWhen(dateVal, m), node.lat, node.lng).elevation > 0){ if(riseM==null) riseM=m; setM=m; }
  }

  // Draw the sun overlays (arc, hour ticks, rise/set, current disc, compass) into
  // one copy offset by x0; called once per copy so they repeat with the terrain.
  const drawOverlays = x0 => {
    // sun's daily arc
    let prevX = null, prevY = null;
    ctx.lineWidth = 1;
    for(let m=0; m<=1439; m+=8){
      const s = solarPosition(niWhen(dateVal, m), node.lat, node.lng);
      if(s.elevation < -1){ prevX = null; continue; }
      const X = x0 + niAzToX(s.azimuth, ONE), Y = y(s.elevation);
      const lit = s.elevation > 0 && s.elevation > niHorizonAt(h.top, s.azimuth);
      if(prevX != null && Math.abs(X - prevX) < ONE*0.5){
        ctx.strokeStyle = lit ? 'rgba(255,210,63,.9)' : 'rgba(150,165,185,.6)';
        ctx.beginPath(); ctx.moveTo(prevX, prevY); ctx.lineTo(X, Y); ctx.stroke();
      }
      prevX = X; prevY = Y;
    }
    // hour ticks (labelled every 3rd hour, 24h local time)
    ctx.textAlign = 'center';
    for(let hr=0; hr<=24; hr++){
      const s = solarPosition(niWhen(dateVal, hr*60), node.lat, node.lng);
      if(s.elevation <= 0) continue;
      const X = x0 + niAzToX(s.azimuth, ONE), Y = y(s.elevation);
      ctx.beginPath(); ctx.arc(X, Y, hr%3===0 ? 2.4 : 1.4, 0, 7);
      ctx.fillStyle = 'rgba(255,225,140,.95)'; ctx.fill();
      if(hr%3===0){
        ctx.fillStyle = 'rgba(255,225,140,.85)'; ctx.font = '8px monospace'; ctx.textBaseline = 'bottom';
        ctx.fillText(`${String(hr).padStart(2,'0')}h`, X, Y-4);
      }
    }
    // sunrise / sunset markers
    for(const [m,lab] of [[riseM,'rise'],[setM,'set']]){
      if(m==null) continue;
      const s = solarPosition(niWhen(dateVal, m), node.lat, node.lng);
      const X = x0 + niAzToX(s.azimuth, ONE), Y = y(Math.max(0,s.elevation));
      ctx.beginPath(); ctx.arc(X, Y, 3.5, 0, 7);
      ctx.fillStyle = '#ffd23f'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = '#000'; ctx.stroke();
      ctx.fillStyle = 'rgba(255,210,63,.95)'; ctx.font = '8px monospace'; ctx.textBaseline = 'top';
      ctx.fillText(`${lab} ${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`, X, Y+4);
    }
    // current sun disc
    if(sun.elevation > -1){
      const X = x0 + niAzToX(sun.azimuth, ONE), Y = y(sun.elevation);
      const lit = sun.elevation > 0 && sun.elevation > niHorizonAt(h.top, sun.azimuth);
      ctx.beginPath(); ctx.arc(X, Y, 6, 0, 7);
      ctx.fillStyle = lit ? '#ffd23f' : '#7a8aa0';
      ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#000'; ctx.stroke();
    }
    // compass labels (N centred, W left, E right, S edges)
    ctx.fillStyle = 'rgba(200,218,234,.85)'; ctx.font = '10px monospace'; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    for(const [az,lab] of [[0,'N'],[90,'E'],[180,'S'],[270,'W']]){
      ctx.fillText(lab, x0 + niAzToX(az, ONE), 2);
    }
  };
  for(let c=0; c<NI_PANO_COPIES; c++) drawOverlays(c * ONE);
}

function niDrawPolar(node, h, sun){
  const { ctx, w, h:H } = niSetupCanvas(niEl('niPolar'));
  const cx = w/2, cy = H/2, R = Math.min(w,H)/2 - 12;
  const P = Math.PI/180;
  const pt = (az, r) => [cx + r*Math.sin(az*P), cy - r*Math.cos(az*P)];

  // whole sky disc = obstructed, then carve out the open sky polygon
  ctx.fillStyle = 'rgba(70,100,70,.5)';
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fill();
  ctx.beginPath();
  for(let i=0; i<h.az.length; i++){
    const open = R * (1 - Math.min(1, h.top[i]/NI_MAX_ELEV_ANGLE));
    const [x,yy] = pt(h.az[i], open);
    i ? ctx.lineTo(x,yy) : ctx.moveTo(x,yy);
  }
  ctx.closePath(); ctx.fillStyle = '#0a1f38'; ctx.fill();

  // rings + N marker
  ctx.strokeStyle = 'rgba(255,255,255,.12)';
  for(const rr of [R, R*0.66, R*0.33]){ ctx.beginPath(); ctx.arc(cx,cy,rr,0,7); ctx.stroke(); }
  ctx.fillStyle = 'rgba(200,218,234,.8)'; ctx.font = '9px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('N', cx, cy - R - 5);

  // sun: zenith at centre, horizon at rim
  if(sun.elevation > -1){
    const r = R * (1 - Math.max(0, sun.elevation)/90);
    const [x,yy] = pt(sun.azimuth, r);
    const lit = sun.elevation > 0 && sun.elevation > niHorizonAt(h.top, sun.azimuth);
    ctx.beginPath(); ctx.arc(x, yy, 4, 0, 7);
    ctx.fillStyle = lit ? '#ffd23f' : '#7a8aa0';
    ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = '#000'; ctx.stroke();
  }
}

// Draw the clutter band on a profile (A + D) with Fresnel/LOS intrusion
// highlighted (C). `pts` are ordered samples {x(px), ground, top, cls, los, fz}
// in metres. The hard LOS gate stays on bare terrain (drawBlockedAreas); here a
// clutter top inside the Fresnel zone is amber, above the LOS line red.
// Returns the Set of land-cover classes actually drawn, for the legend.
function drawClutterBand(ctx,pts,yp){
  const present=new Set();
  const has=(a,b)=>(a.top-a.ground)>0||(b.top-b.ground)>0;
  // Per-segment band quads so each segment can carry its own land-cover colour.
  for(let i=1;i<pts.length;i++){
    const a=pts[i-1],b=pts[i];
    if(!has(a,b)) continue;
    const cls=b.cls||a.cls||0;
    present.add(cls);
    const [r,g,bl]=clutterClassColor(cls);
    ctx.beginPath();
    ctx.moveTo(a.x,yp(a.ground));ctx.lineTo(b.x,yp(b.ground));
    ctx.lineTo(b.x,yp(b.top));ctx.lineTo(a.x,yp(a.top));ctx.closePath();
    ctx.fillStyle=`rgba(${r},${g},${bl},.45)`;ctx.fill();
  }
  // Clutter-top line + intrusion tint over the band.
  for(let i=1;i<pts.length;i++){
    const a=pts[i-1],b=pts[i];
    if(!has(a,b)) continue;
    const losCross=b.top>b.los||a.top>a.los;
    const fzIntrude=(b.los-b.top)<b.fz||(a.los-a.top)<a.fz;
    if(losCross||fzIntrude){
      ctx.beginPath();
      ctx.moveTo(a.x,yp(a.ground));ctx.lineTo(b.x,yp(b.ground));
      ctx.lineTo(b.x,yp(b.top));ctx.lineTo(a.x,yp(a.top));ctx.closePath();
      ctx.fillStyle=losCross?'rgba(231,76,60,.25)':'rgba(243,156,18,.22)';ctx.fill();
    }
    ctx.beginPath();ctx.moveTo(a.x,yp(a.top));ctx.lineTo(b.x,yp(b.top));
    ctx.strokeStyle=losCross?'rgba(231,76,60,.95)':fzIntrude?'rgba(243,156,18,.9)':'rgba(190,210,180,.7)';
    ctx.lineWidth=1.5;ctx.stroke();
  }
  return present;
}

// Compact legend of the clutter classes present, drawn inside the plot.
function drawClutterLegend(ctx,PAD,classes){
  if(!classes) return;
  const items=[...classes].filter(c=>c>0).map(c=>[c,clutterClassLabel(c)]);
  if(!items.length) return;
  ctx.save();
  ctx.font='8px "Share Tech Mono"';ctx.textAlign='left';ctx.textBaseline='middle';
  let x=PAD.l+6;const y=PAD.t+7;
  for(const [cls,label] of items){
    const [r,g,b]=clutterClassColor(cls);
    ctx.fillStyle=`rgba(${r},${g},${b},.85)`;ctx.fillRect(x,y-4,8,8);
    ctx.fillStyle='#aeb9c4';ctx.fillText(label,x+11,y);
    x+=11+ctx.measureText(label).width+10;
  }
  ctx.fillStyle='rgba(243,156,18,.95)';ctx.fillText('▮ Fresnel',x,y);x+=ctx.measureText('▮ Fresnel').width+8;
  ctx.fillStyle='rgba(231,76,60,.95)';ctx.fillText('▮ LOS',x,y);
  ctx.restore();
}

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
      cm:inpVal('inpCovMaxKm'), co:clutterEnabled()?1:0, cy:canopyEnabled()?1:0,
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
  const nativeBtn=document.getElementById('btnShareNative');
  if(nativeBtn) nativeBtn.hidden=!navigator.share;
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

// Native share sheet (Messages / Mail / etc.) — the natural way to send a link
// from an installed PWA where there's no address bar. Feature-detected.
function shareNative(){
  const url=document.getElementById('shareUrl').textContent;
  if(!navigator.share){ copyShareUrl(); return; }
  navigator.share({title:'ClearPath map',url}).then(()=>closeShare()).catch(()=>{});
}

// Accept either a full share URL or a bare hash payload, returning the part
// after the '#'. Tolerates leading/trailing whitespace from a paste.
function extractShareHash(text){
  const t=(text||'').trim();
  if(!t) return '';
  const i=t.indexOf('#');
  return (i>=0 ? t.slice(i+1) : t).trim();
}

// PWA install has no address bar, so a link someone sends can't be opened in the
// app directly — paste it here instead. Replaces the current map.
function loadPastedLink(){
  const field=document.getElementById('shareLoadInput');
  const hash=extractShareHash(field.value);
  if(!hash){ toast('Paste a share link first.',2500); return; }
  // Validate before clearAll() so a bad paste never wipes the current map.
  try{ parseSharedHash(hash); }
  catch(err){ toast('That doesn’t look like a valid ClearPath link.',3500); return; }
  clearAll();
  try{ history.replaceState(null,'',window.location.pathname+window.location.search+'#'+hash); }catch{}
  loadFromHash(hash);          // re-parses and shows its own success toast
  field.value='';
  closeShare();
}

// One-tap fill of the paste field from the clipboard (iOS shows a Paste prompt).
function pasteShareLink(){
  if(!navigator.clipboard?.readText){ document.getElementById('shareLoadInput').focus(); return; }
  navigator.clipboard.readText()
    .then(t=>{ document.getElementById('shareLoadInput').value=t; loadPastedLink(); })
    .catch(()=>{ toast('Couldn’t read clipboard — paste manually.',2500); document.getElementById('shareLoadInput').focus(); });
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
    canopyOn: !!raw.cy,
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

function loadFromHash(hashStr){
  const hash=(hashStr!=null?hashStr:window.location.hash.slice(1));
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
    const canopyCb=document.getElementById('inpCanopyOn');
    if(canopyCb) canopyCb.checked=!!data.canopyOn;
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
  on('btnShareNative','click',shareNative);
  on('btnSharePaste','click',pasteShareLink);
  on('btnShareLoad','click',loadPastedLink);
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
   'inpClutterOn','inpCanopyOn','inpClutterForest','inpClutterUrban','inpClutterExclude','inpClutterAtten']
    .forEach(id=>on(id,'change',onCoverageParamChanged));
  on('inpShowLinks','change',function(){ setDisplayVisibility('links', this.checked); });
  on('inpShowPaths','change',function(){ setDisplayVisibility('paths', this.checked); });
  on('btnCovAllOn','click',()=>setAllCoverage(true));
  on('btnCovAllOff','click',()=>setAllCoverage(false));
  on('btnCovComputeAll','click',computeAllCoverage);
  on('btnCovOverlap','click',toggleOverlap);
  on('overlapMode','change',e=>{ S.overlapMode = e.target.value; refreshOverlap(); });
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
  on('btnComputeAllCov','click',computeAllCoverage);
  // Minimise / restore the left side panel
  on('btnSidebarMin','click',()=>{
    document.querySelector('.sidebar')?.classList.add('collapsed');
    document.getElementById('btnSidebarExpand')?.classList.add('show');
  });
  on('btnSidebarExpand','click',()=>{
    document.querySelector('.sidebar')?.classList.remove('collapsed');
    document.getElementById('btnSidebarExpand')?.classList.remove('show');
  });
  // Minimise / restore the terrain profile chart
  on('btnChartMin','click',function(){
    const panel = document.querySelector('.chart-panel');
    const collapsed = panel?.classList.toggle('collapsed');
    // Drop the floating buttons down with the now-short chart panel.
    panel?.closest('.map-col')?.classList.toggle('chart-collapsed', collapsed);
    this.textContent = collapsed ? '▴' : '–';
    this.title = collapsed ? 'Restore terrain profile' : 'Minimise terrain profile';
  });
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
