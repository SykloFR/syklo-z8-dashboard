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
el('trMode').value = 'res';   // le stub DOM renvoie '0' par defaut, le select reel 'res'

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
  // one-shot reel : le lancement differe de l'auto-armement en depend
  setTimeout: (fn, ms) => { const id=nextId++; timers.push({fn, period:1e15, next:NOW+(ms||0)+1, id}); return id; },
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
const disp = { state:0, duty:0, dutyMax:229, reason:0, deadman:0, runtime:0 };
function applyToFakeDisplay(f){
  if(f[0]!==25) { OUT.errors.push('OPCODE INTERDIT ECRIT : '+f[0]); return; }
  switch(f[1]){
    case 1: disp.dutyMax = 229; disp.pending = true; break;   // 2.18.7 : 90 % dans les deux contextes
    case 2: if(disp.state){ disp.duty=Math.min(f[2],disp.dutyMax); disp.state=2; disp.deadman=20;
                            if(!disp.runtime) disp.runtime=3000; } break;
    case 3: if(disp.state) disp.deadman=20; break;
    default: disp.state=0; disp.duty=0; disp.deadman=0; disp.runtime=0; break;
  }
}
// confirmation physique (M puis UP)
function armPhysically(){ disp.state=1; disp.duty=0; disp.deadman=20; disp.runtime=0; disp.reason=0; }

// ---- telemetrie simulee : modele grossier duty -> ERPS ------------------
let erps = 0, seq = 0;
function pushTelemetry(){
  // courbe calee sur l'ETALON reel : erps = (duty% - 8) * 3.2 a vide
  // (paliers 25->55, 55->150, 85->246 : dans les tolerances de REF)
  const pct = disp.duty*100/254;
  let target = disp.state===2 ? Math.max(0,(pct-8)*3.2) : 0;
  if(HUMAN.cad>0) target = Math.max(target, HUMAN.cad*2.3);   // pedalage humain
  erps += (target - erps) * 0.35;                          // 1er ordre
  // courant : a vide 1-2 ADC (mesure reel). En charge, deux termes mesures au
  // banc reel : regime permanent ~0.27 ADC/ERPS (B5 75 % -> 56 ADC) + terme
  // d'ACCELERATION du volant (les relances B4 tirent le cap sur l'inertie).
  let cur;
  if(HUMAN.cad>0 || simLvl>0) cur = assistCur();           // mode normal (phase C)
  else cur = disp.state!==2 ? 2
            : (LOADED ? Math.min(143, erps*0.27 + Math.max(0,(target-erps))*2)
                      : Math.min(4, 1+erps*0.01));
  const dv = new DataView(new ArrayBuffer(19));
  dv.setUint8(0,0x04); dv.setUint8(1,seq++ & 0xff);
  dv.setUint16(2,180+HUMAN.delta,true); dv.setUint16(4,HUMAN.delta,true); // torque, delta
  // duty remonte en POUR-CENT, comme le vrai moteur (ebike_app.c octet 15).
  // L'ancienne version remontait la valeur brute 0-254 : le harnais portait la
  // meme fausse hypothese que le dashboard, et le rodage n'a pas vu le bug.
  dv.setUint8(6,HUMAN.cad); dv.setUint8(7,Math.round((disp.state===2?disp.duty:0)*100/254));
  dv.setUint16(8,Math.round(erps),true); dv.setUint8(10,0);
  dv.setUint16(11,Math.round(cur),true); dv.setUint16(13,480,true);
  dv.setUint8(15,0); dv.setUint8(16,1+(seq%6)); dv.setUint16(17,0,true);
  ctx('onNotify')({target:{value:dv}});
}
let LOSS = 0, lossBurst = 0, LOADED = false;   // LOADED : chaine montee (phase B)

/* ---- PHASE C : pedaleur humain + moteur en MODE NORMAL simules ---- */
const HUMAN = { cad:0, delta:0 };
let simLvl = 0;
const AT = [25,45,70,95,170];
function assistCur(){
  if(simLvl<1 || HUMAN.cad<15) return 0;
  return Math.min(143, AT[simLvl-1]*HUMAN.delta*HUMAN.cad/6000);
}
function pushSyklo01(){
  const dv=new DataView(new ArrayBuffer(19));
  dv.setUint8(0,0x01);
  dv.setUint8(16, 1+1);                     // mode torque (+1)
  dv.setUint8(17, simLvl+1);
  dv.setUint8(18, 45+1);
  ctx('onNotify')({target:{value:dv}});
}
function pushSyklo02(){
  const dv=new DataView(new ArrayBuffer(12));
  dv.setUint8(0,0x02);
  dv.setUint8(9, Math.round(assistCur()*0.16*48/10)+1);
  dv.setUint8(10, 0+1);
  dv.setUint8(11, 0+1);
  ctx('onNotify')({target:{value:dv}});
}
function pushBenchState(){
  if(!disp.state && !disp.grace) return;
  if(lossBurst > 0){ lossBurst--; if(disp.state) disp.grace = 10; return; }
  // perte independante + salves courtes (0,6 s), regime plausible d un NUS charge
  if(LOSS && ((seq*7919)%100) < LOSS){ if(((seq*104729)%100) < 15) lossBurst = 3; return; }
  // salves de perte : 1,2 s d'affilee, comme observe sur un NUS sature
  if(lossBurst > 0){ lossBurst--; if(disp.state) disp.grace = 10; return; }
  // perte independante + salves courtes (0,6 s), regime plausible d un NUS charge
  if(LOSS && ((seq*7919)%100) < LOSS){ if(((seq*104729)%100) < 15) lossBurst = 3; return; }
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
    if(NOW % 200 === 0){ pushTelemetry(); pushBenchState(); pushSyklo02(); }
    if(NOW % 2000 === 0){ pushSyklo01(); }
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
console.log('=== 1+2. clic Phase A -> armement automatique -> confirmation -> run ===');
await advance(400);                  // un peu de telemetrie d'abord (garde « connectez »)
ctx("startProto('A')");             // PAS arme : la demande doit partir seule
await advance(600);
console.log('demande d armement partie seule :', ctx('!!bench'));
armPhysically();                     // l'operateur confirme sur le display
await advance(1500);
console.log('phase lancee automatiquement :', !!ctx('proto'));
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
console.log('\n=== 2bis. phase A avec 60% de perte sur les trames 0x06 ===');
LOSS = 60; sandbox.window._lastProto = null;
OUT.steps.length = 0; OUT.alerts.length = 0; advance.last = null;
ctx('benchArm()'); await advance(600); armPhysically(); await advance(1000);
ctx("startProto('A')");
if(OUT.alerts.length) console.log('ALERTES :', OUT.alerts);
guard = 0;
while(ctx('proto') && guard++ < 400) await advance(1000);
const rA2 = sandbox.window._lastProto ? sandbox.window._lastProto.results : [];
console.log('  etapes terminees :', rA2.length, '/ 12');
console.log('  resultat :', rA2.length>=12 ? 'AUCUNE interruption — la seance a tenu' : 'SEANCE COUPEE');
LOSS = 0;

console.log('\n=== 3. phase B (2 blocs) ===');
LOADED = true;
OUT.steps.length = 0; OUT.alerts.length = 0; advance.last = null;
const TB = NOW;
ctx('benchArm()'); await advance(600); armPhysically(); await advance(4000);
ctx("startProto('B')");
if(OUT.alerts.length) console.log('ALERTES :', OUT.alerts);
guard = 0; let rearmed = false;
while(ctx('proto') && guard++ < 400){
  await advance(500);
  const p = ctx('proto');
  // l'operateur appuie sur la pedale pendant B1b (couple en charge)
  if(p && p.curId==='B1b'){
    const ss=p.samples; if(ss.length){ ss[ss.length-1].delta = 240; ss[ss.length-1].cad = 35; }
  }
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

// ==== 4. PHASE C : pedalage humain simule ====
console.log('\n=== 4. phase C — pedalage humain simule ===');
LOADED = false; sandbox.window._lastProto = null; OUT.alerts.length = 0;
simLvl = 0; HUMAN.cad = 0; HUMAN.delta = 0;
await advance(2500);                       // 0x01 doit etre vu (mode torque, niveau 0)
ctx("startProto('C')");
if(OUT.alerts.length) console.log('ALERTES :', OUT.alerts);
guard = 0;
while(ctx('proto') && guard++ < 600){
  await advance(500);
  const p = ctx('proto'); if(!p) break;
  const id = p.curId;
  if(id==='C0'){ HUMAN.cad=0; HUMAN.delta=0; }
  else if(id==='C1a'){ HUMAN.cad=60; HUMAN.delta=35; }
  else if(id==='C1b'){ advance.c1b=(advance.c1b||0)+1;
    HUMAN.cad=20; HUMAN.delta=(advance.c1b%6<3)?160:10; }
  else if(id==='C1c'){ HUMAN.cad=90; HUMAN.delta=18; }
  else if(id==='C1d'){ HUMAN.cad=0; HUMAN.delta=0; }
  else if(id && id.startsWith('C2L')){ simLvl=+id.slice(3); HUMAN.cad=70; HUMAN.delta=40; }
  else if(id==='C3'){ simLvl=3; advance.c3=(advance.c3||0)+1;
    if(advance.c3%20<12){ HUMAN.cad=70; HUMAN.delta=40; } else { HUMAN.cad=0; HUMAN.delta=5; } }
  const ss=p.samples;
  if(ss && ss.length)
    ss[ss.length-1].pmeca = Math.round(HUMAN.delta*HUMAN.cad/18 + assistCur()*0.16*48*0.6);
}
HUMAN.cad=0; HUMAN.delta=0; simLvl=0;
console.log('--- verdicts phase C ---');
(sandbox.window._lastProto ? sandbox.window._lastProto.results : []).forEach(r=>
  console.log(`  ${r.v.padEnd(3)} ${r.id.padEnd(5)} ${r.title.padEnd(40)} ${r.d}`));
console.log('ERREURS :', OUT.errors.length ? OUT.errors.slice(0,4) : 'aucune');

})();
