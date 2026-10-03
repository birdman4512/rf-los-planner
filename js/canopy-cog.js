/* Reads ClearPath's canopy COGs straight from static storage (Cloudflare R2)
 * with HTTP Range requests, so no tile server is needed. Supports what
 * scripts/canopy/build-tile.sh writes: one uint8 band, tiled, DEFLATE or
 * uncompressed, optional horizontal predictor, internal overviews, classic
 * TIFF or BigTIFF, EPSG:3857 georeferencing.
 *
 * Speed: only the overview level that resolves the requested step is read;
 * adjacent tile byte ranges merge into one request; requests share a global
 * concurrency limit; tile URLs are immutable, so header and tile bytes are
 * also kept in the Cache API across sessions.
 */
(function (root) {
  'use strict';
  const HEADER_BYTES = 65536;    // GDAL COGs keep every IFD + tile index up front
  const MERGE_GAP = 16384;       // join tile ranges closer than this…
  const MAX_SPAN = 4 << 20;      // …into requests of at most this many bytes
  const CONCURRENCY = 6;
  const TIMEOUT_MS = 30000;
  const MAX_TILES = 192;         // per sampler; coarsen a level beyond this (~48 MB)
  const MEM_TILES = 256;         // decoded tiles kept for reuse between samplers
  const CACHE_NAME = 'clearpath-canopy-v1';
  const CACHE_MAX_ENTRIES = 4000;
  const R = 6378137;
  const TYPE_SIZE = {1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8,13:4,16:8,17:8,18:8};

  let fetchImpl = (...a) => root.fetch(...a);
  let persistent = true;

  // ── Concurrency limit shared by every COG ──
  let active = 0;
  const waiting = [];
  function limited(fn){
    return new Promise((resolve, reject) => {
      const run = async () => {
        active++;
        try{ resolve(await fn()); }catch(e){ reject(e); }
        finally{ active--; if(waiting.length) waiting.shift()(); }
      };
      if(active < CONCURRENCY) run(); else waiting.push(run);
    });
  }

  // ── Persistent byte cache (Cache API). Keys are immutable tile URLs plus a
  //    byte range, so entries never go stale; only the count is capped. ──
  let cachePromise = null;
  function openCache(){
    if(!persistent || !root.caches) return Promise.resolve(null);
    if(!cachePromise){
      cachePromise = root.caches.open(CACHE_NAME).then(c => {
        c.keys().then(keys => {   // oldest first; trim in the background
          keys.slice(0, Math.max(0, keys.length - CACHE_MAX_ENTRIES)).forEach(k => c.delete(k));
        }).catch(() => {});
        return c;
      }).catch(() => null);
    }
    return cachePromise;
  }
  const cacheKey = (url, start, end) => `${url}${url.includes('?') ? '&' : '?'}bytes=${start}-${end}`;
  async function cacheGet(url, start, end){
    const c = await openCache();
    if(!c) return null;
    try{ const hit = await c.match(cacheKey(url, start, end)); return hit ? await hit.arrayBuffer() : null; }
    catch{ return null; }
  }
  async function cachePut(url, start, end, buf){
    const c = await openCache();
    if(c) try{ await c.put(cacheKey(url, start, end), new Response(buf)); }catch{}
  }

  // Network read of [start, end). Tolerates a server that ignores Range.
  function fetchRange(url, start, end){
    return limited(async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try{
        const res = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: ctl.signal });
        if(res.status === 200) return (await res.arrayBuffer()).slice(start, end);
        if(res.status !== 206) throw new Error(`HTTP ${res.status}`);
        return await res.arrayBuffer();
      }catch(e){
        throw e.name === 'AbortError' ? new Error('request timed out') : e;
      }finally{
        clearTimeout(timer);
      }
    });
  }

  async function cachedRange(url, start, end){
    const hit = await cacheGet(url, start, end);
    if(hit) return hit;
    const buf = await fetchRange(url, start, end);
    cachePut(url, start, end, buf.slice(0));
    return buf;
  }

  // ── TIFF structure ──
  function readValues(dv, base, type, count, le){
    if(type === 2){
      let s = '';
      for(let i = 0; i < count; i++){ const c = dv.getUint8(base + i); if(c) s += String.fromCharCode(c); }
      return s;
    }
    const out = new Array(count);
    for(let i = 0; i < count; i++){
      const o = base + i * TYPE_SIZE[type];
      switch(type){
        case 1: case 7: out[i] = dv.getUint8(o); break;
        case 6: out[i] = dv.getInt8(o); break;
        case 3: out[i] = dv.getUint16(o, le); break;
        case 8: out[i] = dv.getInt16(o, le); break;
        case 4: case 13: out[i] = dv.getUint32(o, le); break;
        case 9: out[i] = dv.getInt32(o, le); break;
        case 5: out[i] = dv.getUint32(o, le) / dv.getUint32(o + 4, le); break;
        case 11: out[i] = dv.getFloat32(o, le); break;
        case 12: out[i] = dv.getFloat64(o, le); break;
        case 16: case 18: out[i] = Number(dv.getBigUint64(o, le)); break;
        case 17: out[i] = Number(dv.getBigInt64(o, le)); break;
        default: out[i] = NaN;
      }
    }
    return out;
  }

  async function parse(url){
    const head = await cachedRange(url, 0, HEADER_BYTES);
    // Bytes from the header buffer when they're in it, else a separate read.
    const bytesAt = async (off, len) => off + len <= head.byteLength
      ? new DataView(head, off, len)
      : new DataView(await cachedRange(url, off, off + len));
    const dv = new DataView(head);
    const order = String.fromCharCode(dv.getUint8(0), dv.getUint8(1));
    if(order !== 'II' && order !== 'MM') throw new Error('not a TIFF');
    const le = order === 'II';
    const magic = dv.getUint16(2, le), big = magic === 43;
    if(magic !== 42 && !big) throw new Error('not a TIFF');
    const ptr = (v, o) => big ? Number(v.getBigUint64(o, le)) : v.getUint32(o, le);
    const es = big ? 20 : 12, inlineMax = big ? 8 : 4;
    const ifds = [];
    let off = big ? Number(dv.getBigUint64(8, le)) : dv.getUint32(4, le);
    while(off && ifds.length < 64){
      const nv = await bytesAt(off, big ? 8 : 2);
      const n = big ? Number(nv.getBigUint64(0, le)) : nv.getUint16(0, le);
      const v = await bytesAt(off + (big ? 8 : 2), n * es + (big ? 8 : 4));
      const tags = {};
      for(let i = 0; i < n; i++){
        const e = i * es, tag = v.getUint16(e, le), type = v.getUint16(e + 2, le);
        const count = big ? Number(v.getBigUint64(e + 4, le)) : v.getUint32(e + 4, le);
        const size = (TYPE_SIZE[type] || 1) * count, valOff = e + (big ? 12 : 8);
        tags[tag] = size <= inlineMax
          ? readValues(v, valOff, type, count, le)
          : readValues(await bytesAt(ptr(v, valOff), size), 0, type, count, le);
      }
      ifds.push(tags);
      off = ptr(v, n * es);
    }
    const first = ifds[0];
    if(!first) throw new Error('TIFF has no images');
    const scale = first[33550], tie = first[33922];
    if(!scale || !tie) throw new Error('COG has no georeferencing');
    const nodataTag = first[42113];
    const nodata = nodataTag != null && nodataTag !== '' ? Number(nodataTag) : null;
    const levels = ifds
      .filter(t => !(((t[254] || [0])[0]) & 4))                 // skip mask IFDs
      .map(t => ({
        w: t[256][0], h: t[257][0],
        tw: (t[322] || [0])[0], th: (t[323] || [0])[0],
        offsets: t[324], counts: t[325],
        compression: (t[259] || [1])[0], predictor: (t[317] || [1])[0],
        bits: (t[258] || [8])[0], spp: (t[277] || [1])[0], fmt: (t[339] || [1])[0]
      }));
    for(const L of levels){
      if(!L.tw || !L.offsets || !L.counts) throw new Error('COG is not tiled');
      if(L.bits !== 8 || L.spp !== 1 || L.fmt !== 1) throw new Error('COG is not single-band uint8');
      if(![1, 8, 32946].includes(L.compression)) throw new Error(`COG compression ${L.compression} unsupported`);
      if(![1, 2].includes(L.predictor)) throw new Error(`COG predictor ${L.predictor} unsupported`);
      L.resX = scale[0] * levels[0].w / L.w;
      L.resY = scale[1] * levels[0].h / L.h;
      L.tilesX = Math.ceil(L.w / L.tw);
      L.tilesY = Math.ceil(L.h / L.th);
    }
    levels.sort((a, b) => a.resX - b.resX);
    return { url, levels, nodata,
      originX: tie[3] - tie[0] * scale[0],    // PixelIsArea: tiepoint is the corner
      originY: tie[4] + tie[1] * scale[1] };
  }

  const cogs = new Map(); // url → Promise<cog>
  function open(url){
    if(!cogs.has(url)){
      const p = parse(url);
      p.catch(() => cogs.delete(url));
      cogs.set(url, p);
    }
    return cogs.get(url);
  }

  // ── Tiles ──
  async function inflate(bytes){
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function decodeTile(L, bytes){
    const raw = L.compression === 1 ? bytes.slice() : await inflate(bytes);
    const n = L.tw * L.th;
    if(raw.length < n) throw new Error('tile truncated');
    if(L.predictor === 2){
      for(let y = 0; y < L.th; y++){
        const o = y * L.tw;
        for(let x = 1; x < L.tw; x++) raw[o + x] += raw[o + x - 1];  // Uint8Array wraps mod 256
      }
    }
    return raw.length === n ? raw : raw.subarray(0, n);
  }

  const memTiles = new Map(); // `${url}|${level}|${index}` → Promise<Uint8Array>, LRU order
  function remember(key, p){
    memTiles.set(key, p);
    p.catch(() => { if(memTiles.get(key) === p) memTiles.delete(key); });
    while(memTiles.size > MEM_TILES) memTiles.delete(memTiles.keys().next().value);
  }

  // Load tile indices of one level; resolves to Map index → Uint8Array.
  async function loadTiles(cog, li, indices){
    const L = cog.levels[li];
    const result = new Map();
    const pending = [];
    for(const idx of indices){
      const key = `${cog.url}|${li}|${idx}`;
      if(memTiles.has(key)){
        const p = memTiles.get(key);
        memTiles.delete(key); memTiles.set(key, p);           // refresh LRU position
        result.set(idx, p);
        continue;
      }
      // Register before any await so a concurrent sampler reuses this load.
      let settle;
      const p = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      remember(key, p); result.set(idx, p);
      pending.push({ idx, key, settle, off: L.offsets[idx], len: L.counts[idx] });
    }
    const misses = [];
    await Promise.all(pending.map(async t => {
      if(!t.len){ t.settle.resolve(new Uint8Array(L.tw * L.th)); return; }  // sparse tile: all zero
      const hit = await cacheGet(cog.url, t.off, t.off + t.len);
      if(hit) decodeTile(L, new Uint8Array(hit)).then(t.settle.resolve, t.settle.reject);
      else misses.push(t);
    }));
    misses.sort((a, b) => a.off - b.off);
    const groups = [];
    for(const t of misses){
      const g = groups[groups.length - 1];
      if(g && t.off - g.end <= MERGE_GAP && t.off + t.len - g.start <= MAX_SPAN){
        g.tiles.push(t); g.end = Math.max(g.end, t.off + t.len);
      }else{
        groups.push({ start: t.off, end: t.off + t.len, tiles: [t] });
      }
    }
    for(const g of groups){
      const bytes = fetchRange(cog.url, g.start, g.end);
      for(const t of g.tiles){
        bytes.then(buf => {
          const slice = buf.slice(t.off - g.start, t.off - g.start + t.len);
          cachePut(cog.url, t.off, t.off + t.len, slice.slice(0));
          return decodeTile(L, new Uint8Array(slice));
        }).then(t.settle.resolve, t.settle.reject);
      }
    }
    const out = new Map();
    await Promise.all([...result].map(async ([idx, p]) => out.set(idx, await p)));
    return out;
  }

  const mercX = lng => R * lng * Math.PI / 180;
  const mercY = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

  // Height sampler over a lon/lat bbox. Uses the coarsest level whose ground
  // pixel is no larger than stepM (finer if the budget allows nothing else),
  // and nearest-pixel lookup; the builds' max/RMS levels already keep peaks.
  async function sampler(url, { west, south, east, north }, stepM){
    const cog = await open(url);
    const cosLat = Math.cos((south + north) / 2 * Math.PI / 180);
    const pxRange = L => {
      const c0 = Math.max(0, Math.floor((mercX(west) - cog.originX) / L.resX));
      const c1 = Math.min(L.w - 1, Math.floor((mercX(east) - cog.originX) / L.resX));
      const r0 = Math.max(0, Math.floor((cog.originY - mercY(north)) / L.resY));
      const r1 = Math.min(L.h - 1, Math.floor((cog.originY - mercY(south)) / L.resY));
      return { c0, c1, r0, r1,
        tx0: Math.floor(c0 / L.tw), tx1: Math.floor(c1 / L.tw),
        ty0: Math.floor(r0 / L.th), ty1: Math.floor(r1 / L.th) };
    };
    let li = 0;
    while(li + 1 < cog.levels.length && cog.levels[li + 1].resX * cosLat <= stepM) li++;
    let L = cog.levels[li], box = pxRange(L);
    const count = b => Math.max(0, b.tx1 - b.tx0 + 1) * Math.max(0, b.ty1 - b.ty0 + 1);
    while(count(box) > MAX_TILES && li + 1 < cog.levels.length){
      li++; L = cog.levels[li]; box = pxRange(L);
    }
    const ntx = box.tx1 - box.tx0 + 1;
    const indices = [];
    if(box.c1 >= box.c0 && box.r1 >= box.r0){
      for(let ty = box.ty0; ty <= box.ty1; ty++)
        for(let tx = box.tx0; tx <= box.tx1; tx++) indices.push(ty * L.tilesX + tx);
    }
    const loaded = await loadTiles(cog, li, indices);
    const grid = new Array(indices.length);
    indices.forEach((idx, i) => { grid[i] = loaded.get(idx); });
    const { originX, originY, nodata } = cog;
    return {
      level: li,
      tiles: indices.length,
      resM: L.resX * cosLat,
      heightAt(lat, lng){
        const c = Math.floor((mercX(lng) - originX) / L.resX);
        const r = Math.floor((originY - mercY(lat)) / L.resY);
        if(c < box.c0 || c > box.c1 || r < box.r0 || r > box.r1) return NaN;
        const t = grid[(((r / L.th) | 0) - box.ty0) * ntx + (((c / L.tw) | 0) - box.tx0)];
        if(!t) return NaN;
        const v = t[(r % L.th) * L.tw + (c % L.tw)];
        return v === nodata ? NaN : v;
      }
    };
  }

  root.CanopyCOG = {
    open, sampler,
    configure({ fetch, persistentCache } = {}){
      if(fetch) fetchImpl = fetch;
      if(persistentCache != null){ persistent = !!persistentCache; cachePromise = null; }
    },
    reset(){ cogs.clear(); memTiles.clear(); }
  };
})(globalThis);
