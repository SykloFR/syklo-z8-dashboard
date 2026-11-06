/* Rodage a blanc du mode CARACTERISATION L4/L5 : ecran 2.19.4-banc (0x09, opcode 26), moteur STOCK ou OSF,
   Rivo, BMS et cycliste simules, temps accelere. Verifie l'enchainement, l'asservissement de l'ERG sur la
   puissance cycliste, le calcul de PA et la limite de 5 min, puis ecrit un JSONL pour tools/protoS-l45.py.
   Usage : node tools/dryrun-car.js index.html <T0|C47|C62|C79|DEP|REP> [sortie.jsonl] [k] [stock|osf] [lent]
   Modele : manivelle → roue L0 = 0,85 P - 20 W ; plancher Rivo 3,6 W par km/h, retard 2 s ; capteur 2,8 pas/kg
   (stock, sature a +100 pas) ou 3,3 pas/kg (osf) ; couple pulse a 2 x cadence, bruit ±2 pas.
   Loi : PA(roue) = GA x 390 x (P/150)^1,4 ; le rodage verifie que PA est retrouve a quelques % pres.
   « lent » : cycliste hors bande en permanence, pour verifier la limite de 5 min. */
const fs = require('fs'), vm = require('vm');
const [,, htmlF, RUN, OUTF, K_ARG, FW_ARG, LENT] = process.argv;
const K = +K_ARG || 2.8, OSF = FW_ARG === 'osf';
const html = fs.readFileSync(htmlF, 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
let NOW = 1000000;
const timers = []; let nextId = 1;
const els = {};
function el(id){
  if(!els[id]) els[id] = { id, textContent:'', innerHTML:'', value:'0', max:'100', hidden:false, disabled:false,
    className:'', style:{}, classList:{toggle(){}, add(){}, remove(){}}, addEventListener(){}, onclick:null, appendChild(){},
    checked:false, nextElementSibling:{textContent:''}, getContext: () => new Proxy({}, {get:(o,k)=>k==='measureText'?(()=>({width:10})):(()=>{}), set:()=>true}), width:1200, height:220 };
  return els[id];
}
el('trMode').value = 'res'; el('trVal').value = '20'; el('balLimits').value = '{}'; el('balPlan').value = '[]';
const OUT = { alerts:[], confirms:[], errors:[], steps:[], erg:[] };
const sandbox = {
  console, document:{ getElementById:el, createElement:()=>({click(){}, set href(v){}, set download(v){}, innerHTML:''}), addEventListener(){} },
  window:{}, navigator:{ bluetooth:{}, clipboard:{ writeText: async()=>{} }, onLine:false },
  Blob:function(){}, URL:{ createObjectURL:()=>'blob:x' },
  alert: m => OUT.alerts.push(String(m).split('\n')[0]), confirm: m => { OUT.confirms.push(String(m).slice(0,80)); return true; },
  requestAnimationFrame:()=>{}, addEventListener:()=>{},
  setInterval:(fn,period)=>{ const id=nextId++; timers.push({fn,period,next:NOW+period,id}); return id; },
  clearInterval:id=>{ const i=timers.findIndex(t=>t.id===id); if(i>=0) timers.splice(i,1); },
  setTimeout:(fn,ms)=>{ const id=nextId++; timers.push({fn,period:1e15,next:NOW+(ms||0)+1,id}); return id; },
  Date: class extends Date { constructor(...a){ if(!a.length) super(NOW); else super(...a); } static now(){ return NOW; } },
  Uint8Array, DataView, Math, JSON, Set, Map, Promise, isNaN, parseInt, parseFloat,
  indexedDB:{ open:()=>({}) },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(script, sandbox, {filename:'dashboard.js'});
const ctx = e => vm.runInContext(e, sandbox);

// ---- banc simule ---------------------------------------------------------
const GA = [0,0.40,0.55,0.70,0.85,1.40], CRANK = 0.170, ZERO = OSF ? 180 : 90, K_REAL = OSF ? 3.3 : 2.8;
const wheelL0 = P => 0.85*P - 20;                       // manivelle → roue sans assistance
const SET = {4:{P:0,T:0,cap:0}, 5:{P:0,T:0,cap:0}};     // reglages OSF poses par opcode 26
const PAof = (P,l) => { if(l<1) return 0;
  if(OSF){ const c=SET[l]||{P:0,cap:0}; return Math.min(Math.max(P,0)*1.21*c.P/26.8/1.077*0.8, c.cap/1.077*0.8); }   // voie puissance, plafond lu, eta 0,8
  return Math.min(GA[l]*390*Math.pow(Math.max(P,0)/150,1.4), l===5?800:560); };
const TR = { res:20, erg:null, eff:0 };                 // consigne et valeur effective (retard 2 s)
let lvl = 0, seq = 0, spd = 0, vTarget = 0, liveVer = 1, tSim = 0, mass = 0, COG = 17;
const floorW = v => 3.6*v;
sandbox.__ftms = { writeValue: async f => { f=[...f];
  if(f[0]===0x04){ TR.res=f[1]; TR.erg=null; } else if(f[0]===0x05){ TR.erg=(f[1]|(f[2]<<8))<<16>>16; OUT.erg.push(((NOW-T0)/1000).toFixed(0)+'s:'+TR.erg); } } };
let loseP = false, gatt = false;    // comme Web Bluetooth : une ecriture GATT a la fois, les autres sont rejetees
sandbox.__nus = { writeValue: async f => { f=[...f]; if(gatt) throw new Error('GATT operation already in progress'); gatt=true; await new Promise(r=>setImmediate(r)); gatt=false; if(f[0]!==26) return; liveVer++; if(f[1]===3) lvl=f[2]; else if(SET[f[2]]){ if(f[1]===0){ if(process.env.SIM_LOSE_P && f[2]===4 && !loseP){ loseP=true; return; } SET[f[2]].P=f[3]; } if(f[1]===1) SET[f[2]].T=f[3]; if(f[1]===2 && !process.env.SIM_NOCAP) SET[f[2]].cap=f[3]*25; } } };
ctx('ftmsCtrl = __ftms; trainerDev = {}; ftmsResRange = null; nusRx = __nus;');
const cad = v => v/3.6/2.30*60*COG/44;
function pedalOf(pm, l){ let lo=0, hi=2000; for(let i=0;i<50;i++){ const m=(lo+hi)/2; if(wheelL0(m)+PAof(m,l) > pm) hi=m; else lo=m; } return lo; }
let Pc = 0, extraKg = 0;
function state(dt){
  const v = spd, target = TR.erg!=null ? TR.erg : (TR.res/20)*8.4*v;       // resistance 20 % ≈ 170 W a 22-27 km/h
  TR.eff += (Math.max(target, floorW(v)) - TR.eff)*dt/2;
  const pm = v<0.5 ? 0 : TR.eff, want = pm>0 ? pedalOf(pm,lvl) : 0;
  Pc += (want - Pc)*dt/1.5;                                                // le cycliste suit en ~1,5 s
  const w = cad(v)*2*Math.PI/60, Tm = (w>0 ? Pc/w : 0);
  const pulse = 1 + 0.06*Math.sin(2*w*tSim);                       // couple stock deja lisse (ecart-type 2-4 pas au banc)
  const T = Tm*pulse + extraKg*9.81*CRANK + mass*9.81*CRANK;
  let adc = ZERO + K_REAL*T/(9.81*CRANK);
  if(!OSF) adc = Math.min(adc, ZERO+100+0.1*(adc-ZERO-100));              // compression stock
  const pa = v>0.5 || extraKg>0 ? PAof(Pc + extraKg*9.81*CRANK*Math.max(w,1), lvl) : 0;
  return { pm, torque: Math.round(adc + (Math.random()-0.5)*4), pa, pbat: pa/0.75 };
}
function push04(){
  const s = state(0.2);
  const dv = new DataView(new ArrayBuffer(20));
  dv.setUint8(0,0x04); dv.setUint8(1,seq++&0xff); dv.setUint16(2,s.torque,true);
  const iph = s.pbat/48*1.75;
  dv.setUint16(11, Math.round(OSF ? s.pbat/48/0.16 : iph/0.2), true); dv.setUint16(13,480,true); dv.setUint16(17,Math.round(spd*10),true);
  if(OSF){ dv.setUint8(6, Math.round(cad(spd))); dv.setUint16(4, Math.max(0,s.torque-ZERO), true); }
  dv.setUint8(19, OSF ? 0x41 : 0x12);
  ctx('onNotify')({target:{value:dv}});
  ctx('pmeca = '+Math.round(s.pm)+'; trSpd = '+(spd*0.94).toFixed(2)+'; trT = '+NOW+'; trCad = '+(s.pm>0?Math.round(cad(spd)):0));
  ctx(`bms = {v:48, i:${(s.pbat/48).toFixed(2)}, p:${s.pbat.toFixed(1)}, soc:80, t:${NOW}}`);
}
function push02(){ const dv=new DataView(new ArrayBuffer(16)); dv.setUint8(0,0x02); dv.setUint8(9,1); dv.setUint8(11,0+1); ctx('onNotify')({target:{value:dv}}); }
function push09(){ const dv=new DataView(new ArrayBuffer(20)); dv.setUint8(0,0x09); dv.setUint8(1,liveVer&0xff); dv.setUint8(2,lvl); const c=SET[lvl]; if(c){ dv.setUint8(3,c.P); dv.setUint8(4,c.T); dv.setUint8(5,c.cap/25); } dv.setUint8(15,SET[4].cap/25); dv.setUint8(16,SET[5].cap/25); dv.setUint8(18,40); dv.setUint8(17,OSF?4:1); ctx('onNotify')({target:{value:dv}}); }
function human(){
  const p = ctx('proto'); if(!p) return;
  const st = p.steps[p.idx]; if(!st) return;
  mass = 0; extraKg = 0;
  if(st.kind==='zero' || st.kind==='osfset'){ vTarget=0; return; }
  if(st.kind==='static'){ vTarget=0; const D=p.dst; if(D.armed && NOW-p.t0>2000) mass=st.kg; return; }
  if(st.kind==='level'){ vTarget = 12; return; }
  if(st.kind==='plateau') vTarget = LENT ? st.vT+6 : st.vT;
  const DY = ctx('S_DYN');
  if(st.kind==='launch'){ vTarget = p.sph==='stop' ? 0 : DY.launchV+8; if(p.sph==='go'||p.sph==='after') extraKg=25; }
  if(st.kind==='push'){ vTarget = p.sph==='push' ? DY.pushV+6 : DY.pushV; if(p.sph==='push') extraKg=12; }
}
let noiseT = 0;
async function advance(ms){
  for(let t=0;t<ms;t+=100){
    await new Promise(r=>setImmediate(r));
    NOW += 100; noiseT += 0.1; tSim += 0.1;
    human();
    const pp = ctx('proto'), st = pp && pp.steps[pp.idx];
    const drift = st && st.kind==='plateau' ? 0.4*Math.sin(noiseT/3) + ((Math.floor(noiseT)%9===0) ? 1.0 : 0) : 0;
    spd += (vTarget + drift - spd)*(pp && pp.sph==='go' ? 0.06 : 0.25); if(spd<0.3 && vTarget===0) spd = 0;
    if(NOW % 200 === 0){ push04(); push02(); }
    if(NOW % 1000 === 0) push09();
    for(const tm of [...timers]) while(tm.next<=NOW){ tm.next+=tm.period; try{ tm.fn(); }catch(e){ OUT.errors.push('TIMER: '+e.message+' @'+(e.stack||'').split('\n')[1]); } }
    const p = ctx('proto'); const cur = p ? p.curId : null;
    if(cur !== advance.last){ advance.last = cur; if(p) OUT.steps.push(((NOW-T0)/1000).toFixed(0)+'s '+cur); }
  }
}
const T0 = NOW;
(async () => {
  ctx("bmsDev = {name:'SIM'}");
  await advance(3000);
  ctx("$('sMode').value='car'; $('sCarRun').value='"+RUN+"'; $('sCarMasses').value='9,18,70'; $('sCarCrank').value='170'; $('sCarK').value='"+(RUN==='T0'?'':K)+"'; $('sChainring').value='44'; $('sCirc').value='2300'; $('sCarOsf').value='97/72/350,174/129/625';");
  ctx("$('sCog').value='17'");
  ctx('startProtoS()');
  const S = ctx('S_CAR.runs.'+RUN); if(S.cog) COG = S.cog;
  if(process.env.SIM_COG) COG = +process.env.SIM_COG;      // mauvais braquet : alerte attendue
  let guard = 0;
  while(ctx('proto') && guard++ < 900) await advance(1000);
  const L = sandbox.window._lastProto;
  console.log('--- enchainement ---'); OUT.steps.forEach(l=>console.log('  '+l));
  console.log('--- verdicts ---');
  (L ? L.results : []).forEach(r=>console.log('  '+String(r.v).padEnd(3)+' '+String(r.id).padEnd(18)+' '+r.d));
  console.log('duree totale :', ((NOW-T0-3000)/1000/60).toFixed(2), 'min', L&&L.car&&L.car.budget?'(limite 5 min)':'');
  console.log('alertes :', OUT.alerts.length ? OUT.alerts : 'aucune', '| confirmations :', OUT.confirms.length);
  console.log('ERREURS :', OUT.errors.length ? [...new Set(OUT.errors)].slice(0,5) : 'aucune');
  console.log('S_DYN restaure :', ctx('S_DYN.launchV'), '| k saisi :', ctx("$('sCarK').value"));
  const logArr = ctx('log'); console.log('JSONL : '+logArr.length+' lignes, '+logArr.filter(r=>r.stb).length+' comptees');
  const verite = {}; for(const l of [4,5]) for(const P of [100,150]) verite[l+'-'+P] = Math.round(PAof(P,l));
  if(OSF) console.log('reglages recus :', JSON.stringify(SET));
  console.log('verite PA :', JSON.stringify(verite), '| FW0 :', wheelL0(100), wheelL0(150));
  if(OUTF && L){ const f = ctx("buildJsonl('banc','protoS-car-"+RUN+"', window._lastProto)"); fs.writeFileSync(OUTF, f.text); console.log('ecrit :', OUTF, '('+f.name+')'); }
})();
