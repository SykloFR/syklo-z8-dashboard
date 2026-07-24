/* Rodage a blanc du protocole : DOM et BLE simules, temps accelere.
   But = attraper les erreurs d'execution et verifier l'enchainement des etapes
   AVANT de lancer ca sur un vrai moteur. */
const fs = require('fs'), path = require('path'), vm = require('vm');

const html = fs.readFileSync(process.argv[2], 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

// ---- horloge virtuelle -------------------------------------------------
let NOW = 1000000;
const timers = [];   // {fn, period, next, id}
let nextId = 1;

// ---- DOM minimal -------------------------------------------------------
const els = {};
function el(id){
  if(!els[id]) els[id] = {
    id, textContent:'', innerHTML:'', value:'0', max:'100', hidden:false,
    disabled:false, className:'', style:{}, classList:{toggle(){}, add(){}, remove(){}},
    addEventListener(){}, onclick:null,
    getContext: () => new Proxy({}, {get:()=>()=>{}}),
    width:1200, height:220,
  };
  return els[id];
}
// valeurs par defaut des controles lus par le code
el('benchLoad').value = '0';
el('benchRamp').value = '20';
el('benchDuty').value = '0';

const sandbox = {
  console,
  document: {
    getElementById: el,
    createElement: () => ({ click(){}, set href(v){}, set download(v){} }),
    addEventListener(){},
  },
  window: {},
  navigator: { bluetooth: {}, clipboard: { writeText: async()=>{} } },
  Blob: function(){}, URL: { createObjectURL: () => 'blob:x' },
  alert: m => { OUT.alerts.push(String(m).split('\n')[0]); },
  confirm: () => true,
  requestAnimationFrame: () => {},
  addEventListener: () => {},
  setInterval: (fn, period) => { const id=nextId++; timers.push({fn,period,next:NOW+period,id}); return id; },
  clearInterval: id => { const i=timers.findIndex(t=>t.id===id); if(i>=0) timers.splice(i,1); },
  setTimeout: (fn) => nextId++,
  Date: class extends Date { constructor(...a){ if(!a.length) super(NOW); else super(...a); }
                             static now(){ return NOW; } },
  Uint8Array, DataView, Math, JSON, Set, Map, Promise, isNaN, parseInt, parseFloat,
};
sandbox.globalThis = sandbox;
const OUT = { alerts:[], steps:[], sends:[], errors:[] };
const ROT = { start:null, end:null };

vm.createContext(sandbox);
try { vm.runInContext(script, sandbox, {filename:'dashboard.js'}); }
catch(e){ console.error('ERREUR AU CHARGEMENT :', e.message); process.exit(1); }

const ctx = expr => vm.runInContext(expr, sandbox);

// ---- BLE simule : le display accepte et repond -------------------------
sandbox.__fakeRx = {
  writeValueWithoutResponse: async f => { OUT.sends.push([...f]); applyToFakeDisplay([...f]); },
};
ctx('nusRx = __fakeRx;');

// etat du "display" simule
const disp = { state:0, duty:0, dutyMax:152, reason:0, deadman:0, runtime:0 };
function applyToFakeDisplay(f){
  if(f[0]!==25) { OUT.errors.push('OPCODE INTERDIT ECRIT : '+f[0]); return; }
  switch(f[1]){
    case 1: disp.dutyMax = f[2] ? 229 : 152; disp.pending = true; break;
    case 2: if(disp.state){ disp.duty=Math.min(f[2],disp.dutyMax); disp.state=2; disp.deadman=20;
                            if(!disp.runtime) disp.runtime=1200; } break;
    case 3: if(disp.state) disp.deadman=20; break;
    default: disp.state=0; disp.duty=0; disp.deadman=0; disp.runtime=0; break;
  }
}
// confirmation physique (M puis UP)
function armPhysically(){ disp.state=1; disp.duty=0; disp.deadman=20; disp.runtime=0; disp.reason=0; }

// ---- telemetrie simulee : modele grossier duty -> ERPS ------------------
let erps = 0, seq = 0;
function pushTelemetry(){
  const target = disp.state===2 ? disp.duty*1.8 : 0;      // ~275 ERPS a 152
  erps += (target - erps) * 0.35;                          // 1er ordre
  const cur = disp.state===2 ? Math.max(0, erps*0.25) : 2;
  const dv = new DataView(new ArrayBuffer(19));
  dv.setUint8(0,0x04); dv.setUint8(1,seq++ & 0xff);
  dv.setUint16(2,180,true); dv.setUint16(4,5,true);        // torque, delta
  dv.setUint8(6,0); dv.setUint8(7,Math.round(disp.state===2?disp.duty:0));
  dv.setUint16(8,Math.round(erps),true); dv.setUint8(10,0);
  dv.setUint16(11,Math.round(cur),true); dv.setUint16(13,480,true);
  dv.setUint8(15,0); dv.setUint8(16,1+(seq%6)); dv.setUint16(17,0,true);
  ctx('onNotify')({target:{value:dv}});
}
function pushBenchState(){
  if(!disp.state && !disp.grace) return;
  if(disp.state) disp.grace = 10; else disp.grace--;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setUint8(0,0x06); dv.setUint8(1,disp.state); dv.setUint8(2,disp.duty);
  dv.setUint8(3,disp.dutyMax); dv.setUint8(4,disp.reason); dv.setUint8(5,disp.deadman);
  dv.setUint16(6,disp.runtime,true);
  ctx('onNotify')({target:{value:dv}});
}
// dead-man + timeout cote display
function displayTick100(){
  if(!disp.state) return;
  if(disp.deadman && --disp.deadman===0){ disp.reason=2; disp.state=0; disp.duty=0; disp.runtime=0; return; }
  if(disp.state===2 && disp.runtime && --disp.runtime===0){ disp.reason=3; disp.state=0; disp.duty=0; }
}

// ---- boucle : avance le temps par pas de 100 ms -------------------------
async function advance(ms){
  for(let t=0; t<ms; t+=100){
    await new Promise(r=>setImmediate(r));
    NOW += 100;
    displayTick100();
    if(NOW % 200 === 0){ pushTelemetry(); pushBenchState(); }
    for(const tm of [...timers]) while(tm.next <= NOW){ tm.next += tm.period;
      try{ tm.fn(); }catch(e){ OUT.errors.push('TIMER: '+e.message+' @'+e.stack.split('\n')[1]); } }
    const p = ctx('proto');
    const cur = p ? p.curId+'/'+p.state : null;
    if(disp.duty>0){ if(ROT.start==null) ROT.start=NOW; ROT.end=NOW; }
    if(cur !== advance.last){ advance.last = cur;
      if(p) OUT.steps.push(`${((NOW-T0)/1000).toFixed(1)}s  ${p.curId}  ${p.state}  duty_display=${disp.duty}  erps=${Math.round(erps)}`); }
  }
}

// ---- scenario ----------------------------------------------------------
const T0 = NOW;
(async () => {
console.log('=== 1. armement ===');
ctx('benchArm()');
await advance(600);
armPhysically();                       // l'operateur confirme sur le display
await advance(1000);
console.log('bench.engagedSeen =', ctx('bench && bench.engagedSeen'));

console.log('\n=== 2. phase A complete ===');
ctx("startProto('A')");
if(OUT.alerts.length) console.log('ALERTES :', OUT.alerts);
let guard = 0;
while(ctx('proto') && guard++ < 400){
  await advance(1000);
  // l'operateur "pedale a la main" pendant l'etape manuelle A2
  if(ctx('proto') && ctx('proto').curId==='A2'){
    const s = ctx('proto').samples; if(s.length) { s[s.length-1].cad = 40; s[s.length-1].delta = 30; }
  }
}
console.log('\n--- enchainement ---');
OUT.steps.forEach(l=>console.log('  '+l));
console.log('\n--- verdicts ---');
(sandbox.window._lastProto ? sandbox.window._lastProto.results : []).forEach(r=>
  console.log(`  ${r.v.padEnd(3)} ${r.id.padEnd(4)} ${r.title.padEnd(28)} ${r.d}`));
console.log('\nduree totale :', ((NOW-T0)/1000).toFixed(0), 's');
console.log('ROTATION CONTINUE (budget display 120 s) :', ROT.start?((ROT.end-ROT.start)/1000).toFixed(0)+' s':'—');
console.log('ecritures BLE :', OUT.sends.length, '- opcodes distincts :',
            [...new Set(OUT.sends.map(x=>x[0]))]);
console.log('ERREURS :', OUT.errors.length ? OUT.errors : 'aucune');

// ---- 3. phase B : deux blocs, rearmement au milieu ---------------------
console.log('\n=== 3. phase B (2 blocs) ===');
OUT.steps.length = 0; OUT.alerts.length = 0; advance.last = null;
const TB = NOW;
ctx('benchArm()'); await advance(600); armPhysically(); await advance(1000);
ctx("startProto('B')");
if(OUT.alerts.length) console.log('ALERTES :', OUT.alerts);
guard = 0; let rearmed = false;
while(ctx('proto') && guard++ < 400){
  await advance(500);
  const p = ctx('proto');
  // l'operateur rearme physiquement quand le protocole le demande
  if(p && p.state==='waiting' && guard%6===0)
    console.log('   [diag]', ((NOW-TB)/1000).toFixed(0)+'s', 'disp.state='+disp.state,
                'bench='+(ctx('bench')?'obj engagedSeen='+ctx('bench').engagedSeen:'null'),
                'ack='+(ctx('benchAck')?ctx('benchAck').state:'null'));
  // L'operateur reessaie tant que l'ecran de confirmation est la (comportement
  // reel : il voit « MODE BANC / M = oui » et appuie).
  if(p && p.state==='waiting' && !disp.state && guard%8===0){ armPhysically();
    console.log('  [operateur] confirmation physique a', ((NOW-TB)/1000).toFixed(0), 's'); }
}
console.log('\n--- enchainement ---');
OUT.steps.forEach(l=>console.log('  '+l));
console.log('\n--- verdicts ---');
(sandbox.window._lastProto ? sandbox.window._lastProto.results : []).forEach(r=>
  console.log(`  ${r.v.padEnd(3)} ${r.id.padEnd(4)} ${r.title.padEnd(26)} ${r.d}`));
console.log('\nduree phase B :', ((NOW-TB)/1000).toFixed(0), 's');
console.log('ERREURS :', OUT.errors.length ? OUT.errors : 'aucune');
})();
