# -*- coding: utf-8 -*-
"""
protoS-dyn.py — DYNAMIQUE de l'assistance par niveau (brutalité ressentie), à partir des JSONL
de la phase S : run « dynamique » (départs arrêtés + reprises guidés) ET runs « séance »
(accélérations 14 → 20 km/h entre deux paliers, départs arrêtés spontanés, coupure street).

La loi statique (protoS-report.py : gain P_assist/P_cycliste) ne dit rien de la brutalité :
au banc du 2026-09-24, un départ arrêté en L5 a tiré 40 A phase / ~900 W batterie en 1 s
(0 → 39 km/h), et la coupure street est franche (~26-27 km/h) avec un pic au réengagement.

Usage :
    python tools/protoS-dyn.py <fichiers ou dossiers> [--rest 90]

Évènements détectés dans les lignes (5 Hz ; `cur` stock = courant PHASE, 0,2 A/LSB ; `pbat` BMS 1 Hz ;
vitesse du display : elle RETARDE et se fige ~1-3 s à l'arrêt des impulsions, la puissance roue
`pmeca` du trainer est la référence en décélération) :
  · départ arrêté : vitesse nulle ≥ 1 s puis ≥ 15 km/h en < 15 s ;
  · accélération de palier : début d'un palier `S-Ln-v20` précédé d'un palier à 14 km/h ;
  · reprise guidée : sous-phase `sph` = push (run dynamique) ;
  · coupure : cur ≥ 10 → ≤ 2 alors que le couple reste ≥ repos + 8 (l'opérateur pousse) ;
    réengagement : cur ≤ 2 → ≥ 10 au-dessus de 15 km/h, pic de cur dans la seconde qui suit.
"""
import json, sys, glob, os, re, statistics as st

# Modèle Tongsheng prod V3.6.5 48 V (tableau « Gear parameters », lignes 110-115)
GEAR_ASSIST = [0.4, 0.55, 0.7, 0.85, 1.4]
GEAR_CURRENT = [0.3, 0.5, 0.6, 0.7, 1.0]
IMAX = 23.0
K_TR = 0.917   # vitesse trainer / vitesse display en régime établi (réestimé par fichier)


def load(path):
    rows = [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]
    meta = rows[0].get('meta') if rows and 'meta' in rows[0] else {}
    return meta or {}, [r for r in rows if 'meta' not in r]


def med(a):
    a = [x for x in a if x is not None]
    return st.median(a) if a else None


def mx(a):
    a = [x for x in a if x is not None]
    return max(a) if a else None


def f(v, d=0):
    return '–' if v is None else ('%.' + str(d) + 'f') % v


def spd(r):
    """Vitesse km/h À L'ÉCHELLE DU DISPLAY : celle du TRAINER (`tspd`, FTMS ~6 Hz) divisée par K_TR si
    présente — le display est lissé, faux au décollage (41,8 km/h pour 5,9 réels) et figé 1-3 s à
    l'arrêt ; sinon celle du display."""
    t = r.get('tspd')
    return t / K_TR if t is not None else (r.get('spdX10') or 0) / 10


def k_trainer(R):
    """Rapport tspd / display sur les échantillons stables (display 12-30 km/h, deux vitesses stables)."""
    q = []
    for a, b in zip(R, R[1:]):
        if b.get('tspd') and a.get('tspd') and 120 <= (b.get('spdX10') or 0) <= 300 \
                and abs(b['spdX10'] - a['spdX10']) < 4 and abs(b['tspd'] - a['tspd']) < 0.4:
            q.append(b['tspd'] / (b['spdX10'] / 10))
    return st.median(q) if len(q) >= 20 else K_TR


def lvl_of(stp, r):
    m = re.match(r'S-L(\d)', stp or '')
    return int(m.group(1)) if m else r.get('lvl')


def launches(R, rest):
    """Départs arrêtés : ≥ 1 s à vitesse nulle, puis ≥ 15 km/h dans les 15 s."""
    out, i, n = [], 0, len(R)
    while i < n:
        if spd(R[i]) >= 0.5:
            i += 1; continue
        j = i
        while j < n and spd(R[j]) < 0.5:
            j += 1
        if j >= n or R[j - 1]['t'] - R[i]['t'] < 1000:
            i = j; continue
        # début d'effort : 1er couple ≥ repos+15 dans la fenêtre d'arrêt ou juste après
        k0 = next((k for k in range(i, min(n, j + 25)) if (R[k].get('torque') or 0) >= rest + 15), None)
        if k0 is None:
            i = j; continue
        t0 = R[k0]['t']
        W = [r for r in R[k0:] if r['t'] <= t0 + 15000]
        k15 = next((k for k, r in enumerate(W) if spd(r) >= 15), None)
        if k15 is None:
            i = j; continue
        kc = next((k for k, r in enumerate(W) if (r.get('cur') or 0) >= 10), None)
        A = [r for r in W if r['t'] <= W[k15]['t'] + 3000]
        out.append(dict(kind='départ', lvl=lvl_of(R[k0].get('stp'), R[k0]), stp=R[k0].get('stp'),
                        tq=med([r.get('torque') for r in W[:k15 + 1]]),
                        delay=(W[kc]['t'] - t0) / 1000 if kc is not None else None, t15=(W[k15]['t'] - t0) / 1000,
                        curPk=mx([r.get('cur') for r in A]), pbPk=mx([r.get('pbat') for r in A]), ibPk=mx([r.get('ibat') for r in A]),
                        pmPk=mx([r.get('pmeca') for r in A]), vmax=mx([spd(r) for r in A]) or 0))
        i = j + 1
    return out


def plateau_accels(R):
    """Accélération 14 → 20 km/h au début de chaque palier S-Ln-v20 qui suit un palier à 14 km/h."""
    out, prev = [], None
    segs = []
    for r in R:
        if not segs or segs[-1][0] != r.get('stp'):
            segs.append([r.get('stp'), []])
        segs[-1][1].append(r)
    for idx, (stp, S) in enumerate(segs):
        if stp and re.match(r'S-L\d-v20$', stp):
            before = [s for s in segs[:idx] if s[0] and re.match(r'S-L\d-v\d+$', s[0])]
            if before and before[-1][0].endswith('-v14'):
                t0 = S[0]['t']
                W = [r for r in S if r['t'] <= t0 + 15000]
                k1 = next((k for k, r in enumerate(W) if spd(r) >= 16), None)
                k2 = next((k for k, r in enumerate(W) if spd(r) >= 19), None)
                out.append(dict(kind='14→20', lvl=lvl_of(stp, S[0]), stp=stp,
                                t16_19=((W[k2]['t'] - W[k1]['t']) / 1000) if k1 is not None and k2 is not None else None,
                                tq=mx([r.get('torque') for r in W]), curPk=mx([r.get('cur') for r in W]),
                                pbPk=mx([r.get('pbat') for r in W]), vmax=mx([spd(r) for r in W]) or 0))
    return out


def pushes(R):
    out = []
    for i in range(1, len(R)):
        if R[i].get('sph') != 'push' or R[i - 1].get('sph') == 'push':
            continue
        tp = R[i]['t']
        pre = [r for r in R if tp - 1000 <= r['t'] < tp]
        resp = [r for r in R if tp <= r['t'] <= tp + 5000]
        if not pre or not resp:
            continue
        tq0, c0, v0 = med([r.get('torque') for r in pre]), med([r.get('cur') for r in pre]), med([spd(r) for r in pre]) or 0
        pb0 = med([r.get('pbat') for r in pre])
        dtq = (mx([r.get('torque') for r in resp]) or 0) - (tq0 or 0)
        dc = (mx([r.get('cur') for r in resp]) or 0) - (c0 or 0)
        pbm = mx([r.get('pbat') for r in resp])
        out.append(dict(kind='reprise', lvl=lvl_of(R[i].get('stp'), R[i]), v0=v0, dtq=dtq, dcur=dc, ibPk=mx([r.get('ibat') for r in resp]),
                        k=(dc / dtq) if dtq > 3 else None, dpb=(pbm - pb0) if pbm is not None and pb0 is not None else None,
                        dv=(mx([spd(r) for r in resp]) or 0) - v0))
    return out


def cuts(R, rest):
    cu, re_ = [], []
    for i in range(1, len(R)):
        a, b = R[i - 1], R[i]
        ca, cb = a.get('cur') or 0, b.get('cur') or 0
        if ca >= 10 and cb <= 2 and (b.get('torque') or 0) >= rest + 8 and b.get('street', 1):
            # trainer : pas de retard ; display : max de la seconde précédente (il retarde)
            v = spd(b) if b.get('tspd') is not None else (mx([r.get('spdX10') for r in R if b['t'] - 1200 <= r['t'] <= b['t']]) or 0) / 10
            cu.append(dict(lvl=lvl_of(b.get('stp'), b), v=v, stp=b.get('stp')))
        if ca <= 2 and cb >= 10 and spd(b) > 15 and b.get('street', 1):
            pk = mx([r.get('cur') for r in R if b['t'] <= r['t'] <= b['t'] + 1000])
            re_.append(dict(lvl=lvl_of(b.get('stp'), b), v=spd(b), pk=pk, stp=b.get('stp')))
    return cu, re_


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(description='Dynamique de l’assistance par niveau (phase S).')
    ap.add_argument('paths', nargs='+')
    ap.add_argument('--rest', type=float, help='couple au repos (sinon : meta.tqRest, sinon mini à l’arrêt, sinon 90)')
    a = ap.parse_args(argv)
    files = []
    for p in a.paths:
        files += glob.glob(os.path.join(p, '**', '*protoS-*.jsonl'), recursive=True) if os.path.isdir(p) else glob.glob(p)
    for fn in sorted(set(files)):
        meta, R = load(fn)
        if meta.get('phase') != 'S':
            continue
        global K_TR
        K_TR = k_trainer(R)
        still = [r.get('torque') for r in R if spd(r) < 0.5 and r.get('torque')]
        rest = a.rest or meta.get('tqRest') or (min(still) if still else 90)
        print('\n' + '=' * 78 + '\n%s  (firmware %s, couple de repos %s)' % (os.path.basename(fn), {1: 'OSF', 2: 'STOCK'}.get(meta.get('proto'), '?'), f(rest)))
        L, A, P = launches(R, rest), plateau_accels(R), pushes(R)
        C, RE = cuts(R, rest)
        if L:
            print('\nDéparts arrêtés (effort = couple médian jusqu’à 15 km/h ; cur ×0,2 = A phase) :')
            print('  %-3s %-7s %-9s %-9s %-8s %-9s %-9s %-7s %s' % ('niv', 'effort', 'retard s', '0→15 s', 'pic cur', 'pic batt', 'pic roue', 'v max', 'palier'))
            for e in sorted(L, key=lambda e: (e['lvl'] or 0)):
                print('  L%-2s %-7s %-9s %-9s %-8s %-9s %-9s %-7s %s' % (e['lvl'], f(e['tq']), f(e['delay'], 1), f(e['t15'], 1), f(e['curPk']),
                                                                    f(e['pbPk']), f(e['pmPk']), f(e['vmax'], 1), e['stp']))
        if A:
            print('\nAccélérations 14 → 20 km/h au début des paliers (séance) :')
            print('  %-3s %-10s %-9s %-8s %-9s %-7s' % ('niv', '16→19 s', 'couple max', 'pic cur', 'pic batt', 'v max'))
            for e in sorted(A, key=lambda e: e['lvl'] or 0):
                print('  L%-2s %-10s %-9s %-8s %-9s %-7s' % (e['lvl'], f(e['t16_19'], 1), f(e['tq']), f(e['curPk']), f(e['pbPk']), f(e['vmax'], 1)))
        if P:
            print('\nReprises guidées (médianes par niveau) — k = Δcur / Δcouple, la « nervosité » :')
            print('  %-3s %-3s %-9s %-9s %-7s %-9s %-7s' % ('niv', 'n', 'Δcouple', 'Δcur', 'k', 'Δbatt W', 'Δv'))
            for lv in sorted(set(e['lvl'] for e in P)):
                G = [e for e in P if e['lvl'] == lv]
                print('  L%-2s %-3d %-9s %-9s %-7s %-9s %-7s' % (lv, len(G), f(med([e['dtq'] for e in G])), f(med([e['dcur'] for e in G])),
                                                            f(med([e['k'] for e in G]), 2), f(med([e['dpb'] for e in G])), f(med([e['dv'] for e in G]), 1)))
        if C or RE:
            print('\nCoupure street (en poussant) :')
            for lv in sorted(set([e['lvl'] for e in C] + [e['lvl'] for e in RE]), key=lambda x: x or 0):
                c = [e['v'] for e in C if e['lvl'] == lv]
                r = [e for e in RE if e['lvl'] == lv]
                print('  L%s : %d coupure(s) à %s km/h (médiane %s) ; %d réengagement(s) à %s km/h, pic cur %s' % (
                    lv, len(c), ' / '.join(f(x, 1) for x in c) or '–', f(med(c), 1), len(r),
                    ' / '.join(f(e['v'], 1) for e in r) or '–', ' / '.join(f(e['pk']) for e in r) or '–'))
        if L or P:
            print('\nModèle Tongsheng (Gear_current × %g A = plafond batterie du niveau ; k normalisé par Gear assist) :' % IMAX)
            for lv in range(1, 6):
                cap = GEAR_CURRENT[lv - 1] * IMAX
                dl = [e['ibPk'] for e in L if e['lvl'] == lv and e.get('ibPk')]
                pl = [e for e in P if e['lvl'] == lv]
                ib = max(dl) if dl else None
                kr = med([e['k'] for e in pl])
                rp = max([e['ibPk'] or 0 for e in pl]) if pl else None
                if ib is None and kr is None:
                    continue
                print('  L%d : départ %s A / plafond %.1f A%s · reprises k/GA = %s, I batt max %s A%s' % (
                    lv, f(ib, 1), cap, ('  (%+.0f %%)' % ((ib / cap - 1) * 100)) if ib else '',
                    f(kr / GEAR_ASSIST[lv - 1], 2) if kr is not None else '–', f(rp, 1),
                    '  ⚠ plafond atteint : k mesure le plafond, pas le gain' if rp and rp > 0.9 * cap else ''))
        mv = [(a, b) for a, b in zip(R, R[1:]) if spd(a) > 10 and b['t'] - a['t'] < 1000]
        dur = sum((b['t'] - a['t']) / 1000 for a, b in mv)
        chg = sum(1 for a, b in mv if b.get('spdX10') != a.get('spdX10'))
        if dur > 20:
            rate = chg / dur
            print('\n  signal vitesse display : %.2f mise(s) à jour/s en roulant%s' % (
                rate, '  ⚠ FAIBLE (≈ 1,6-2,1 normalement) : impulsions perdues → le stock coupe l’assistance' if rate < 0.8 else ''))
        streets = sorted(set(r.get('street') for r in R if r.get('street') is not None))
        print('\n  street : %s ; échelle trainer/display = %.3f' % ({(0,): 'OFF (débridé)', (1,): 'ON', (0, 1): 'ON puis OFF (mixte)'}.get(tuple(streets), str(streets)), K_TR))
        if not (L or A or P or C or RE):
            print('  (aucun évènement dynamique)')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
