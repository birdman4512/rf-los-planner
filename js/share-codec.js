// ─────────────────────────────────────────────────────────────────────────
//  ClearPath share-codec — single source of the v4 share-hash format.
//
//  Loaded (after lz-string) by both the app (index.html) and the Repeater
//  Finder (repeaters.html). The Finder builds a state object and calls
//  encode() to produce a deep-link that opens the map with those nodes.
//
//  Compact v4 schema: short keys + array-indexed refs, then LZ-string compress.
//  The decoder lives in app.js (parseSharedHash) and reads by key, so field
//  order here is irrelevant — only the keys and value types must match.
// ─────────────────────────────────────────────────────────────────────────
(function (global) {
  'use strict';

  // Transform a semantic state object into the compact v4 payload.
  // state = {
  //   rf: { f,k,tx,gn,rx,mg,ra,cr,cs,cf,cm,co,cy,fh,uh,xe,ca,cc },
  //   nodes: [{ lat,lng,antH,name, rfOverride?,txDbm?,gainDbi?,rxDbm?,coverageOn?,color? }],
  //   edges: [{ a,b,hidden? }],   // a,b are node indices
  //   paths: [{ name,hidden?,nodeIdx:[...] }]
  // }
  function buildPayload(state) {
    const rf = state.rf || {};
    const nodes = state.nodes || [];
    const edges = state.edges || [];
    const paths = state.paths || [];
    return {
      v: 4,
      f: +rf.f, k: rf.k, tx: +rf.tx, gn: +rf.gn, rx: +rf.rx, mg: +rf.mg,
      ra: +rf.ra, cr: +rf.cr, cs: +rf.cs, cf: +rf.cf, cm: +rf.cm, co: rf.co ? 1 : 0,
      cy: rf.cy ? 1 : 0,
      fh: +rf.fh, uh: +rf.uh, xe: +rf.xe, ca: +rf.ca, cc: +rf.cc,
      // node: [lat, lng, antH, name, rfOverride?, tx?, gain?, rx?, coverageOn?, color?]
      n: nodes.map(nd => {
        const base = [+(+nd.lat).toFixed(6), +(+nd.lng).toFixed(6), nd.antH, nd.name];
        if (nd.rfOverride || nd.coverageOn || nd.color) {
          base.push(nd.rfOverride ? 1 : 0, nd.txDbm ?? null, nd.gainDbi ?? null,
                    nd.rxDbm ?? null, nd.coverageOn ? 1 : 0, nd.color || 0);
        }
        return base;
      }),
      e: edges.map(e => [e.a, e.b, e.hidden ? 1 : 0]),
      p: paths.map(p => [p.name, p.hidden ? 1 : 0, ...(p.nodeIdx || [])])
    };
  }

  function encode(state) {
    return 'v4:' + LZString.compressToEncodedURIComponent(JSON.stringify(buildPayload(state)));
  }

  global.CPShareCodec = { buildPayload, encode };
})(typeof window !== 'undefined' ? window : this);
