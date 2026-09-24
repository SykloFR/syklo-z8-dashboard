# -*- coding: utf-8 -*-
"""
protoS-report.py — dépouille les runs de la PHASE S (niveau × vitesse, pédalage)
et construit la base « loi d'assistance » d'un moteur, stock ou OSF.

Usage :
    python tools/protoS-report.py C:/Users/yanni/Downloads            # tous les *protoS-*.jsonl du dossier
    python tools/protoS-report.py ../Dev-Agent-Syklo/syklo-logs/logs/Z8-BANC   # récursif
    python tools/protoS-report.py <fichiers…> [--id Z8-BANC] [--csv sortie.csv] [--eta 0.70]

Principe (spec chantier-z8-osf/specs/protocole-S-caracterisation-stock.md v3) :
  · à charge figée et vitesse égale, la puissance roue `pmeca` est la même quel que
    soit le niveau — seul le PARTAGE cycliste/moteur change ;
  · au niveau 0, pmeca = 100 % cycliste → à chaque vitesse on connaît le couple
    cycliste T = pmeca/ω et le signal `torque` : régression ADC = offset + k·T
    (étalonnage propre au moteur ET au firmware : l'échelle stock ≠ l'échelle OSF) ;
  · aux niveaux 1-5 : P_cycliste = (torque−offset)/k × ω, P_assist = pmeca − P_cycliste,
    gain = P_assist / P_cycliste. `cur` (courant PHASE en stock, batterie en OSF) et
    `pbat` (BMS JBD, si connecté) sont reportés tels quels ; η = P_assist / pbat.

Les échantillons comptés sont relus dans les lignes (`stb` = 1, groupés par `stp`) ;
à défaut, les médianes de `meta.results` sont utilisées. Le niveau et la charge sont lus
dans l'identifiant du palier (`S-L3-v20`, `S-L0-r70-v20` = résistance 70 %, `S-L0-e150-v18`
= ERG 150 W), ce qui accepte les runs « séance » (tous les niveaux dans un fichier).
Comparaison stock ↔ OSF : mêmes paliers, même charge → même pmeca → comparer **pbat**
(indépendant du firmware, la grandeur du labo) et P_assist palier par palier ; entre
séances, CV(pbat) > 10 % = condition non contrôlée à chercher.
"""
import json, sys, glob, os, re, statistics as st, math, csv

ETA = 0.70          # rendement batterie→roue par défaut (analyse 18, L3) — seulement pour l'estimation pbat sans BMS
# Modèle Tongsheng de la prod V3.6.5 48 V (« Z8 MOTOR SYKLO Gear parameters », lignes 110-115) :
# Gear assist = gain proportionnel ; Gear_current = plafond de courant batterie du niveau (× IMAX).
GEAR_ASSIST = [0.4, 0.55, 0.7, 0.85, 1.4]
GEAR_CURRENT = [0.3, 0.5, 0.6, 0.7, 1.0]
IMAX = 23.0
# Banc de certification (analyse 18) : Pbat ≈ c · Gear assist · P_pédale à 150 W pédale, c4 = 2,80, c5 = 2,95
CERTIF_C = {4: 2.80, 5: 2.95}


def load(path):
    rows = [json.loads(l) for l in open(path, encoding='utf-8') if l.strip()]
    meta = rows[0].get('meta') if rows and 'meta' in rows[0] else None
    return meta, [r for r in rows if 'meta' not in r]


def med(a):
    a = [x for x in a if x is not None]
    return st.median(a) if a else None


def cad_est(spd_kmh, gear):
    circ = gear.get('circ_mm', 2300) / 1000.0
    return spd_kmh * 1000 / 60 / circ * gear.get('cog', 14) / gear.get('chainring', 44)


CIRC_OVERRIDE = None   # --circ : circonférence RÉGLÉE AU DISPLAY si celle du fichier est fausse


def plateaus_from_lines(rows, meta):
    """Médianes par palier sur les lignes stb=1 ; repli sur meta.results."""
    gear = dict((meta or {}).get('gear') or {'chainring': 44, 'cog': 14, 'circ_mm': 2300})
    if CIRC_OVERRIDE:
        gear['circ_mm'] = CIRC_OVERRIDE
    out = {}
    by = {}
    for r in rows:
        if r.get('stb') and r.get('stp'):
            by.setdefault(r['stp'], []).append(r)
    for stp, ss in by.items():
        spd = med([x.get('spdX10') for x in ss])
        if spd is None:
            continue
        out[stp] = dict(stp=stp, n=len(ss), spd=spd / 10, cadEst=cad_est(spd / 10, gear),
                        torque=med([x.get('torque') for x in ss]), cur=med([x.get('cur') for x in ss]),
                        pmeca=med([x.get('pmeca') for x in ss]), pbat=med([x.get('pbat') for x in ss]),
                        vbat=med([x.get('vbat') for x in ss]), cad=med([x.get('cad') for x in ss]),
                        volt=(med([x.get('voltX10') for x in ss]) or 0) / 10, lvl=med([x.get('lvl') for x in ss]))
    if not out and meta:
        for r in meta.get('results', []):
            m = r.get('med')
            if r.get('kind') == 'plateau' and m and m.get('spd') is not None:
                out[r['id']] = dict(stp=r['id'], n=m.get('n'), spd=m['spd'], cadEst=m.get('cadEst') or cad_est(m['spd'], gear),
                                    torque=m.get('torque'), cur=m.get('cur'), pmeca=m.get('pmeca'), pbat=m.get('pbat'),
                                    vbat=m.get('vbat'), cad=m.get('cad'), volt=m.get('volt'), lvl=r.get('lvl'))
    return out


def linreg(xs, ys):
    n = len(xs)
    if n < 2:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None
    k = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    b = my - k * mx
    ssr = sum((y - (b + k * x)) ** 2 for x, y in zip(xs, ys))
    sst = sum((y - my) ** 2 for y in ys)
    r2 = 1 - ssr / sst if sst else 1.0
    return k, b, r2


def fit_power(pts):
    """y = c · x^α par régression log-log ; renvoie (c, α, r²) ou None."""
    q = [(math.log(x), math.log(y)) for x, y in pts if x > 5 and y > 5]
    if len(q) < 3:
        return None
    reg = linreg([a for a, _ in q], [b for _, b in q])
    if not reg:
        return None
    k, b, r2 = reg
    return math.exp(b), k, r2


def loi_section(rows, ga, gc, imax):
    """LOI : P_assist (roue) en fonction de P_cycliste, par niveau, puis normalisée par Gear assist.
    Formes testées : linéaire avec décalage (a·P + b) et puissance (c·P^α, α < 1 = gain qui baisse quand
    l'effort monte — ce que suggèrent le banc maison (20-80 W) et le labo (150 W))."""
    allp = [r for r in rows if r['lvl'] >= 1 and r.get('P_rider') and r.get('P_assist') is not None and r['P_rider'] > 5]
    # SEUIL DE COUPLE : sous ~9-10 Nm le stock n'assiste pas (ou prend / coupe) — run loi du 2026-09-24,
    # résistance 40 % : cur médian 0 à tous les niveaux. Ces paliers sont exclus des ajustements.
    off = [r for r in allp if (r.get('cur') or 0) < 3 or r['P_assist'] < 10]
    pts = [r for r in allp if r not in off]
    if off:
        print('\nSOUS LE SEUIL DE COUPLE (assistance nulle ou intermittente, exclus des ajustements) :')
        for r in off:
            print('  L%d %-10s v %s : couple %s, P_cycl %.0f W, cur %s' % (r['lvl'], r['charge'], fmt(r['spd'], 1), fmt(r['torque']), r['P_rider'], fmt(r['cur'])))
    if len(pts) < 3:
        return
    print('\nLOI D\'ASSISTANCE — P_assist(roue) = f(P_cycliste) ; plafond batterie = Gear_current × %g A' % imax)
    print('  %-4s %-3s %-12s %-10s %-24s %-24s %s' % ('niv', 'n', 'P_cycl W', 'cad rpm', 'linéaire a·P+b (r²)', 'puissance c·P^α (r²)', 'plafond'))
    for lv in sorted(set(r['lvl'] for r in pts)):
        G = [r for r in pts if r['lvl'] == lv]
        xs, ys = [r['P_rider'] for r in G], [r['P_assist'] for r in G]
        lin = linreg(xs, ys) if len(G) >= 2 else None
        pw = fit_power(list(zip(xs, ys)))
        cap_w = gc[lv - 1] * imax * (st.median([r['vbat'] for r in G if r.get('vbat')] or [50]))
        pk = max([r['pbat'] or 0 for r in G])
        print('  L%-3d %-3d %-12s %-10s %-24s %-24s %s' % (
            lv, len(G), '%.0f-%.0f' % (min(xs), max(xs)), '%.0f-%.0f' % (min(r['cadEst'] for r in G), max(r['cadEst'] for r in G)),
            ('%.2f·P %+.0f (%.2f)' % (lin[0], lin[1], lin[2])) if lin else '–',
            ('%.2f·P^%.2f (%.2f)' % (pw[0], pw[1], pw[2])) if pw else '–',
            'pbat max %.0f / %.0f W%s' % (pk, cap_w, ' ⚠ ATTEINT' if pk > 0.9 * cap_w else '')))
    # normalisation par Gear assist : si les niveaux se superposent, loi = Gear_assist × f(P)
    norm = [(r['P_rider'], r['P_assist'] / ga[r['lvl'] - 1]) for r in pts if r['P_assist'] > 5]
    pw = fit_power(norm)
    if pw:
        c, al, r2 = pw
        print('\n  Normalisée : P_assist / Gear_assist = %.2f · P_cycl^%.2f  (r² = %.2f, %d paliers, tous niveaux)' % (c, al, r2, len(norm)))
        print('  → gain P_assist/P_cycl = Gear_assist × %.2f × P^(%.2f) : %s' % (c, al - 1, ', '.join(
            'à %d W : %.2f×GA' % (P, c * P ** (al - 1)) for P in (40, 80, 150))))
        print('  Superposition des niveaux (mesure / loi commune, 1,00 = parfait) : ' + ' · '.join(
            'L%d %.2f' % (lv, st.median([r['P_assist'] / (ga[lv - 1] * c * r['P_rider'] ** al) for r in pts if r['lvl'] == lv and r['P_assist'] > 5]))
            for lv in sorted(set(r['lvl'] for r in pts))))
        etas = [r['eta'] for r in pts if r.get('eta')]
        eta = st.median(etas) if etas else ETA
        print('  Extrapolation à 150 W pédale (point de certification, η = %.2f) vs labo (analyse 18) :' % eta)
        for lv in (4, 5):
            pa = ga[lv - 1] * c * 150 ** al
            pb = min(pa / eta, gc[lv - 1] * imax * 50)
            lab = CERTIF_C[lv] * ga[lv - 1] * 150
            print('    L%d : P_assist %.0f W, pbat %.0f W  |  labo ≈ %.0f W  (écart %+.0f %%)%s' % (
                lv, pa, pb, lab, (pb / lab - 1) * 100, '  [extrapolé au-delà des mesures]' if max(x for x, _ in norm) < 120 else ''))
    # dépendance à la cadence : même niveau, même charge, deux vitesses
    pairs = []
    for lv in sorted(set(r['lvl'] for r in pts)):
        for ch in sorted(set(r['charge'] for r in pts if r['lvl'] == lv)):
            G = sorted([r for r in pts if r['lvl'] == lv and r['charge'] == ch], key=lambda r: r['cadEst'])
            if len(G) >= 2 and pw:
                lo, hi = G[0], G[-1]
                f = lambda r: r['P_assist'] / (ga[lv - 1] * pw[0] * r['P_rider'] ** pw[1])
                pairs.append('L%d %s : %.0f→%.0f rpm, écart à la loi %+.0f %% → %+.0f %%' % (lv, ch, lo['cadEst'], hi['cadEst'], (f(lo) - 1) * 100, (f(hi) - 1) * 100))
    if pairs:
        print('  Cadence (même charge, deux vitesses ; un écart qui change de signe avec la cadence = loi dépendante de la cadence) :')
        for p in pairs:
            print('    ' + p)


def fmt(v, d=0):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return '–'
    return ('%.' + str(d) + 'f') % v


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(description='Dépouillement des runs de la phase S (niveau × vitesse).')
    ap.add_argument('paths', nargs='+', help='dossiers (récursif) ou fichiers *protoS-*.jsonl')
    ap.add_argument('--id', help='ne garder que ce moteur (meta.id)')
    ap.add_argument('--csv', help='écrire aussi la table niveau × vitesse en CSV')
    ap.add_argument('--eta', type=float, default=ETA, help='rendement batterie→roue attendu (info)')
    ap.add_argument('--gear-assist', default=','.join(str(x) for x in GEAR_ASSIST), help='Gear assist L1..L5 (défaut prod V3.6.5 48 V)')
    ap.add_argument('--gear-current', default=','.join(str(x) for x in GEAR_CURRENT), help='Gear_current L1..L5 (fraction de --imax)')
    ap.add_argument('--imax', type=float, default=IMAX, help='courant batterie max (A) auquel s\'applique Gear_current')
    ap.add_argument('--circ', type=float, help='circonférence (mm) RÉGLÉE AU DISPLAY, remplace celle des fichiers '
                    '(les runs du 2026-09-24 matin portent 2050 alors que le display du banc est à 2300). '
                    'Ne change ni les gains ni pbat, seulement les N·m et les rpm')
    a = ap.parse_args(argv)
    global CIRC_OVERRIDE
    CIRC_OVERRIDE = a.circ
    ga = [float(x) for x in a.gear_assist.split(',')]
    gc = [float(x) for x in a.gear_current.split(',')]
    imax = a.imax
    want_id, eta, opts = a.id, a.eta, {'--csv': a.csv}
    files = []
    for a in a.paths:
        if os.path.isdir(a):
            files += glob.glob(os.path.join(a, '**', '*protoS-*.jsonl'), recursive=True)
        else:
            files += glob.glob(a)
    files = sorted(set(files))
    if not files:
        print('aucun fichier *protoS-*.jsonl trouvé'); return 1

    # ---- ingestion : un enregistrement par palier, clé (id, proto, lvl, vT)
    runs = []
    for f in files:
        meta, rows = load(f)
        if not meta or meta.get('phase') != 'S':
            continue
        if want_id and meta.get('id') != want_id:
            continue
        pls = plateaus_from_lines(rows, meta)
        proto = 'stock' if meta.get('proto') == 2 else 'osf' if meta.get('proto') == 1 else '?'
        tr = meta.get('trainer') or {}
        grid_charge = '%s %s' % (tr.get('mode'), tr.get('val'))
        for stp, m in pls.items():
            mv = re.search(r'-v(\d+(?:\.\d+)?)', stp)
            if not mv:
                continue
            vT = float(mv.group(1))
            ml = re.match(r'S-L(\d)', stp)
            lvl = int(ml.group(1)) if ml else int(meta.get('lvl') or m.get('lvl') or 0)
            me, mr, mg = re.search(r'-e(\d+)-', stp), re.search(r'-r(\d+)-', stp), re.search(r'-g(\d+(?:\.\d+)?)-', stp)
            erg = float(me.group(1)) if me else None
            res = int(mr.group(1)) if mr else None
            grade = float(mg.group(1)) if mg else None
            charge = ('ERG %g W' % erg) if erg else ('res %d' % res) if res else ('pente %g %%' % grade) if grade else grid_charge
            m.update(file=os.path.basename(f), id=meta.get('id'), fw=proto, motorFw=meta.get('motorFw'),
                     day=(meta.get('ts') or '')[:10], lvl=lvl, vT=vT, erg=erg,
                     trainer=json.dumps(tr), charge=charge, street=meta.get('street'))
            runs.append(m)
        for r in (meta.get('results') or []):
            if r.get('kind') == 'sweep':
                runs.append(dict(sweep=True, file=os.path.basename(f), id=meta.get('id'), fw=proto,
                                 lvl=int(r.get('lvl') if r.get('lvl') is not None else meta.get('lvl') or 0),
                                 vcut=r.get('vcut'), vmax=r.get('vmax'), curBase=r.get('curBase'), d=r.get('d')))
    if not runs:
        print('aucun palier exploitable'); return 1

    csv_rows = []
    for (mid, fw) in sorted(set((r['id'], r['fw']) for r in runs)):
        SW = [r for r in runs if r['id'] == mid and r['fw'] == fw and r.get('sweep')]
        R = [r for r in runs if r['id'] == mid and r['fw'] == fw and not r.get('sweep')]
        print('\n' + '=' * 78)
        print('MOTEUR %s — firmware %s — %d paliers, %d fichiers, jours : %s' % (
            mid, fw.upper(), len(R), len(set(r['file'] for r in R)), ', '.join(sorted(set(r['day'] for r in R)))))

        # ---- étalonnage L0 : ADC = offset + k · T_Nm — sur TOUS les paliers L0 (ERG + grille) :
        # l'étalonnage ne dépend pas de la charge, et les paliers ERG apportent la plage de couple
        L0 = [r for r in R if r['lvl'] == 0 and r['pmeca'] and r['torque'] is not None]
        cal = None
        if L0:
            xs, ys = [], []
            for r in L0:
                w = r['cadEst'] * 2 * math.pi / 60
                if w > 0:
                    xs.append(r['pmeca'] / w); ys.append(r['torque'])
            cal = linreg(xs, ys)
            if cal:
                k, off, r2 = cal
                print('Étalonnage L0 (%d paliers) : torque_ADC = %.1f + %.3f × T_Nm   (r² = %.3f ; %.2f Nm par count)' % (
                    len(xs), off, k, r2, (1 / k if k else float('nan'))))
                if k <= 0 or r2 < 0.8:
                    print('⚠ étalonnage douteux (pente ≤ 0 ou r² < 0,8) : signal couple non linéaire, ou paliers L0 tous au même couple '
                          '(à résistance fixe le couple L0 est le même à toutes les vitesses → étalonnage L0 à plusieurs résistances, mode « séance » ou « étalonnage L0 »)')
                    cal = None
                if len(set(round(x) for x in xs)) < 3:
                    print('⚠ moins de 3 couples distincts au L0 : étalonnage fragile — faire l’étalonnage L0 (résistances 40/70/100 %)')
        else:
            print('⚠ aucun palier L0 : pas d’étalonnage de l’effort → P_cycliste / P_assist non calculables (faire un run L0)')

        # ---- tables par CHARGE (consigne trainer) : niveau × vitesse, médiane des runs répétés
        for ch in sorted(set(r['charge'] for r in R)):
          RL = [r for r in R if r['charge'] == ch]
          print('\n— charge : %s —' % ch)
          print('%-4s %-6s %-6s %-7s %-7s %-8s %-8s %-6s %-6s %-7s %-5s %s' % (
            'lvl', 'v', 'cad≈', 'roue W', 'torque', 'P_cycl', 'P_assist', 'gain', 'cur', 'pbat W', 'η', 'n (CV pmeca / pbat)'))
          for lvl in sorted(set(r['lvl'] for r in RL)):
            for (vT, erg) in sorted(set((r['vT'], r['erg']) for r in RL if r['lvl'] == lvl), key=lambda t: (t[0], t[1] or 0)):
                G = [r for r in RL if r['lvl'] == lvl and r['vT'] == vT and r['erg'] == erg]
                g = {k: med([r.get(k) for r in G]) for k in ('spd', 'cadEst', 'pmeca', 'torque', 'cur', 'pbat', 'vbat', 'volt')}
                pm = [r['pmeca'] for r in G if r['pmeca']]
                cv = (st.pstdev(pm) / st.mean(pm) * 100) if len(pm) > 1 and st.mean(pm) else None
                pb = [r['pbat'] for r in G if r.get('pbat')]
                cvb = (st.pstdev(pb) / st.mean(pb) * 100) if len(pb) > 1 and st.mean(pb) > 15 else None
                prid = pas = gain = eta_m = None
                if cal and g['torque'] is not None and g['cadEst']:
                    k, off, _ = cal
                    w = g['cadEst'] * 2 * math.pi / 60
                    prid = (g['torque'] - off) / k * w
                    if g['pmeca'] is not None:
                        pas = g['pmeca'] - prid
                        gain = pas / prid if prid > 5 else None
                        if g['pbat']:
                            eta_m = pas / g['pbat']
                note = ''
                if pas is not None and pas < -10:
                    note = ' ⚠ P_assist < 0 : signal couple mis à l’échelle par le niveau ? (étalonnage L0 non transférable)'
                if lvl == 0 and g['pbat'] and g['pbat'] > 15:
                    note += ' ⚠ pbat > 0 au niveau 0 (assistance fantôme ?)'
                print('%-4d %-6s %-6s %-7s %-7s %-8s %-8s %-6s %-6s %-7s %-5s %d%s%s%s' % (
                    lvl, fmt(g['spd'], 1), fmt(g['cadEst']), fmt(g['pmeca']), fmt(g['torque']), fmt(prid), fmt(pas),
                    fmt(gain, 2), fmt(g['cur']), fmt(g['pbat']), fmt(eta_m, 2), len(G),
                    (' (%.0f %% / %s)' % (cv, ('%.0f %%' % cvb) if cvb is not None else '–')) if cv is not None else '',
                    ' ⚠ CV > 10 %' if (cvb or 0) > 10 or (cv or 0) > 10 else '', note))
                csv_rows.append(dict(id=mid, fw=fw, charge=ch, erg=erg, lvl=lvl, vT=vT, n=len(G), spd=g['spd'], cadEst=g['cadEst'], pmeca=g['pmeca'],
                                     torque=g['torque'], P_rider=prid, P_assist=pas, gain=gain, cur=g['cur'], pbat=g['pbat'],
                                     vbat=g['vbat'], volt=g['volt'], eta=eta_m, cv_pmeca=cv, cv_pbat=cvb))
        # ---- gain moyen par niveau et par charge (résumé « loi »)
        if cal:
            print('\nGain apparent P_assist/P_cycliste par niveau (médiane sur les vitesses, par charge) :')
            for ch in sorted(set(r['charge'] for r in csv_rows if r['id'] == mid and r['fw'] == fw)):
                for lvl in sorted(set(r['lvl'] for r in csv_rows if r['id'] == mid and r['fw'] == fw and r['charge'] == ch and r['lvl'] > 0)):
                    gs = [r['gain'] for r in csv_rows if r['id'] == mid and r['fw'] == fw and r['charge'] == ch and r['lvl'] == lvl and r['gain'] is not None]
                    if gs:
                        print('  %s · L%d : %.2f  (%s)' % (ch, lvl, st.median(gs), ' / '.join('%.2f' % x for x in gs)))
        if cal:
            loi_section([r for r in csv_rows if r['id'] == mid and r['fw'] == fw], ga, gc, imax)
        if SW:
            print('\nCoupure (traversées 20→26 km/h) :')
            for r in SW:
                print('  L%d : %s  [%s]' % (r['lvl'], r['d'], r['file']))
        print('\nRappels : stock → `cur` = courant PHASE (pas batterie), `pbat` = BMS JBD si connecté ; OSF → `cur` = batterie (×0,16 A).')
        print('Comparaison stock ↔ OSF : mêmes paliers, même charge → comparer P_assist (ou pbat) ligne à ligne. η attendu ≈ %.2f.' % eta)

    if opts.get('--csv'):
        with open(opts['--csv'], 'w', newline='', encoding='utf-8') as fh:
            w = csv.DictWriter(fh, fieldnames=list(csv_rows[0].keys()))
            w.writeheader(); w.writerows(csv_rows)
        print('\nCSV écrit : %s (%d lignes)' % (opts['--csv'], len(csv_rows)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
