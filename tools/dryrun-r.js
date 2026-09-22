/* Rodage à blanc RD45 (2026-09-21) : decodeF46, reconstruction du temps et phase R.
   Charge index.html dans un bac à sable (DOM/BLE factices, horloge virtuelle — même
   principe que dryrun.js) puis :
     1. decodeF46 sur un JSONL réel (3 premières lignes, une ligne > 30 km/h, le max) ;
     2. rejeu du même JSONL avec ses temps de réception réels → vérifie que les rafales
        (Chrome Android en arrière-plan) sont reconstruites sur seq (tr = 1), monotones,
        ré-ancrées sur la fin de rafale, et que l'avertissement est levé ;
     3. phase R complète sur un moteur RD45 SIMULÉ nominal, en patch v3 puis v4 :
        aucune erreur d'exécution, enchaînement des 11 étapes, verdicts attendus OK / n/a.
   Usage : node tools/dryrun-r.js index.html [run-route.jsonl] */
const fs = require('fs'), vm = require('vm');

const html = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const jsonlPath = process.argv[3];

// ---- horloge virtuelle + minuteries ------------------------------------
let NOW = 1700000000000;
const timers = []; let nextId = 1;

// ---- DOM minimal --------------------------------------------------------
const els = {};
function el(id){
  if(!els[id]) els[id] = { id, textContent:'', innerHTML:'', value:'', max:'100', hidden:false, disabled:false, className:'', style:{},
    classList:{ toggle(){}, add(){}, remove(){} }, addEventListener(){}, onclick:null,
    getContext: () => new Proxy({}, { get: () => () => {} }), width:1200, height:220,
    get nextElementSibling(){ return el(id + '/next'); } };   // renderSrc() écrit dans le voisin de vCur
  return els[id];
}
el('trMode').value = 'res'; el('rCad').value = '60';
const sandbox = {
  console,
  document: { getElementById: el, createElement: () => ({ click(){}, set href(v){}, set download(v){} }), addEventListener(){}, visibilityState:'visible' },
  window: {}, navigator: { bluetooth: {}, clipboard: { writeText: async () => {} } },
  Blob: function(){}, URL: { createObjectURL: () => 'blob:x' },
  alert: m => { OUT.alerts.push(String(m).split('\n')[0]); }, confirm: () => true,
  requestAnimationFrame: () => {}, addEventListener: () => {},
  setInterval: (fn, period) => { const id = nextId++; timers.push({ fn, period, next: NOW + period, id }); return id; },
  clearInterval: id => { const i = timers.findIndex(t => t.id === id); if(i >= 0) timers.splice(i, 1); },
  setTimeout: (fn, ms) => { const id = nextId++; timers.push({ fn, period: 1e15, next: NOW + (ms || 0) + 1, id }); return id; },
  Date: class extends Date { constructor(...a){ if(!a.length) super(NOW); else super(...a); } static now(){ return NOW; } },
  Uint8Array, DataView, ArrayBuffer, Math, JSON, Set, Map, Promise, isNaN, parseInt, parseFloat, Intl, String, Number, Object, Array, Error,
  indexedDB: { open: () => ({}) },
};
sandbox.globalThis = sandbox;
const OUT = { alerts: [], errors: [] };
vm.createContext(sandbox);
try { vm.runInContext(script, sandbox, { filename: 'dashboard.js' }); }
catch(e){ console.error('ERREUR AU CHARGEMENT :', e.message); process.exit(1); }
const ctx = expr => vm.runInContext(expr, sandbox);
let fails = 0;
function check(cond, label){ console.log('  ' + (cond ? 'ok ' : 'KO ') + label); if(!cond) fails++; }

// ---- paquets BLE factices ------------------------------------------------
function pkt04(seq, r){   // r = ligne JSONL stock (tickRaw, frOk, ckErr, spdRawX10, commErr surchargent delta/cad/duty/erps/foc)
  const dv = new DataView(new ArrayBuffer(20));
  dv.setUint8(0, 4); dv.setUint8(1, seq & 255); dv.setUint16(2, r.torque, true); dv.setUint16(4, r.tickRaw, true);
  dv.setUint8(6, r.frOk & 255); dv.setUint8(7, r.ckErr & 255); dv.setUint16(8, r.spdRawX10, true); dv.setUint8(10, r.commErr & 255);
  dv.setUint16(11, r.cur, true); dv.setUint16(13, r.voltX10, true); dv.setUint8(15, r.err); dv.setUint8(16, 0);
  dv.setUint16(17, r.spdX10, true); dv.setUint8(19, r.src);
  return dv;
}
function pkt08(seq, bytes, age, n){
  const dv = new DataView(new ArrayBuffer(20));
  dv.setUint8(0, 8); dv.setUint8(1, seq & 255); bytes.forEach((b, i) => dv.setUint8(2 + i, b));
  dv.setUint8(17, age); dv.setUint8(18, n & 255); dv.setUint8(19, 15);
  return dv;
}
const notify = dv => ctx('onNotify')({ target: { value: dv } });
function pkt01(lvl){ const dv = new DataView(new ArrayBuffer(19)); dv.setUint8(0, 1); dv.setUint8(16, 4 + 1); dv.setUint8(17, lvl + 1); dv.setUint8(18, 26); return dv; }

// =========================================================================
// 1 + 2. JSONL réel : decodeF46 et reconstruction du temps
// =========================================================================
if(jsonlPath){
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const rows = lines.filter(o => !o.meta);
  console.log('=== 1. decodeF46 sur ' + jsonlPath.replace(/^.*[\\/]/, '') + ' (' + rows.length + ' lignes) ===');
  const dec = hex => ctx('decodeF46')(ctx('f46HexBytes')(hex));
  const probe = [...rows.slice(0, 3), rows.find(r => r.spdX10 > 300), rows.reduce((a, b) => b.spdX10 > a.spdX10 ? b : a)];
  for(const r of probe){
    const f = dec(r.f46);
    const kmhP = f.p < 4500 ? (ctx('RD45_K_P') / f.p) : 0;
    console.log('  seq ' + r.seq + '  spd ' + (r.spdX10/10).toFixed(1) + ' km/h  tickRaw ' + r.tickRaw + '  → ' + JSON.stringify(f));
    check(f.ver === 3 && f.fix === 1, '    r_ver = 3, r_fix = 1');
    check(f.ok, '    somme de contrôle OK');
    // est et tickRaw viennent de deux trames (0x46 relayée à 2 Hz, 0x43 à 5 Hz) : ±1 tick de décalage temporel
    check(Math.abs(f.est - r.tickRaw) <= 1, '    r_est = tickRaw ± 1 (' + f.est + ' / ' + r.tickRaw + ')');
    if(r.spdX10 === 0) check(f.p === 4500, '    à l’arrêt p = 4500');
    else { const kmhEst = ctx('RD45_K_EST') / f.est;
      check(Math.abs(kmhP/kmhEst - 1) <= 0.02, '    4293/p = ' + kmhP.toFixed(1) + ' ≈ 3960/est = ' + kmhEst.toFixed(1) + ' km/h (±2 %)');
      // le display applique SA circonférence (≈ 2,12 m sur ce vélo) : rapport constant, pas égalité
      check(Math.abs((r.spdX10/10)/kmhEst - 0.965) <= 0.03, '    display ' + (r.spdX10/10).toFixed(1) + ' = ' + ((r.spdX10/10)/kmhEst).toFixed(3) + ' × (3960/est) — circonférence display ≈ 2,12 m'); }
  }

  console.log('\n=== 2. reconstruction du temps (rejeu avec les temps de réception réels) ===');
  ctx('motorSrc = null; lastSeq = null; log = []; recording = true;');
  let n8 = null, seq8 = 0; const t0 = rows[0].t; NOW = t0 - 1000;
  for(const tm of timers) tm.next = NOW + tm.period;
  for(const r of rows){
    NOW = r.t;
    if(r.f46 && r.f46n !== n8){ n8 = r.f46n; notify(pkt08(seq8++, ctx('f46HexBytes')(r.f46), r.f46age, r.f46n)); }
    notify(pkt04(r.seq, r));
    for(const tm of [...timers]) while(tm.next <= NOW){ tm.next += tm.period; try { tm.fn(); } catch(e){ OUT.errors.push('TIMER: ' + e.message); } }
  }
  ctx('recording = false;');
  const built = ctx('buildJsonl')('route', null, null);
  const out = built.text.split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(o => !o.meta);
  let mono = true, tr = 0, maxBack = 0; let firstTr = -1;
  for(let i = 1; i < out.length; i++){ if(out[i].t < out[i-1].t){ mono = false; maxBack = Math.max(maxBack, out[i-1].t - out[i].t); } }
  out.forEach((o, i) => { if(o.tr){ tr++; if(firstTr < 0) firstTr = i; } });
  // gigue du flux régulier avant le trou : combien de Δt < 50 ms ? (une rafale de gigue < 5 lignes est rendue à ses temps de réception)
  const gi = rows.findIndex((r, i) => i && r.t - rows[i-1].t > 100000);
  const live = rows.slice(1, gi).map((r, i) => r.t - rows[i].t);
  console.log('  flux régulier avant le trou : ' + live.length + ' Δt, dont ' + live.filter(d => d < 50).length + ' < 50 ms, médiane ' + live.sort((a, b) => a - b)[live.length >> 1] + ' ms');
  const gapIn = rows.reduce((m, r, i) => i && r.t - rows[i-1].t > m.g ? { g: r.t - rows[i-1].t, i } : m, { g: 0, i: 0 });
  console.log('  trou brut max : ' + (gapIn.g/1000).toFixed(0) + ' s avant la ligne ' + gapIn.i + ' · lignes tr=1 : ' + tr + ' (première : ' + firstTr + ')');
  console.log('  ligne ' + (gapIn.i-1) + ' t=' + out[gapIn.i-1].t + ' · ligne ' + gapIn.i + ' t reconstruit=' + out[gapIn.i].t + ' (Δ ' + ((out[gapIn.i].t - out[gapIn.i-1].t)/1000).toFixed(1) + ' s) ta=' + out[gapIn.i].ta);
  console.log('  dernière ligne de rafale : t=' + out[out.length-1].t + ' ta=' + (out[out.length-1].ta ?? '–') + ' · avertissement : « ' + ctx('recWarnTxt')().trim() + ' »');
  check(mono, '  t monotone (recul max ' + maxBack + ' ms)');
  check(tr > 1500, '  la rafale est marquée tr = 1 (' + tr + ' lignes)');
  check(out[gapIn.i].tr === 1 && out[gapIn.i].ta > out[gapIn.i].t, '  la première ligne de la rafale (celle qui portait le trou) est rattachée et ré-ancrée');
  check(out.every(o => !o.tr || o.ta != null) && out.every(o => o.tr || o.ta == null), '  ta présent si et seulement si tr = 1');
  check(ctx('recTs').warnS > 5, '  avertissement rafale > 5 s levé (' + ctx('recTs').warnS.toFixed(0) + ' s)');
  check(out[0].r_ver === 3 && out[0].r_est === rows[0].tickRaw && out[0].r_p === 4500, '  champs r_* présents (r_ver 3, r_p 4500, r_est = tickRaw)');
  check(!('gpsX10' in out[0]), '  pas de champ GPS sans géolocalisation');
  console.log('  ERREURS : ' + (OUT.errors.length ? OUT.errors.slice(0, 3).join(' | ') : 'aucune'));
}

// =========================================================================
// 3. phase R sur un RD45 simulé (patch v3 puis v4)
// =========================================================================
function sumck(b){ let s = 0; for(let i = 0; i < 14; i++) s += b[i]; b[14] = s & 255; return b; }
function f46v3(o){ const b = new Array(15).fill(0); b[0] = 0x46;
  const raw = o.p & 0x7fff; b[1] = raw & 255; b[2] = raw >> 8; b[3] = o.est & 255; b[4] = o.est >> 8; b[5] = 0x83;
  b[6] = ((o.spread >> 3) << 4) | (o.nbad & 15); b[7] = o.stockP & 255; b[8] = o.stockP >> 8; b[9] = o.cur & 255; b[10] = o.cur >> 8; b[13] = o.tq; return sumck(b); }
function f46v4(o){ const b = new Array(15).fill(0); b[0] = 0x46;
  b[1] = (o.fw << 7) | (o.cad & 127); b[2] = (o.stemp << 2) | ((o.tq10 >> 8) & 3); b[3] = o.tq10 & 255; b[4] = o.pv; b[5] = 0x84;
  b[6] = (o.pg << 4) | (o.nbad & 15); b[7] = o.hall & 255; b[8] = o.hall >> 8; b[9] = o.cur & 255; b[10] = o.cur >> 8; b[13] = o.tq; return sumck(b); }

// scénario nominal : signaux en fonction de l'étape et du temps écoulé depuis son entrée (s)
function scen(id, t){
  const o = { v:0, tq:0, cur:0, tq10:300, cadInc:0, fwTog:false, err:0 };
  if(id === 'R1'){ o.fwTog = true; }
  else if(id === 'R2'){ o.v = 8; o.cadInc = 6; o.fwTog = true; o.tq = 1; }
  else if(id === 'R3'){ if(t % 6 < 3){ o.tq = 20; o.tq10 = 500; } }
  else if(id === 'R4'){ o.v = Math.min(5.5, t*3); o.cur = o.v > 2 ? 3000 : 0; }
  else if(id === 'R5'){ const ph = t % 8; if(ph < 3){ o.tq = 10; o.tq10 = 450; o.cadInc = 6; } o.cur = ph >= 0.3 && ph < 3.5 ? 2000 : 0; o.v = ph < 3.5 ? 10 : 5; }
  else if(id.startsWith('R6-')){ const m = +id.slice(3); o.v = Math.min(1.1*m, t*8); o.cur = 1500; o.tq = 5; o.cadInc = 6; }
  else if(id === 'R7'){ o.v = t < 5 ? 39.6*(1 - t/5) : t < 10 ? 0 : 10; o.cur = t >= 10 ? 1500 : 0; o.tq = t >= 10 ? 5 : 0; o.cadInc = t >= 10 ? 6 : 0; }
  o.hall = o.cur > 0 ? Math.round(o.v*100) : 0;   // moyeu à roue libre : le rotor ne tourne que si le moteur débite
  return o;
}
const PAGES = { 0:118, 1:12, 2:0, 3:0, 4:0, 5:112, 6:75, 7:8, 8:30, 9:11, 10:0, 11:0, 12:1 };   // 12 : b0 zéro couple acquis (normal)

async function runPhaseR(ver, opts){ opts = opts || {};
  console.log('\n=== 3. phase R simulée — patch ' + ver + (opts.silent ? ' + drapeau silencieux (page 12 b2 posé en R5)' : '') + ' ===');
  OUT.alerts.length = 0; OUT.errors.length = 0;
  ctx('motorSrc = null; lastSeq = null; log = []; recording = false; lastF46 = null;');
  const st = { seq:0, seq8:0, n8:0, cad:1, fw:0, frame:0, lvl:2, stepId:null, tEnter:NOW };
  NOW = Math.ceil(NOW/1000)*1000 + 10000;   // horloge réalignée sur 100 ms (les paquets simulés tombent sur NOW % 200 / 500)
  for(const tm of timers) tm.next = NOW + tm.period;
  const steps = []; let last = null;
  function tick(){   // 100 ms
    const p = ctx('proto'); const id = p ? p.curId : null;
    if(id !== st.stepId){ st.stepId = id; st.tEnter = NOW; if(id) steps.push(((NOW - T0)/1000).toFixed(1) + 's  ' + id); }
    const tIn = (NOW - st.tEnter)/1000, o = scen(id || 'R0', tIn);
    const v = o.v, p_ = v > 0 ? Math.max(1, Math.round(4293/v)) : 4500, est = v > 0 ? Math.round(3960/v) : 4148;
    if(NOW % 200 === 0){
      notify(pkt04(st.seq++, { torque:9, tickRaw:est, frOk:st.seq, ckErr:0, spdRawX10:Math.round(v*10), commErr:216, cur:Math.round(o.cur/25),
        voltX10:404, err:o.err, spdX10:Math.round(v*10), src:0x22 }));
    }
    if(NOW % 500 === 0){
      st.frame++; st.n8 += 3; if(o.cadInc) st.cad = 1 + ((st.cad - 1 + o.cadInc) % 127); if(o.fwTog) st.fw ^= 1;
      const pg = st.frame % 13;
      const pv = (opts.silent && pg === 12 && id === 'R5') ? PAGES[12] | 4 : PAGES[pg];   // capteur de couple défaillant
      const bytes = ver === 'v3'
        ? f46v3({ p:p_, est, spread:8, nbad:3, stockP: v > 30 ? est*2 : est, cur:o.cur, tq:o.tq })
        : f46v4({ fw:st.fw, cad:st.cad, stemp:21, tq10:o.tq10, pv, pg, nbad:3, hall:o.hall, cur:o.cur, tq:o.tq });
      notify(pkt08(st.seq8++, bytes, 0, st.n8));
    }
    if(NOW % 2000 === 0) notify(pkt01(st.lvl));
  }
  const T0 = NOW;
  async function advance(ms){
    for(let t = 0; t < ms; t += 100){ await new Promise(r => setImmediate(r)); NOW += 100; tick();
      for(const tm of [...timers]) while(tm.next <= NOW){ tm.next += tm.period; try { tm.fn(); } catch(e){ OUT.errors.push('TIMER: ' + e.message + ' @' + (e.stack.split('\n')[1] || '').trim()); } } }
  }
  await advance(3000);                    // télémétrie + un 0x08 décodé avant le clic
  check(ctx('isRd45()'), 'isRd45() vrai (stock + preset RD45)');
  check(ctx('lastF46.dec.ver') === (ver === 'v3' ? 3 : 4), 'patch détecté ' + ver);
  ctx("startProto('R')");
  if(OUT.alerts.length) console.log('  ALERTES :', OUT.alerts);
  check(!!ctx('proto') && ctx('proto').phase === 'R', 'phase R lancée');
  check(ctx('recording') === true, 'enregistrement JSONL démarré');
  let guard = 0; while(ctx('proto') && guard++ < 4000) await advance(500);
  console.log('  enchaînement : ' + steps.join(' → '));
  const lp = sandbox.window._lastProto;
  check(!!lp && lp.phase === 'R' && lp.results.length === 11, '11 étapes jugées');
  for(const r of lp.results) console.log('  ' + r.v.padEnd(3) + ' ' + r.id.padEnd(6) + ' ' + r.d);
  console.log('  --- organes ---');
  for(const k of Object.keys(lp.organs)){ const o = lp.organs[k]; console.log('  ' + o.v.padEnd(3) + ' ' + o.label.padEnd(26) + ' ' + o.d + (o.next ? '\n        prochain run : ' + o.next : '')); }
  const expectNA = ver === 'v3' ? ['cassette', 'drapeaux'] : [];   // v4 : R7 jugé sur tickRaw (= est en FIX)
  for(const k of Object.keys(lp.organs)){ const o = lp.organs[k];
    if(opts.silent && k === 'drapeaux'){ check(o.v === 'KO' && /capteur de couple/.test(o.d) && /vu en R5/.test(o.d), 'organe drapeaux attendu KO nommé « capteur de couple … vu en R5 » → ' + o.v + ' : ' + o.d); continue; }
    check(expectNA.includes(k) ? o.v === 'NA' : o.v === 'OK', 'organe ' + k + ' attendu ' + (expectNA.includes(k) ? 'n/a' : 'OK') + ' → ' + o.v); }
  const log = ctx('log');
  check(log.length > 1000 && log.every(l => l.stp) && log.some(l => l.stp === 'R6-32'), 'JSONL : ' + log.length + ' lignes avec stp (R6-32 présent)');
  check(log.every(l => l.r_ver === (ver === 'v3' ? 3 : 4)) && (ver === 'v3' ? log.every(l => 'r_p' in l && 'r_est' in l) : log.every(l => 'r_cad' in l && 'r_pg' in l)), 'JSONL : champs r_* du layout ' + ver);
  check(!log.some(l => l.tr), 'JSONL : aucune rafale reconstruite en flux régulier');
  console.log('  ERREURS : ' + (OUT.errors.length ? OUT.errors.slice(0, 4).join(' | ') : 'aucune'));
  check(!OUT.errors.length, 'aucune erreur d’exécution');
}

(async () => {
  await runPhaseR('v3');
  await runPhaseR('v4');
  await runPhaseR('v4', { silent:true });
  console.log('\n' + (fails ? fails + ' CONTRÔLE(S) EN ÉCHEC' : 'tous les contrôles passent'));
  process.exit(fails ? 1 : 0);
})();
