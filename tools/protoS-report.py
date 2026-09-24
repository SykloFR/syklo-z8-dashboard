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
    ap.add_argument('--circ', type=float, help='circonférence (mm) RÉGLÉE AU DISPLAY, remplace celle des fichiers '
                    '(les runs du 2026-09-24 matin portent 2050 alors que le display du banc est à 2300). '
                    'Ne change ni les gains ni pbat, seulement les N·m et les rpm')
    a = ap.parse_args(argv)
    global CIRC_OVERRIDE
    CIRC_OVERRIDE = a.circ
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
            me, mr = re.search(r'-e(\d+)-', stp), re.search(r'-r(\d+)-', stp)
            erg = float(me.group(1)) if me else None
            res = int(mr.group(1)) if mr else None
            charge = ('ERG %g W' % erg) if erg else ('res %d' % res) if res else grid_charge
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
