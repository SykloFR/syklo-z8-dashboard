# -*- coding: utf-8 -*-
"""
make-reference.py — construit l'ETALON moteur a partir des JSONL du banc.

Usage :
    python tools/make-reference.py C:/Users/yanni/Downloads

Ingere tous les bench-protoA-*.jsonl / bench-protoB-*.jsonl du dossier,
extrait les metriques cles de chaque run, affiche la repetabilite, et emet le
bloc REF a coller dans index.html quand on veut resserrer les tolerances.

⚠ Ne garde que les runs VALIDES : un run est ecarte si la consigne (bset) n'a
jamais depasse 60/254 (~24 %) — signature des runs du 2026-07-24 fausses par le
clamp d'echelle (consigne verrouillee a 48). Etalonner sur un run casse
empoisonnerait la reference.
"""
import json, sys, glob, os, statistics as st

def load(path):
    return [json.loads(l) for l in open(path, encoding='utf-8')]

def steps(rows):
    out = {}
    for r in rows:
        k = r.get('stp')
        if k: out.setdefault(k, []).append(r)
    return out

def d2p(d): return round(d*100/254)

def metrics_A(rows):
    ss = steps(rows)
    m = {}
    # paliers : ERPS moyen par cible de duty (cle = % cible arrondi)
    for k, s in ss.items():
        if not k.startswith('A4'): continue
        bs = [x['bset'] for x in s if x.get('bset')]
        if not bs: continue
        target = d2p(max(bs))
        m.setdefault('plateau', {})[target] = st.mean(x['erps'] for x in s)
    # decollage : premiere consigne avec rotation
    take = None
    for x in ss.get('A3', []):
        if take is None and x['erps'] > 5 and x.get('bset'): take = d2p(x['bset'])
    m['takeoff'] = take
    a5 = ss.get('A5', [])
    if a5:
        m['erpsMax'] = max(x['erps'] for x in a5)
        m['a5duty']  = max(x['duty'] for x in a5)   # % — pour savoir si plafonne
    # A7 : temps de montee (echelon -> 90 % du max)
    a7 = ss.get('A7', [])
    if a7:
        peak = max(x['erps'] for x in a7); stepAt = reach = None
        for x in a7:
            if stepAt is None and x.get('bset', 0) > 10: stepAt = x['t']
            if stepAt and reach is None and x['erps'] >= 0.9*peak: reach = x['t']
        if stepAt and reach: m['rise'] = (reach-stepAt)/1000
    # A8 : roue libre
    a8 = ss.get('A8', [])
    if a8:
        peak = 0; cut = stop = None
        for x in a8:
            peak = max(peak, x['erps'])
            if cut is None and x.get('bset') == 0 and peak > 20: cut = x['t']
            if cut and stop is None and x['erps'] < 5: stop = x['t']
        if cut and stop: m['coast'] = (stop-cut)/1000
    m['offset'] = st.mean(x['torque'] for x in ss.get('A1', [])) if ss.get('A1') else None
    return m

def metrics_B(rows):
    ss = steps(rows)
    m = {}
    if ss.get('B1b'): m['b1bDelta'] = max(x['delta'] for x in ss['B1b'])
    if ss.get('B1'):  m['baseVolt'] = st.mean(x['voltX10'] for x in ss['B1'])/10
    if ss.get('B3'):  m['b3cur'] = max(x['cur'] for x in ss['B3'])
    b4 = ss.get('B4', [])
    if b4:
        m['b4cur'] = max(x['cur'] for x in b4)
        m['b4pow'] = max(x['pow'] for x in b4)
        m['b4spd'] = max(x['spdX10'] for x in b4)/10
    loaded = ss.get('B3', []) + b4 + ss.get('B5', [])
    if loaded and m.get('baseVolt'):
        m['sag'] = m['baseVolt'] - min(x['voltX10'] for x in loaded)/10
    b5 = ss.get('B5', [])
    if len(b5) > 20:
        h = len(b5)//2
        c1 = st.mean(x['cur'] for x in b5[:h]); c2 = st.mean(x['cur'] for x in b5[h:])
        m['b5drift'] = (c2-c1)/c1*100 if c1 > 3 else 0.0
    return m

def valid(rows, phase):
    """Un run n'entre dans la reference que s'il a le PROFIL DU PROTOCOLE
    ACTUEL. Les runs du 2026-07-24 fausses par le clamp d'echelle (paliers
    verrouilles a 48/254) et les phases B d'avant recalibrage (B4 a 60 %)
    ressembleraient a des moteurs malades — les moyenner empoisonnerait
    l'etalon."""
    if phase == 'A':
        a4 = [r.get('bset') or 0 for r in rows if (r.get('stp') or '').startswith('A4')]
        return a4 and max(a4) > 100          # paliers montes au-dela de 40 %
    return max((r.get('bset') or 0) for r in rows) >= 200   # B4 a 85 % present

def fmt(v): return '-' if v is None else (f'{v:.2f}' if isinstance(v, float) else str(v))

def main(folder):
    runs = {'A': [], 'B': []}
    for ph in 'AB':
        for f in sorted(glob.glob(os.path.join(folder, f'bench-proto{ph}-*.jsonl'))):
            rows = load(f)
            if not valid(rows, ph):
                print(f'  ecarte (profil de protocole obsolete ou run clampe) : {os.path.basename(f)}')
                continue
            met = metrics_A(rows) if ph == 'A' else metrics_B(rows)
            met['_file'] = os.path.basename(f)
            runs[ph].append(met)
    print()
    for ph in 'AB':
        print(f'=== PHASE {ph} — {len(runs[ph])} run(s) valide(s) ===')
        keys = sorted({k for m in runs[ph] for k in m if not k.startswith('_') and k != 'plateau'})
        for m in runs[ph]: print('  ', m['_file'])
        if ph == 'A':
            targets = sorted({t for m in runs[ph] for t in m.get('plateau', {})})
            for t in targets:
                vals = [m['plateau'][t] for m in runs[ph] if t in m.get('plateau', {})]
                cv = st.pstdev(vals)/st.mean(vals)*100 if len(vals) > 1 and st.mean(vals) else 0
                print(f'   palier {t:>2} % : ERPS {st.mean(vals):6.1f}  (n={len(vals)}, CV {cv:.1f} %)')
        for k in keys:
            vals = [m[k] for m in runs[ph] if m.get(k) is not None]
            if not vals: continue
            cv = st.pstdev(vals)/st.mean(vals)*100 if len(vals) > 1 and st.mean(vals) else 0
            print(f'   {k:<9}: {st.mean(vals):8.2f}  (n={len(vals)}, min {min(vals):.2f}, max {max(vals):.2f}, CV {cv:.1f} %)')
        print()
    # bloc REF pret a coller
    A, B = runs['A'], runs['B']
    def agg(ms, k):
        vs = [m[k] for m in ms if m.get(k) is not None]
        return round(st.mean(vs), 2) if vs else None
    plateau = {}
    for t in sorted({t for m in A for t in m.get('plateau', {})}):
        plateau[t] = round(st.mean([m['plateau'][t] for m in A if t in m.get('plateau', {})]))
    ref = {
        'nA': len(A), 'nB': len(B), 'plateau': plateau,
        'takeoff': agg(A, 'takeoff'),
        'erpsMax85': agg([m for m in A if 75 <= (m.get('a5duty') or 0) <= 92], 'erpsMax'),
        'erpsMax100': agg([m for m in A if (m.get('a5duty') or 0) > 92], 'erpsMax'),
        'rise': agg(A, 'rise'), 'coast': agg(A, 'coast'), 'offset': agg(A, 'offset'),
        'b1bDelta': agg(B, 'b1bDelta'), 'b3cur': agg(B, 'b3cur'),
        'b4cur': agg(B, 'b4cur'), 'b4pow': agg(B, 'b4pow'), 'sag': agg(B, 'sag'),
    }
    print('=== bloc REF (a reporter dans index.html si les valeurs ont bouge) ===')
    print('const REF =', json.dumps(ref, ensure_ascii=False), ';')

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
