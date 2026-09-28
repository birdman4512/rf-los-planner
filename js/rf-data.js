(function(root){
  'use strict';
  function finite(x,min,max,label){
    if(typeof x!=='number'||!Number.isFinite(x)||x<min||x>max) throw new Error('Invalid '+label);
    return x;
  }
  function name(x){ if(typeof x!=='string'||!x.trim()||x.length>120) throw new Error('Invalid node name'); return x.trim(); }
  function observations(input){
    if(!input || typeof input!=='object') throw new Error('Expected observations JSON');
    const rows=[...(Array.isArray(input)?input:input.observations||[])];
    if(!Array.isArray(input) && input.traces){
      if(!Array.isArray(input.traces)||input.traces.length>1000) throw new Error('Invalid trace list');
      for(const trace of input.traces) for(const key of ['forward','reverse']){
        const hops=trace[key]||[];
        if(!Array.isArray(hops)||hops.length>100) throw new Error('Invalid trace hops');
        for(let i=1;i<hops.length;i++) rows.push({from:hops[i-1].node,to:hops[i].node,
          timestamp:trace.timestamp,modem:trace.modem,frequencyMHz:trace.frequencyMHz,
          success:true,snrDb:hops[i].snrDb,rssiDbm:hops[i].rssiDbm,
          split:trace.split,radio:hops[i].radio,source:'traceroute'});
      }
    }
    if(rows.length>10000) throw new Error('Maximum 10,000 observations');
    const mapping=input.nodeNameMap||{};
    const mapped=x=>name(Object.hasOwn(mapping,x)?mapping[x]:x);
    return rows.map(r=>{
      if(!r || typeof r!=='object') throw new Error('Invalid observation');
      const from=mapped(r.from),to=mapped(r.to);
      if(from===to) throw new Error('Observation must connect different nodes');
      if(typeof r.timestamp!=='string'||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(r.timestamp)||!Number.isFinite(Date.parse(r.timestamp))) throw new Error('Timestamp needs ISO date, time and timezone');
      if(typeof r.success!=='boolean') throw new Error('success must be true or false');
      const result={from,to,timestamp:new Date(r.timestamp).toISOString(),success:r.success,
        modem:r.modem==null||r.modem===''?'':name(r.modem),frequencyMHz:r.frequencyMHz==null?null:finite(r.frequencyMHz,1,100000,'frequency'),
        split:r.split==='calibration'?'calibration':'validation',source:String(r.source||'manual').slice(0,120)};
      for(const [key,min,max] of [['rssiDbm',-200,30],['snrDb',-50,50]]) {
        result[key]=r[key]==null?null:finite(r[key],min,max,key);
        if(!r.success && result[key]!=null) throw new Error('Failed reception must not contain received RSSI/SNR');
      }
      if(r.radio!=null){
        if(typeof r.radio!=='object'||Array.isArray(r.radio))throw new Error('Invalid radio metadata');
        result.radio={};
        const fields={txDbm:[-100,100],txGainDbi:[-100,100],rxGainDbi:[-100,100],txCableDb:[0,100],rxCableDb:[0,100],txHeightM:[0,500],rxHeightM:[0,500],rxSensitivityDbm:[-200,0]};
        for(const [key,[min,max]]of Object.entries(fields))if(r.radio[key]!=null)result.radio[key]=finite(r.radio[key],min,max,key);
        if(r.radio.hardware!=null)result.radio.hardware=String(r.radio.hardware).slice(0,120);
      }
      return result;
    });
  }
  function grid(raw){
    if(!raw || raw.type!=='terrain-grid') throw new Error('Expected a terrain-grid JSON');
    const rows=finite(raw.rows,2,2000,'rows'),cols=finite(raw.cols,2,2000,'cols');
    if(!Number.isInteger(rows)||!Number.isInteger(cols)||rows*cols>1000000) throw new Error('Grid too large');
    const south=finite(raw.south,-85,85,'south'),north=finite(raw.north,-85,85,'north');
    const west=finite(raw.west,-180,180,'west'),east=finite(raw.east,-180,180,'east');
    if(north<=south||east<=west) throw new Error('Invalid grid bounds');
    if(!Array.isArray(raw.elevations)||raw.elevations.length!==rows*cols) throw new Error('Wrong number of elevations');
    const elevations=raw.elevations.map(x=>x===null?null:finite(x,-12000,10000,'elevation'));
    return {type:'terrain-grid',source:name(raw.source),datum:name(raw.datum),date:name(raw.date),rows,cols,south,north,west,east,elevations};
  }
  function gridAt(g,lat,lng){
    if(!g||lat<g.south||lat>g.north||lng<g.west||lng>g.east) return null;
    const x=(lng-g.west)/(g.east-g.west)*(g.cols-1),y=(g.north-lat)/(g.north-g.south)*(g.rows-1);
    const x0=Math.min(g.cols-2,Math.floor(x)),y0=Math.min(g.rows-2,Math.floor(y)),dx=x-x0,dy=y-y0;
    const v=[g.elevations[y0*g.cols+x0],g.elevations[y0*g.cols+x0+1],g.elevations[(y0+1)*g.cols+x0],g.elevations[(y0+1)*g.cols+x0+1]];
    if(v.some(x=>x===null)) return null;
    return v[0]*(1-dx)*(1-dy)+v[1]*dx*(1-dy)+v[2]*(1-dx)*dy+v[3]*dx*dy;
  }
  function metrics(errors){
    return errors.length?{n:errors.length,bias:errors.reduce((a,b)=>a+b,0)/errors.length,mae:errors.reduce((a,b)=>a+Math.abs(b),0)/errors.length}:null;
  }
  root.RFData={observations,grid,gridAt,metrics};
})(globalThis);
