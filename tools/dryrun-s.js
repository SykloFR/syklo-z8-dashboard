/* Rodage a blanc de la PHASE S (mode seance) : display STOCK, trainer FTMS, BMS JBD et
   cycliste simules, temps accelere. Verifie l'enchainement, l'acquisition CUMULEE (le
   cycliste sort de la bande regulierement), la reconnexion BMS et produit un JSONL que
   tools/protoS-report.py doit depouiller (etalonnage + loi retrouves).
   Usage : node tools/dryrun-s.js index.html [sortie.jsonl] [seance|dyn|loi]
   Loi simulée NON linéaire (comme le stock : gain plus faible à forte puissance pédale) :
   P_assist = 3,25 × Gear_assist × 40 × (P_cycliste/40)^0,75, plafonnée à Gear_current × 23 A ;
   le rapport doit retrouver α ≈ 0,75 et la superposition des niveaux une fois divisés par Gear_assist.
   Mode dyn : departs arretes + reprises L1..L5 + coupure en escalier L2 ; moteur simule avec
   coupure street a 26,5 km/h et pic de reengagement (comme vu au banc le 2026-09-24). */
const MODE = process.argv[4] || 'seance';
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync(process.argv[2], 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

let NOW = 1000000;
const timers = []; let nextId = 1;
const els = {};
function el(id){
  if(!els[id]) els[id] = { id, textContent:'', innerHTML:'', value:'0', max:'100', hidden:false, disabled:false,
    className:'', style:{}, classList:{toggle(){}, add(){}, remove(){}}, addEventListener(){}, onclick:null,
    checked:false, nextElementSibling:{textContent:''}, getContext: () => new Proxy({}, {get:()=>()=>{}}), width:1200, height:220 };
  return els[id];
}
el('trMode').value = 'res'; el('trVal').value = '100';
const sandbox = {
  console, document:{ getElementById:el, createElement:()=>({click(){}, set href(v){}, set download(v){}}), addEventListener(){} },
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
const OUT = { alerts:[], confirms:[], errors:[], steps:[] };
vm.createContext(sandbox);
vm.runInContext(script, sandbox, {filename:'dashboard.js'});
const ctx = e => vm.runInContext(e, sandbox);

// ---- banc simule ---------------------------------------------------------
const D = [0, 0.4, 0.55, 0.7, 0.85, 1.4], GC = [0, 0.3, 0.5, 0.6, 0.7, 1.0], ALPHA = 0.75;   // V3.6.5 48 V
function assistOf(P, l){ if(l < 1 || P <= 0) return 0; return Math.min(3.25*D[l]*40*Math.pow(P/40, ALPHA), GC[l]*23*50*0.8); }
function eqRider(pm, l){ let lo = 0, hi = Math.max(pm, 1); for(let i = 0; i < 40; i++){ const m = (lo+hi)/2; if(m + assistOf(m, l) > pm) hi = m; else lo = m; } return lo; }
const G = [0, 1.3, 1.8, 2.3, 2.8, 4.5];          // ordre de grandeur (depart / reprises)
const OFF = 91, KADC = 2.2;                       // torque_ADC = OFF + KADC x T_Nm (a retrouver)
const TR = { res:100, erg:null, grade:null };     // consigne trainer recue en FTMS
sandbox.__ftms = { writeValue: async f => { f=[...f];
  if(f[0]===0x04){ TR.res=f[1]; TR.erg=null; TR.grade=null; } else if(f[0]===0x05){ TR.erg=f[1]|(f[2]<<8); TR.grade=null; }
  else if(f[0]===0x11){ TR.grade=((f[3]|(f[4]<<8))<<16>>16)/100; TR.erg=null; } } };
ctx('ftmsCtrl = __ftms; trainerDev = {}; ftmsResRange = null;');
let lvl = 0, seq = 0, vTarget = 0, spd = 0, noiseT = 0;
const cad = v => v/3.6/2.30*60*14/44;
let cutOn = false, surgeUntil = 0;
function state(){
  const pm = TR.erg!=null ? TR.erg : TR.grade!=null ? spd*(3.5+1.7*TR.grade) : 11*(0.15+0.85*TR.res/100)*spd;
  const prid = eqRider(pm, lvl), w = cad(spd)*2*Math.PI/60;
  const ph = ctx('proto') ? ctx('proto').sph : null;
  const extraT = ph==='go' ? 25 : ph==='push' ? 5 : 0;                  // effort volontaire (N.m)
  const T = (w>0 ? prid/w : 0) + extraT;
  const street = ctx('curStreet') === 1;
  if(street && spd>26.5 && !cutOn) cutOn = true;                        // coupure street franche
  if(cutOn && (spd<25.5 || !street)){ cutOn = false; surgeUntil = NOW+800; }   // reengagement avec pic
  let pas = spd<0.5 && ph!=='go' ? 0 : assistOf(T*Math.max(w,1.5), lvl);
  if(cutOn) pas = 0; else if(NOW<surgeUntil) pas *= 2.2;
  return { pm, prid, pas, T, torque: Math.round(OFF + KADC*T + (Math.random()-0.5)*6), curPh: Math.round(pas/48*1.45/0.2), pbat: pas/0.75 };
}
function push04(){
  const s = state();
  const dv = new DataView(new ArrayBuffer(20));
  dv.setUint8(0,0x04); dv.setUint8(1,seq++&0xff); dv.setUint16(2,s.torque,true);
  dv.setUint16(11,s.curPh,true); dv.setUint16(13,500,true); dv.setUint16(17,Math.round(spd*10),true);
  dv.setUint8(19,0x12);                            // src : stock (2), preset Z8 48V
  ctx('onNotify')({target:{value:dv}});
  ctx('pmeca = '+Math.round(s.pm)+'; trSpd = '+(spd*0.917).toFixed(2)+'; trT = '+NOW);
  if(BMS_ON) ctx(`bms = {v:50.2, i:${(s.pbat/50.2).toFixed(2)}, p:${s.pbat.toFixed(1)}, soc:68, t:${NOW}}`);
}
function push01(){ const dv=new DataView(new ArrayBuffer(19)); dv.setUint8(0,0x01); dv.setUint8(16,1+1); dv.setUint8(17,lvl+1); dv.setUint8(18,25+1); ctx('onNotify')({target:{value:dv}}); }
let STREET = MODE==='seance' ? 1 : 0;              // runs dynamiques / loi : debrides
function push02(){ const dv=new DataView(new ArrayBuffer(12)); dv.setUint8(0,0x02); dv.setUint8(9,1); dv.setUint8(11,((STREET<<4)|(1<<3))+1); ctx('onNotify')({target:{value:dv}}); }
let BMS_ON = true;

// cycliste : suit la consigne avec une derive lente et des sorties de bande (~1 s sur 6)
function human(){
  const p = ctx('proto'); if(!p) return;
  const st = p.steps[p.idx]; if(!st) return;
  if(st.kind==='level'){ if(NOW % 4000 === 0) lvl = st.lvl; vTarget = 12; return; }   // change de niveau apres une pause
  if(st.kind==='plateau') vTarget = st.vT;
  if(st.kind==='sweep'){ STREET = 1; const el=(NOW-p.t0)/1000, i=Math.floor(el/5), S=[22,23,24,25,26,27]; vTarget = i<S.length ? S[i] : 0; }
  if(st.kind==='launch') vTarget = p.sph==='stop' ? 0 : 20 + 4*G[lvl];
  if(st.kind==='push') vTarget = p.sph==='push' ? 16 + 1 + G[lvl] : 16;
}
async function advance(ms){
  for(let t=0;t<ms;t+=100){
    await new Promise(r=>setImmediate(r));
    NOW += 100; noiseT += 0.1;
    human();
    const pp = ctx('proto'), quiet = pp && ['stop','settle','push','rel','go','after'].includes(pp.sph);
    const drift = quiet ? 0.3*Math.sin(noiseT/3) : 0.6*Math.sin(noiseT/3) + ((Math.floor(noiseT)%6===0) ? 2.4 : 0);   // 1 s sur 6 hors bande
    spd += (vTarget + drift - spd)*(pp && pp.sph==='go' ? 0.12 : 0.5); if(spd<0.3 && vTarget===0) spd = 0;
    if(NOW % 200 === 0){ push04(); push02(); }
    if(NOW % 1000 === 0) push01();
    for(const tm of [...timers]) while(tm.next<=NOW){ tm.next+=tm.period; try{ tm.fn(); }catch(e){ OUT.errors.push('TIMER: '+e.message+' @'+(e.stack||'').split('\n')[1]); } }
    const p = ctx('proto'); const cur = p ? p.curId : null;
    if(cur !== advance.last){ advance.last = cur; if(p) OUT.steps.push(((NOW-T0)/1000).toFixed(0)+'s '+cur); }
  }
}
const T0 = NOW;
(async () => {
  ctx("bmsDev = {name:'SIM'}");
  await advance(3000);
  ctx("$('sLoiLvls').value='1,2,3,4,5'; $('sLoiLoads').value='200w,400w,600w'; $('sLoiSpeeds').value='20,28';");
  ctx("$('sMode').value='"+MODE+"'; $('sSpeeds').value='20,14'; $('sErgs').value='40,70,100'; $('sCalSpeeds').value='20'; $('sChainring').value='44'; $('sCog').value='14'; $('sCirc').value='2300'; $('sCut').checked=true;");
  ctx('startProtoS()');
  let guard = 0;
  while(ctx('proto') && guard++ < 3000){
    await advance(1000);
    const p = ctx('proto');
    // BMS muet 8 s pendant le palier L3-v20 : le palier doit sortir en ATTENTION (pbat absent) seulement s'il ne reste rien
    if(p && p.curId==='S-L3-v20' && !advance.cut){ advance.cut = NOW; BMS_ON = false; }
    if(advance.cut && NOW-advance.cut > 8000){ BMS_ON = true; }
  }
  const L = sandbox.window._lastProto;
  console.log('--- enchainement ---'); OUT.steps.forEach(l=>console.log('  '+l));
  console.log('--- verdicts ---');
  (L ? L.results : []).forEach(r=>console.log('  '+String(r.v).padEnd(3)+' '+r.id.padEnd(16)+' '+r.d));
  console.log('duree totale :', ((NOW-T0)/1000/60).toFixed(1), 'min');
  console.log('confirmations :', OUT.confirms.length ? OUT.confirms : 'aucune');
  console.log('alertes :', OUT.alerts.length ? OUT.alerts : 'aucune');
  console.log('ERREURS :', OUT.errors.length ? OUT.errors.slice(0,5) : 'aucune');
  const logArr = ctx('log');
  const stb = logArr.filter(r=>r.stb).length;
  console.log('JSONL : '+logArr.length+' lignes, '+stb+' comptees (stb=1)');
  if(process.argv[3] && L){
    const f = ctx("buildJsonl('banc','protoS-"+MODE+"', window._lastProto)");
    fs.writeFileSync(process.argv[3], f.text);
    console.log('ecrit :', process.argv[3], '('+f.name+')');
  }
  console.log('loi simulee : P_assist = 3,25 x Gear_assist x 40 x (P/40)^'+ALPHA+', plafond Gear_current x 23 A — etalonnage ADC =', OFF, '+', KADC, 'x T');
})();
