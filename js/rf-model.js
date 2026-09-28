/* Pure RF model, shared by profiles, coverage workers and numerical tests.
 * Distances/heights are metres, frequency MHz, powers dBm and losses dB.
 * Bullington: ITU-R P.526-15 section 4.5.1, equations 50–57.
 * This is the Bullington component, not the complete delta-Bullington method.
 */
(function (root) {
  'use strict';
  const EARTH = 6371000;
  // Within this distance of either end, a clutter sample flagged as a guess
  // (flat class height standing in for unmeasured trees) is treated as unknown
  // rather than as a wall beside the antenna.
  const GUESS_END_M = 100;
  const MODEMS = {
    ShortTurbo:{bw:500,snr:-7.5}, ShortFast:{bw:250,snr:-7.5},
    ShortSlow:{bw:250,snr:-10}, MediumFast:{bw:250,snr:-12.5},
    MediumSlow:{bw:250,snr:-15}, LongTurbo:{bw:500,snr:-17.5},
    LongFast:{bw:250,snr:-17.5}, LongModerate:{bw:125,snr:-17.5}, LongSlow:{bw:125,snr:-20}
  };
  function knife(nu) {
    return nu <= -0.78 ? 0 : Math.max(0, 6.9 + 20 * Math.log10(Math.hypot(nu - .1, 1) + nu - .1));
  }
  function fspl(d, f) { return 32.44 + 20 * Math.log10(Math.max(d, 1) / 1000) + 20 * Math.log10(f); }
  function fresnel(d1, d2, f) { return Math.sqrt(299792458 / (f * 1e6) * d1 * d2 / (d1 + d2)); }
  function noiseFloor(radio) {
    if(Number.isFinite(radio.noiseDbm)) return radio.noiseDbm;
    const m = MODEMS[radio.modem];
    return m ? -174 + 10 * Math.log10(m.bw * 1000) + (radio.nf ?? 6) : null;
  }
  function sensitivity(modem, nf = 6) {
    const m = MODEMS[modem];
    return m ? -174 + 10 * Math.log10(m.bw * 1000) + nf + m.snr : null;
  }
  function budget(a, b, pathLossDb) {
    function direction(tx, rx) {
      const prxDbm = tx.tx + tx.gain + rx.gain - (tx.cable ?? 0) - (rx.cable ?? 0) - pathLossDb;
      const noise = noiseFloor(rx);
      return {prxDbm, marginDb:prxDbm - rx.rx, snrDb:noise == null ? null : prxDbm - noise,
        noiseDbm:noise, noiseMeasured:Number.isFinite(rx.noiseDbm)};
    }
    const ab = direction(a,b), ba = direction(b,a);
    const weakest = ab.marginDb <= ba.marginDb ? ab : ba;
    const compatible=!(a.modem && b.modem && a.modem!==b.modem);
    return {ab,ba,compatible,marginDb:compatible?weakest.marginDb:-Infinity,prxDbm:weakest.prxDbm,snrDb:weakest.snrDb};
  }
  function status(margin, required) { return margin < 0 ? 'blocked' : margin < required ? 'marginal' : 'clear'; }
  function terminalLoss(h, R, f) {
    if(h >= R) return 0;
    if(f < 30 || f > 3000) return null; // no silent extrapolation
    const dh = R-h, theta = Math.atan(dh / 27) * 180 / Math.PI;
    return Math.max(0, knife(.342 * Math.sqrt(f/1000 * dh * theta)) - 6.03);
  }
  function representative(clutter, dists, end, reverse, clear = 0, guess = null) {
    const values = [];
    for(let k=0;k<=end;k++) {
      const i = reverse ? end-k : k, d = reverse ? dists[end]-dists[i] : dists[i];
      if(d > 100) break;
      values.push(d < clear || guess?.[i] ? 0 : (clutter?.[i] || 0));
    }
    values.sort((a,b)=>a-b);
    return values[Math.min(values.length-1,Math.floor(values.length*.8))] || 0;
  }
  function solve(p) {
    const {dists,elevs,freq,K=4/3,antA=2,antB=2,clutter=null,guess=null,clearA=0,clearB=0,
      mode='bullington',clutterMode='geometry',atten=.1,cap=45,fresnelPct=.6,
      terrainOffset=0,clutterOffset=0} = p;
    const n=p.end ?? dists.length-1, D=dists[n];
    if(n<1 || !(D>0) || !(freq>0) || !(K>0)) throw new Error('Invalid propagation profile');
    const groundA=p.groundA ?? elevs[0], groundB=p.groundB ?? elevs[n];
    const physicalA=groundA+antA, physicalB=groundB+antB;
    let a=physicalA, b=physicalB, termLossDb=0;
    const warnings=[];
    let RA=0,RB=0;
    if(clutter && clutterMode==='terminal') {
      RA=representative(clutter,dists,n,false,clearA,guess);
      RB=representative(clutter,dists,n,true,clearB,guess);
      if(freq<30 || freq>3000) { warnings.push('Terminal correction outside 30–3000 MHz; geometric clutter used.'); RA=RB=0; }
      else {
        termLossDb=terminalLoss(antA,RA,freq)+terminalLoss(antB,RB,freq);
        a=groundA+Math.max(antA,RA); b=groundB+Math.max(antB,RB);
        warnings.push('Terminal clutter uses an estimated representative height; verify locally.');
      }
    }
    let maxNu=-Infinity, slopeA=-Infinity,slopeB=-Infinity;
    let minBareLosClear=Infinity,minLosClear=Infinity,minFzClear=Infinity,minScaledFzClear=Infinity;
    let clutterLossDb=0, maxSpacing=0;
    for(let i=1;i<=n;i++) maxSpacing=Math.max(maxSpacing,dists[i]-dists[i-1]);
    for(let i=1;i<n;i++) {
      const x=dists[i], y=D-x, bulge=x*y/(2*K*EARTH);
      const ground=elevs[i]+terrainOffset+bulge;
      const unknown=guess?.[i] && (x<=GUESS_END_M || y<=GUESS_END_M);
      const raw=unknown?0:Math.max(0,(clutter?.[i]||0)+(clutter?.[i]>0?clutterOffset:0));
      const cleared=x<clearA || y<clearB;
      const h=cleared?0:raw;
      const physical=physicalA+(physicalB-physicalA)*x/D;
      const fz=fresnel(x,y,freq);
      minBareLosClear=Math.min(minBareLosClear,physical-ground);
      minLosClear=Math.min(minLosClear,physical-ground-h);
      minFzClear=Math.min(minFzClear,physical-ground-h-fz);
      minScaledFzClear=Math.min(minScaledFzClear,physical-ground-h-fresnelPct*fz);
      // P.2108 terminal correction replaces local geometric clutter only;
      // path propagation is calculated to/from representative clutter height.
      const terminalZone=(RA>antA && x<=100)||(RB>antB && y<=100);
      const effectiveH=terminalZone?0:h;
      const top=ground+effectiveH, ray=a+(b-a)*x/D;
      maxNu=Math.max(maxNu,Math.SQRT2*(top-ray)/fz);
      slopeA=Math.max(slopeA,(top-a)/x);
      slopeB=Math.max(slopeB,(top-b)/y);
      if(effectiveH>0 && ray>ground && ray<top) {
        const cell=(dists[i+1]-dists[i-1])/2;
        clutterLossDb+=cell*atten*Math.sqrt(freq/915)*Math.max(.15,Math.min(1,(top-ray)/effectiveH));
      }
    }
    clutterLossDb=Math.min(cap,clutterLossDb);
    let diffLossDb=knife(maxNu);
    if(mode==='bullington' && n>1) {
      let nu=maxNu;
      if(slopeA>=(b-a)/D) {
        const db=(b-a+slopeB*D)/(slopeA+slopeB);
        if(db>0 && db<D) nu=Math.SQRT2*(a+slopeA*db-(a+(b-a)*db/D))/fresnel(db,D-db,freq);
      }
      const luc=knife(nu);
      diffLossDb=luc+(1-Math.exp(-luc/6))*(10+.02*D/1000);
    }
    const nlos=minBareLosClear<=0, surfaceBlocked=minLosClear<=0;
    const excluded=mode==='los' && surfaceBlocked;
    const excessLossDb=diffLossDb+clutterLossDb+termLossDb;
    return {dist:D,minBareLosClear,minLosClear,minFzClear,minScaledFzClear,fresnelPct,nlos,surfaceBlocked,
      geometry:surfaceBlocked?'obstructed':minScaledFzClear<0?'fresnel':'clear',
      diffLossDb,clutterLossDb,termLossDb,excessLossDb,pathLossDb:excluded?Infinity:fspl(D,freq)+excessLossDb,
      model:mode,maxSpacing,samples:n+1,warnings,maxNu};
  }
  // Used unchanged by the coverage worker and tests. Both endpoints use the
  // same solve() and budget() calls as an individual link.
  function coverageRay(p,a,b,requiredMargin=6) {
    const margins=[Infinity];
    for(let end=1;end<p.dists.length;end++) {
      const r=solve({...p,end,antA:a.antH,antB:b.antH,clearA:a.clearM||0,clearB:b.clearM||0,groundA:a.ground});
      margins.push(budget(a,b,r.pathLossDb).marginDb-requiredMargin);
    }
    return margins;
  }
  function refineSector(a,b,radius,targetM=250) {
    const angle=(b.az-a.az+360)%360;
    if(radius*angle*Math.PI/180>targetM) return true;
    for(let i=1;i<Math.min(a.samples.length,b.samples.length);i+=Math.max(1,Math.floor(a.samples.length/40))) {
      const x=a.samples[i].marginDb,y=b.samples[i].marginDb;
      if((x>=0)!==(y>=0) || (Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)>6)) return true;
    }
    return false;
  }
  root.RFModel={MODEMS,knife,fspl,fresnel,noiseFloor,sensitivity,budget,status,terminalLoss,solve,coverageRay,refineSector};
})(globalThis);
