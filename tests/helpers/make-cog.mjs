// Writes a small COG-shaped GeoTIFF the way scripts/canopy/build-tile.sh's
// gdalwarp output is laid out: uint8, tiled, DEFLATE + horizontal predictor,
// overview IFDs chained after the full-resolution one, EPSG:3857 tiepoint.
import { deflateSync } from 'node:zlib';

const R = 6378137;
export const mercX = lng => R * lng * Math.PI / 180;
export const mercY = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));

// levels: [{ w, h, tile, pixel(c, r) → 0..255 }], finest first.
export function makeCog({ levels, originX, originY, res, predictor = 2, compress = true, bigtiff = false, nodata = null }){
  const tileBlobs = levels.map(L => {
    const out = [];
    for(let ty = 0; ty < Math.ceil(L.h / L.tile); ty++){
      for(let tx = 0; tx < Math.ceil(L.w / L.tile); tx++){
        const t = new Uint8Array(L.tile * L.tile);
        for(let y = 0; y < L.tile; y++){
          for(let x = 0; x < L.tile; x++){
            const c = tx * L.tile + x, r = ty * L.tile + y;
            t[y * L.tile + x] = c < L.w && r < L.h ? L.pixel(c, r) : 0;
          }
        }
        if(predictor === 2){
          for(let y = 0; y < L.tile; y++) for(let x = L.tile - 1; x > 0; x--) t[y * L.tile + x] -= t[y * L.tile + x - 1];
        }
        out.push(compress ? deflateSync(t) : Buffer.from(t));
      }
    }
    return out;
  });
  const SHORT = 3, LONG = 4, DOUBLE = 12, ASCII = 2, LONG8 = 16;
  const ifds = levels.map((L, i) => {
    const n = tileBlobs[i].length;
    const tags = [
      [254, LONG, [i ? 1 : 0]], [256, LONG, [L.w]], [257, LONG, [L.h]], [258, SHORT, [8]],
      [259, SHORT, [compress ? 8 : 1]], [262, SHORT, [1]], [277, SHORT, [1]], [284, SHORT, [1]],
      [317, SHORT, [predictor]], [322, SHORT, [L.tile]], [323, SHORT, [L.tile]],
      [324, bigtiff ? LONG8 : LONG, new Array(n).fill(0)], [325, LONG, tileBlobs[i].map(b => b.length)],
      [339, SHORT, [1]]
    ];
    if(!i){
      tags.push([33550, DOUBLE, [res, res, 0]], [33922, DOUBLE, [0, 0, 0, originX, originY, 0]]);
      if(nodata != null) tags.push([42113, ASCII, `${nodata}\0`]);
    }
    return tags;
  });
  const size = { [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8, [ASCII]: 1, [LONG8]: 8 };
  const es = bigtiff ? 20 : 12, inline = bigtiff ? 8 : 4, cnt = bigtiff ? 8 : 2, nxt = bigtiff ? 8 : 4;
  const head = bigtiff ? 16 : 8;
  let pos = head;
  const ifdPos = ifds.map(t => { const p = pos; pos += cnt + t.length * es + nxt; return p; });
  const extra = ifds.map(t => t.map(([, type, vals]) => {
    const bytes = size[type] * vals.length;
    if(bytes <= inline) return null;
    const p = pos; pos += bytes + (bytes & 1); return p;
  }));
  const dataPos = levels.map((L, i) => tileBlobs[i].map(b => { const p = pos; pos += b.length; return p; }));
  ifds.forEach((t, i) => { t.find(x => x[0] === 324)[2] = dataPos[i]; });
  const buf = Buffer.alloc(pos), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  buf.write('II', 0, 'latin1');
  if(bigtiff){ dv.setUint16(2, 43, true); dv.setUint16(4, 8, true); dv.setBigUint64(8, BigInt(ifdPos[0]), true); }
  else{ dv.setUint16(2, 42, true); dv.setUint32(4, ifdPos[0], true); }
  const put = (o, type, v) => {
    if(type === SHORT) dv.setUint16(o, v, true);
    else if(type === LONG) dv.setUint32(o, v, true);
    else if(type === DOUBLE) dv.setFloat64(o, v, true);
    else if(type === LONG8) dv.setBigUint64(o, BigInt(v), true);
    else dv.setUint8(o, v);
  };
  ifds.forEach((tags, i) => {
    let o = ifdPos[i];
    if(bigtiff){ dv.setBigUint64(o, BigInt(tags.length), true); } else dv.setUint16(o, tags.length, true);
    o += cnt;
    tags.forEach(([tag, type, vals], j) => {
      const arr = typeof vals === 'string' ? [...vals].map(ch => ch.charCodeAt(0)) : vals;
      dv.setUint16(o, tag, true); dv.setUint16(o + 2, type, true);
      if(bigtiff) dv.setBigUint64(o + 4, BigInt(arr.length), true); else dv.setUint32(o + 4, arr.length, true);
      const vo = o + (bigtiff ? 12 : 8);
      const target = extra[i][j] ?? vo;
      if(extra[i][j] != null){ if(bigtiff) dv.setBigUint64(vo, BigInt(target), true); else dv.setUint32(vo, target, true); }
      arr.forEach((v, k) => put(target + k * size[type], type, v));
      o += es;
    });
    const next = i + 1 < ifds.length ? ifdPos[i + 1] : 0;
    if(bigtiff) dv.setBigUint64(o, BigInt(next), true); else dv.setUint32(o, next, true);
  });
  levels.forEach((L, i) => tileBlobs[i].forEach((b, k) => b.copy(buf, dataPos[i][k])));
  return buf;
}

// A fetch that serves `files` (url → Buffer) honouring Range, and logs requests.
export function rangeFetch(files, log = []){
  return async (url, opts = {}) => {
    const body = files[url];
    if(!body) return new Response('', { status: 404 });
    const m = /bytes=(\d+)-(\d+)/.exec((opts.headers || {}).Range || '');
    if(!m) return new Response(body, { status: 200 });
    const s = +m[1], e = Math.min(+m[2], body.length - 1);
    log.push([url, s, e]);
    return new Response(body.subarray(s, e + 1), { status: 206 });
  };
}
