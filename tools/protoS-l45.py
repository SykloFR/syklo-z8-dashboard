# -*- coding: utf-8 -*-
"""
protoS-l45.py — dépouillement de la CARACTÉRISATION L4/L5 (mode « car » de la phase S) : ce que le firmware
délivre à la roue pour un cycliste à 100 et 150 W, à chaque cadence, plus départs et reprises.

Usage :
    python tools/protoS-l45.py <dossiers ou fichiers>                    # un firmware
    python tools/protoS-l45.py <runs OSF> --ref <runs stock>             # OSF contre stock : ni plus, ni moins
    python tools/protoS-l45.py <run dyn ancien>                          # aussi les runs dynamiques d'avant

Grandeurs : PA = roue avec assistance − roue sans assistance au même effort (méthode LCIE), ramenée exactement
à 100 et 150 W par le dashboard (ligne BILAN). `cur` stock = courant PHASE (×0,2 A), OSF = batterie (×0,16 A) :
retards et montées se lisent sur `cur` (5 Hz), les pics batterie sur le BMS (1 Hz, donc approchés).
Le couple stock est lissé par le moteur : stock et OSF se comparent sur « bip→mi-courant », pas sur « couple→courant ».
La vitesse trainer arrive à 1 Hz : le 0→15 km/h est interpolé, ±0,5 s.
"""
import json, sys, glob, os, re, statistics as st

TOL = 0.10   # critère d'équivalence OSF / stock


def load(path):
    rows = [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]
    meta = rows[0].get('meta') if rows and 'meta' in rows[0] else {}
    return meta or {}, [r for r in rows if 'meta' not in r]


def med(a):
    a = [x for x in a if x is not None]
    return st.median(a) if a else None


def f(v, d=0):
    return '–' if v is None else ('%.' + str(d) + 'f') % v


def span(a, d=1):
    a = [x for x in a if x is not None]
    return '–' if not a else ('%s [%s-%s]' % (f(st.median(a), d), f(min(a), d), f(max(a), d)))


def k_trainer(R):
    q = [r['tspd'] / (r['spdX10'] / 10) for r in R if r.get('tspd') and r.get('stb') and r.get('spdX10')]
    return st.median(q) if len(q) >= 20 else 0.94


def t_at(S, v, K):
    """Instant (ms) où la vitesse trainer (échelle display) franchit v, interpolé : elle n'arrive qu'à 1 Hz."""
    pts = []
    for r in S:
        if r.get('tspd') is not None and (not pts or pts[-1][1] != r['tspd']):
            pts.append((r['t'], r['tspd'] / K))
    for (t0, v0), (t1, v1) in zip(pts, pts[1:]):
        if v0 < v <= v1:
            return t0 + (t1 - t0) * (v - v0) / (v1 - v0)
    return None


def launches(R, rest, K):
    out = []
    for stp in sorted({r.get('stp') for r in R if r.get('stp') and re.search(r'-dep\d*$', r['stp'])}):
        G = [r for r in R if r.get('stp') == stp and r.get('sph') in ('go', 'after')]
        i0 = next((i for i, r in enumerate(G) if (r.get('torque') or 0) >= rest + 15), None)
        if i0 is None:
            continue
        cur = [r.get('cur') or 0 for r in G]
        pk = max(cur)
        iC = next((i for i in range(i0, len(G)) if cur[i] >= 10), None)
        i1 = next((i for i in range(i0, len(G)) if cur[i] >= 0.1 * pk), None)
        i9 = next((i for i in range(i0, len(G)) if cur[i] >= 0.9 * pk), None)
        t15 = t_at(G, 15, K)
        ib = [r.get('ibat') for r in G if r.get('ibat') is not None]
        pb = [r.get('pbat') for r in G if r.get('pbat') is not None]
        i5 = next((i for i in range(len(G)) if cur[i] >= 0.5 * pk), None)
        out.append(dict(lvl=int(stp[3]), bip=(G[i5]['t'] - G[0]['t']) / 1000 if pk >= 10 and i5 is not None else None,
                        tq=med([r.get('torque') for r in G[i0:]]), delay=(G[iC]['t'] - G[i0]['t']) / 1000 if iC is not None else None,
                        rise=(G[i9]['t'] - G[i1]['t']) / 1000 if pk >= 10 and i9 is not None else None, curPk=pk,
                        t15=(t15 - G[i0]['t']) / 1000 if t15 else None, ibPk=max(ib) if ib else None, pbPk=max(pb) if pb else None))
    return out


def pushes(R):
    out = []
    for i in range(1, len(R)):
        if R[i].get('sph') != 'push' or R[i - 1].get('sph') == 'push':
            continue
        tp = R[i]['t']
        pre = [r for r in R if tp - 1000 <= r['t'] < tp]
        end = next((r['t'] for r in R[i:] if r.get('sph') == 'rel'), None)
        if not pre or end is None:
            continue
        resp = [r for r in R if tp <= r['t'] <= end + 500]
        c0, q0 = med([r.get('cur') for r in pre]), med([r.get('torque') for r in pre])
        pk = max(r.get('cur') or 0 for r in resp)
        dc = pk - c0
        i5 = next((k for k, r in enumerate(resp) if (r.get('cur') or 0) >= c0 + 0.5 * dc), None)
        i1 = next((k for k, r in enumerate(resp) if (r.get('cur') or 0) >= c0 + 0.1 * dc), None)
        i9 = next((k for k, r in enumerate(resp) if (r.get('cur') or 0) >= c0 + 0.9 * dc), None)
        # descente du courant, 90 → 10 % de la réponse. Le vélo accélère et l'effort tombe avant le bip de fin :
        # le bip n'est pas une référence, et le couple stock, lissé, non plus.
        hi = [k for k, r in enumerate(R) if k >= i and r['t'] <= end + 6000 and (r.get('cur') or 0) >= c0 + 0.9 * dc]
        back = next((r for r in R[hi[-1]:] if (r.get('cur') or 0) <= c0 + 0.1 * dc), None) if hi else None
        ib = [r.get('ibat') for r in resp if r.get('ibat') is not None]
        out.append(dict(lvl=int(R[i]['stp'][3]), dtq=max(r.get('torque') or 0 for r in resp) - q0, dcur=dc,
                        bip=(resp[i5]['t'] - tp) / 1000 if dc >= 10 and i5 is not None else None,
                        rise=(resp[i9]['t'] - resp[i1]['t']) / 1000 if dc >= 10 and i9 is not None else None,
                        rel=(back['t'] - R[hi[-1]]['t']) / 1000 if back else None, ibPk=max(ib) if ib else None))
    return out


def collect(paths):
    files = []
    for p in paths:
        files += glob.glob(os.path.join(p, '**', '*protoS-*.jsonl'), recursive=True) if os.path.isdir(p) else glob.glob(p)
    bil, L, P, ech = {}, [], [], None
    for fn in sorted(set(files)):
        meta, R = load(fn)
        if meta.get('phase') != 'S':
            continue
        car = meta.get('car') or {}
        for r in meta.get('results') or []:
            if r.get('id') == 'BILAN' and car.get('run'):
                bil[car['run']] = r
            if r.get('id') == 'ECHELLE':
                ech = r
        rest = car.get('zero') or meta.get('tqRest') or 90
        L += launches(R, rest, k_trainer(R))
        P += pushes(R)
    return bil, L, P, ech


def show(titre, bil, L, P, ech):
    print('\n' + '=' * 92 + '\n' + titre)
    if ech:
        print('Échelle capteur : ' + ech['d'])
    for run in sorted(bil):
        b = bil[run]
        print('\n%s — cadence %s rpm · roue sans assistance : %s W à 150 W, %s W à 100 W (extrapolé) · pente %s' % (
            run, f(b.get('cad')), b['fw0'].get('fw150'), b['fw0'].get('fw100'), b['fw0'].get('pente')))
        print('  %-8s %-9s %-9s %-9s %-6s' % ('palier', 'roue W', 'PA W', 'batt W', 'η'))
        for k in sorted(b['tab']):
            t = b['tab'][k]
            print('  L%-7s %-9s %-9s %-9s %-6s' % (k.replace('-', ' / '), f(t.get('roue')), f(t.get('PA')), f(t.get('pbat')), f(t.get('eta'), 2)))
        print('  Pnom = 0,8·PA4 + 0,2·PA5 : %s W à 150 W · %s W à 100 W' % (f(b.get('pnom150')), f(b.get('pnom100'))))
    for lv in sorted({e['lvl'] for e in L}):
        G = [e for e in L if e['lvl'] == lv]
        print('\nDéparts L%d (n=%d) : bip→mi-courant %s s · couple→courant %s s · montée %s s · 0→15 %s s · pic cur %s · pic batt %s A / %s W · effort %s' % (
            lv, len(G), span([e['bip'] for e in G]), span([e['delay'] for e in G]), span([e['rise'] for e in G]), span([e['t15'] for e in G]), span([e['curPk'] for e in G], 0),
            span([e['ibPk'] for e in G]), span([e['pbPk'] for e in G], 0), span([e['tq'] for e in G], 0)))
    for lv in sorted({e['lvl'] for e in P}):
        G = [e for e in P if e['lvl'] == lv]
        print('Reprises L%d (n=%d) : bip→mi-courant %s s · montée %s s · descente %s s · Δcouple %s · Δcur %s · pic batt %s A' % (
            lv, len(G), span([e['bip'] for e in G]), span([e['rise'] for e in G]), span([e['rel'] for e in G]), span([e['dtq'] for e in G], 0),
            span([e['dcur'] for e in G], 0), span([e['ibPk'] for e in G])))


def compare(bil, ref):
    print('\n' + '=' * 92 + '\nÉQUIVALENCE — roue, firmware testé / référence (±%d %%, ni plus ni moins)' % (TOL * 100))
    print('  %-5s %-8s %-11s %-11s %-8s %s' % ('run', 'palier', 'PA testé', 'PA réf.', 'écart', ''))
    ko = 0
    for run in sorted(set(bil) & set(ref)):
        for k in sorted(bil[run]['tab']):
            a, b = bil[run]['tab'][k].get('PA'), ref[run]['tab'].get(k, {}).get('PA')
            if a is None or not b:
                continue
            e = a / b - 1
            ko += abs(e) > TOL
            print('  %-5s L%-7s %-11s %-11s %+5.1f %%  %s' % (run, k.replace('-', '/'), f(a), f(b), e * 100, 'OK' if abs(e) <= TOL else 'HORS BANDE'))
    print('  → %s' % ('équivalence tenue sur tous les paliers comparés' if not ko else '%d palier(s) hors bande' % ko))


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(description='Caractérisation L4/L5 : un firmware, ou OSF contre stock.')
    ap.add_argument('paths', nargs='+')
    ap.add_argument('--ref', nargs='+', help='runs de référence (stock)')
    a = ap.parse_args(argv)
    bil, L, P, ech = collect(a.paths)
    show('RUNS TESTÉS', bil, L, P, ech)
    if a.ref:
        rb, rL, rP, re_ = collect(a.ref)
        show('RÉFÉRENCE', rb, rL, rP, re_)
        compare(bil, rb)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
