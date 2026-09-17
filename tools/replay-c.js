/* Rejeu des verdicts de la phase C sur un JSONL de banc : charge index.html dans
   un bac a sable (DOM/BLE factices, meme principe que dryrun.js), injecte la
   config display (aT/aP/mode) et appelle check() de chaque etape avec les
   echantillons du fichier (champ stp). Sert a re-etalonner REFC sans moteur.
   Usage : node tools/replay-c.js index.html run-protoC.jsonl [--cfg '{"mode":4,"aT":[...],"aP":[...]}'] */
const fs = require('fs'), vm = require('vm');

const [htmlPath, jsonlPath] = process.argv.slice(2);
if (!htmlPath || !jsonlPath) { console.error('usage: node tools/replay-c.js index.html run.jsonl [--cfg JSON]'); process.exit(1); }
const ci = process.argv.indexOf('--cfg');
const cfgOverride = ci > 0 ? JSON.parse(process.argv[ci + 1]) : null;

const html = fs.readFileSync(htmlPath, 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

// ---- DOM minimal (copie de dryrun.js) ---------------------------------
const els = {};
function el(id) {
  if (!els[id]) els[id] = {
    id, textContent: '', innerHTML: '', value: '0', max: '100', hidden: false,
    disabled: false, className: '', style: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, onclick: null,
    getContext: () => new Proxy({}, { get: () => () => {} }),
    width: 1200, height: 220,
  };
  return els[id];
}
const sandbox = {
  console,
  document: { getElementById: el, createElement: () => ({ click() {}, set href(v) {}, set download(v) {} }), addEventListener() {} },
  window: {}, navigator: { bluetooth: {}, clipboard: { writeText: async () => {} } },
  Blob: function () {}, URL: { createObjectURL: () => 'blob:x' },
  alert: () => {}, confirm: () => true, requestAnimationFrame: () => {}, addEventListener: () => {},
  setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, Date,
  Uint8Array, DataView, Math, JSON, Set, Map, Promise, isNaN, parseInt, parseFloat, Intl,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try { vm.runInContext(script, sandbox, { filename: 'dashboard.js' }); }
catch (e) { console.error('ERREUR AU CHARGEMENT :', e.message); process.exit(1); }

// ---- donnees ------------------------------------------------------------
const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const meta = lines.find(o => o.meta)?.meta;
const rows = lines.filter(o => !o.meta);
const byStep = new Map();
for (const r of rows) { if (!byStep.has(r.stp)) byStep.set(r.stp, []); byStep.get(r.stp).push(r); }

// ---- injection config + etat protocole ----------------------------------
const cfg = Object.assign({}, cfgOverride || {});
if (!cfg.mode && rows[0] && rows[0].mode != null) cfg.mode = rows[0].mode;
vm.runInContext(`Object.assign(cfg, ${JSON.stringify(cfg)});
  proto = {phase:'C', steps:PROTO_C, idx:-1, curId:null, state:'idle', t0:0, samples:[], results:[], baseVolt:null, plateaus:[], runStart:null};`, sandbox);

console.log('== ' + jsonlPath + (meta ? ` (${meta.id}, ${meta.ts}, preset ${meta.preset})` : ''));
console.log('cfg :', JSON.stringify(vm.runInContext('({mode:cfg.mode, aT:cfg.aT, aP:cfg.aP})', sandbox)));
const steps = vm.runInContext('PROTO_C', sandbox);
for (const st of steps) {
  const ss = byStep.get(st.id) || [];
  if (!ss.length) { console.log(`${st.id.padEnd(5)} —   (aucun échantillon)`); continue; }
  // curLvl : le check des niveaux ne le lit pas, mais on le pose par coherence
  vm.runInContext(`curLvl = ${ss[ss.length - 1].lvl ?? 'null'}`, sandbox);
  let v;
  try { v = st.check(ss); } catch (e) { v = { v: 'ERR', d: e.message }; }
  console.log(`${st.id.padEnd(5)} ${v.v.padEnd(3)} ${v.d}`);
}
