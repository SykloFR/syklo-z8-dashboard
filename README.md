# syklo-z8-dashboard — Télémétrie bench Z8-OSF (Web BLE)

**Ce dépôt est la SOURCE UNIQUE de la page.** Toute modification se fait ici, puis
`git push origin master` : GitHub Pages republie automatiquement sur
https://syklofr.github.io/syklo-z8-dashboard/ (1 à 2 min).

Le chantier `Dev-Agent-Syklo/chantier-z8-osf/tools/ble-dashboard/` ne contient plus
qu'un pointeur vers ce dépôt — il n'y a plus de copie à synchroniser.

---

Page unique (`index.html`, zéro dépendance) qui se connecte au SW102 en Web
Bluetooth (service NUS) et affiche en live le **paquet 0x04** du firmware
2.18.0-z8osf (et le paquet 0x08 = trame 0x46 du contrôleur RD45, display ≥ 2.18.x-rd45log,
**décodée** depuis le 2026-09-21 : patch speedfix v3/v4) : ADC torque brut + delta, cadence, duty, ERPS, FOC, courant ADC,
tension, erreurs (bit7 = E08), hall, vitesse — 10 Hz, graphe 60 s.

## Lancer

```bash
cd chantier-z8-osf/tools/ble-dashboard
python -m http.server 8765
# puis ouvrir http://localhost:8765 dans CHROME (pas Brave par defaut)
```
- Web Bluetooth exige https ou localhost → toujours passer par le serveur local.
- **Brave bloque Web Bluetooth par défaut** (brave://flags → Web Bluetooth API)
  → Chrome ou Edge recommandés.
- ⚠️ Une seule connexion BLE à la fois sur le SW102 : déconnecter SykloConnect
  avant (et inversement).

## Boucle de travail avec Claude

1. Renseigner une fois le panneau **« Archivage GitHub »** (identifiant vélo/moteur, type,
   firmware moteur déclaré, contexte, note) et coller le **jeton GitHub** (fine-grained,
   dépôt `SykloFR/syklo-logs`, permission *Contents : Read and write*) → « Enregistrer le
   jeton » → « Tester ». Ces réglages restent dans le navigateur de l'appareil.
2. « Enregistrer » avant un run → « Stop » (ou fin de protocole / arrêt du mode banc) :
   le JSONL part **automatiquement** dans le dépôt privé `syklo-logs` sous
   `logs/<ID>/<date>/<horodatage>_<ID>_<contexte>.jsonl`, première ligne = `meta`
   (identifiant, type, firmware, contexte, preset display, protocole détecté, horodatage,
   fuseau). Claude fait `git pull` dans `Dev-Agent-Syklo/syklo-logs/` et analyse.
   Hors ligne ou jeton absent : file d'attente locale (bouton « Renvoyer la file ») et
   téléchargement local en secours ; « Télécharger JSONL » reste disponible.
   Sur téléphone : Chrome Android (Web Bluetooth) — le dashboard tourne en roulant.
2. « Copier stats » met un résumé JSON (min/max/moyenne fenêtre) dans le
   presse-papier → coller directement dans le chat.
3. Alternative live : ouvrir la page dans Chrome avec l'extension Claude
   connectée → Claude lit les valeurs à l'écran en direct.

## Retour visuel de connexion

Chaque bouton porte son propre état — c'est là que l'œil se pose après le clic :

| État | Apparence |
|---|---|
| au repos | « Connecter (BLE) » / « Connecter home trainer » |
| en cours | fond ambre, « Connexion… » / « Recherche… » |
| connecté | **fond vert, « ✓ <nom de l'appareil> connecté »** |
| déconnecté ou erreur | retour au libellé initial |

Le nom affiché est celui annoncé par l'appareil en BLE (ex. « KICKR CORE connecté »).

## Home trainer (banc)

Bouton **« Connecter home trainer »** — connexion BLE **indépendante** du SW102.
Web Bluetooth autorise plusieurs appareils simultanément : le trainer et le display
sont deux connexions GATT distinctes, elles ne se gênent pas. Le trainer n'occupe
donc pas le canal du display (la règle « une seule connexion à la fois » ne vaut
que pour le SW102, partagé avec SykloConnect).

Deux standards supportés, tentés dans cet ordre :

| Service | Caractéristique | Remarque |
|---|---|---|
| Cycling Power `0x1818` | Cycling Power Measurement `0x2A63` | puissance **toujours** aux octets 2-3 — universel |
| FTMS `0x1826` | Indoor Bike Data `0x2AD2` | position variable, les flags sont déroulés champ par champ |

Ajoute deux tuiles :
- **Puissance roue** (W, mesure du trainer) ;
- **Ratio roue/batterie** — affiché seulement si le moteur consomme > 20 W.

Panneau **« Home trainer — pilotage manuel »** (hors protocole guidé) : résistance
directe (%), pente simulée (%) ou puissance cible ERG (W), plus le bouton
**« Charge max »** = ERG 600 W (plafond du Van Rysel D100). ⚠ « Résistance 100 % »
n'est **pas** la charge maximale : c'est le niveau 10 d'une courbe qui suit la
vitesse (~11 W/km/h, presque rien à l'arrêt) — vu le 2026-09-17, le volant
s'emballait à 45-49 km/h en 1 s sur des départs L5. En ERG, le trainer doit tenir
la cible quelle que soit la vitesse et pousse son frein au maximum sous ~10 km/h :
c'est le réglage pour charger un départ en force ou un maintien à basse vitesse.

⚠️ Le ratio **n'est PAS le rendement du moteur** : la puissance à la roue inclut
l'apport du cycliste. Pour approcher un rendement, il faut soustraire une mesure
de référence faite au même braquet et à la même vitesse, assistance coupée.

Un garde-fou ignore les valeurs hors [0, 3000] W (trames partielles au démarrage).

## BMS JBD (puissance batterie réelle)

Bouton **« Connecter BMS JBD »** — 3ᵉ connexion GATT, indépendante du display et du
trainer, **lecture seule**. Même protocole que SykloConnect
(`shared/ble-specs/ble-commands.md`) : service `ff00`, commande `DD A5 03 00 FF FD 77`
sur `ff02` toutes les secondes, réponse `DD 03 00 <len> <data…> <ck> 77` sur `ff01`
(tension u16 ×10 mV, courant s16 ×10 mA — la page le renvoie **décharge positive** —,
SOC à data[19]) réassemblée sur la longueur annoncée (morceaux BLE de 20 octets).

Tuile **Puissance batt. (BMS)** + champs JSONL `vbat` / `ibat` / `pbat`. C'est la
**seule** puissance batterie fiable sous firmware stock (le display n'y remonte que
le courant phase) et la grandeur mesurée par le banc de certification. Le pack du
banc est un JBD ; un DPowerCore n'est pas géré ici.

## Format JSONL

`{t, seq, torque, delta, cad, duty, erps, foc, cur, voltX10, err, hall, spdX10, pow, pmeca, src}`
(t = epoch ms ; valeurs brutes firmware, tension = voltX10/10 V,
vitesse = spdX10/10 km/h ; `pow` = puissance batterie W, `pmeca` = puissance roue W,
`null` si le trainer n'est pas connecté ; `src` = octet 19 du 0x04, `null` si
display < 2.18.10 — voir section suivante.)

Champs optionnels : `stp` (étape du protocole guidé), `stb` (= 1 dans une fenêtre
stable de la phase S), `bset` (consigne banc), `vbat` / `ibat` / `pbat` (tension V,
courant A — décharge positive — et puissance W **réels** lus sur le BMS JBD, présents
seulement quand il est connecté, voir « BMS JBD »).

Champs ajoutés le 2026-09-21 :

| Champ | Présent quand | Sens |
|---|---|---|
| `tr`, `ta` | rafale BLE reconstruite | `tr` = 1 : `t` a été **reconstruit** sur le compteur `seq` (voir « Fiabilité sur Android ») ; `ta` = temps de réception réel (ms epoch), seulement si `tr` = 1 |
| `gpsX10`, `gpsAcc` | géolocalisation accordée et au moins un fix | vitesse GPS × 10 (km/h) et précision (m) du dernier fix s'il a ≤ 3 s, sinon `null` ; **absents** si le GPS est refusé ou indisponible |
| `r_ver`, `r_fix`, `r_cur`, `r_tq` | bloc 0x46 décodé (stock RD45, tout patch) | version du patch (0 = stock non patché), mode FIX (1) / DIAG (0), courant moteur brut TX18-19, couple net TX22 |
| `r_nbad` | patch ≥ v3 | compteur de rejets capteur (mod 16) |
| `r_p`, `r_est`, `r_stock`, `r_spread` | patch **v3** | période d'impulsion capteur (205 µs, 4500 = arrêt), estimation patch (= `tickRaw`), période stock brute, étendue des 16 dernières périodes |
| `r_tq10`, `r_cad`, `r_fw`, `r_stemp`, `r_hall`, `r_pg`, `r_pv` | patch **v4** | couple 10 bits, compteur d'impulsions de pédalage (1..127), bit roue libre, température capteur (6 bits), Hall_Speed, index et valeur de la page |

Le `f46` brut (hex), `f46age`, `f46n`, `f46len` sont conservés tels quels : les `r_*` en
sont une lecture compacte (`decodeF46` dans `index.html`, layout ci-dessous), redécodable
a posteriori si le layout évolue.

⚠ `voltX10` (0x04, octets 13-14) est `battery_voltage_soc_x10` = tension mesurée
**+ I × R_pack** (`state.c`, compensation pour le SOC) — sous charge ce n'est pas la
tension aux bornes, en OSF comme en stock. Pour une tension et une puissance batterie
vraies : le BMS (`vbat`, `pbat`).

## Moteur en firmware STOCK Tongsheng (display ≥ 2.18.10)

Un moteur resté en firmware stock (TSDZ8/RD45) remonte quand même une télémétrie
exploitable : l'octet 19 du 0x04 (nouveau) déclare la source — bits 0-3 =
protocole **détecté** par le display (0 aucun, 1 OSF/mbrusa, 2 stock Tongsheng),
bits 4-7 = motor_version configuré. Recopié dans chaque ligne JSONL (`src`).

En stock, le display remplit le 0x04 depuis la trame native 9 octets :

| Champ | En stock |
|---|---|
| `torque` | **signal couple brut Tongsheng** (octet 3 de la trame) — échelle et offset ≠ ADC OSF (le repère « vide 120-250 » ne s'applique pas) |
| `cur` | **courant PHASE** (octet 4 de la trame 0x43, 0,2 A/LSB dans la convention du display) — **pas le courant batterie** : établi le 2026-09-17 (display 33-35 A quand le BMS JBD voit 23,7 A = cap 22 A du hex). Mesure *relative* du couple moteur à vitesse égale ; ne jamais en faire des watts batterie |
| `pow` | calcul display = courant phase × tension → **gonflé ×1,4-1,5**, à ignorer en stock. Puissance batterie réelle = `pbat` (BMS JBD) |
| `voltX10`, `spdX10` | valides (tension = ADC display, vitesse = ticks stock) |
| `err` | **CODE d'erreur stock Tongsheng** — PAS le bitfield OSF, ne pas décoder err02…err08 |
| `delta`, `cad`, `duty`, `erps`, `foc`, `hall` | **absents de la trame stock** → 0 (« n/a » à l'écran) |

`pow` (0x02) et `pmeca` (trainer) restent disponibles.

Le dashboard affiche « STOCK — télémétrie réduite » et **bloque les phases
guidées A/B/C et le mode banc** : le mode banc pilote le moteur par la trame TX
OSF (mode 8 + duty) qu'un moteur stock ignore — le display 2.18.10 refuse
d'ailleurs l'armement hors OSF. Évaluer un moteur stock = **run libre
● Enregistrer** (pédalage réel ou sur trainer) : couple brut, courant, tension,
vitesse, erreurs. Comparaison **entre moteurs stock uniquement**, jamais aux
références REF/REFC (établies sous OSF).

### Bloc 0x46 décodé — RD45 + patch Syklo « speedfix » (2026-09-21)

Le display en stock relaie dans le **paquet 0x08** (2 Hz) les 15 octets `TX[9..23]` du bloc
TX du contrôleur KZQWA56 : `f46[0]` = 0x46 (en-tête), `f46[i]` = `TX[9+i]`, `f46[14]` =
somme 8 bits de `f46[0..13]`. `decodeF46(bytes)` (index.html) lit ce bloc **versionné sur
l'octet mode `f46[5]` = TX14** : bit 7 = FIX actif, bits 0-6 = version du patch (0 = stock
non patché, tout à 0). ⚠ Le décodeur Python de référence
(`chantier-rd45-firmware/patch/decode_f46_patch.py`) saute l'en-tête : son `f46[i]` est
notre `f46[i+1]`.

| Octets (paquet BLE) | Commun | v3 (`0x03` / `0x83`) | v4 (`0x04` / `0x84`) |
|---|---|---|---|
| `f46[1..2]` | | SPA/SPB brut LE : bit 15 niveau, bits 0-14 = `p` période d'impulsion (205 µs, 9/tour, 4500 = arrêt) | `f46[1]` = octet 3 capteur Kclamber : bit 7 roue libre (bascule à chaque transition, 18/tour), bits 0-6 compteur de pédalage 1..127 ; `f46[2]` = octet 1 capteur : bits 7-2 température, bits 1-0 couple bits 9-8 |
| `f46[3..4]` | | `est` u16 LE = T_roue/2 en LSB 2 ms (= `tickRaw` en FIX ; ≥ 1750 = 0 km/h) | `f46[3]` = couple bits 7-0 (couple 10 bits = `((f46[2]&3)<<8)|f46[3]`) ; `f46[4]` = **valeur de page** |
| `f46[6]` | | bits 0-3 `n_bad` mod 16, bits 4-7 étendue/8 | bits 0-3 `n_bad`, bits 4-7 **index de page** |
| `f46[7..8]` | | période stock brute `speed_bike` (repliement > 30 km/h) | `Hall_Speed` u16 LE |
| `f46[9..10]` | courant moteur u16 LE (`AV_Current_FB` × 2,5 — unité à étalonner : `RD45_CUR_K` en tête de script, `null` = brut) | | |
| `f46[13]` | couple net TX22 = (couple − zéro) ≫ 4 | | |

Pages v4 (`F46_PAGES`, table éditable, layout figé le 2026-09-21) : 0 `V_Dc≫4` (affiché aussi
en **≈ V** : ×16 / 46,8, à comparer à la tension display), 1 `POT_temp≫4`, 2-4 drapeaux
(`flags0` b24-31, `flags1` b16-23, b0-7 — affichés en binaire **avec le nom des bits posés**),
5 `speed_limit_current≫4` (600 = bride, 1800 = plein), 6 `data_lj_zero≫2` (zéro couple appris),
7 étendue max-min des 16 dernières périodes (205 µs, saturé 255), 8 température contrôleur,
9 Δ compteur cadence sur 10 trames, 10-11 réservé, **12 `system_state_lj_flag`** (bit 0 zéro
couple acquis, **bit 2 capteur de couple défaillant** — latché, le contrôleur bascule
silencieusement sur l'assistance à la cadence), 13-15 réservé. Une page toutes les ~130 ms →
chaque page ≈ toutes les 2 s : le dashboard garde la **dernière valeur de chaque page avec
son âge** (tuile de 13 lignes).

Bits nommés (RE `chantier-rd45-firmware/analyses/codes-erreur-kzqwa56.md`) — page 2 :
b1 surchauffe NTC (flags0.b25), b2 TRAP étage de puissance (b26), b3 surtension (b27), b4
sous-tension (b28) ; page 3 : b2 poignée (flags1.b18), b4 comm display (b20, jamais posé),
b5 capteur vitesse (b21, **silencieux**, jamais lu par le stock), b6 frein au démarrage
(b22), b7 Hall moteur (b23) ; page 4 : b2 **blocage rotor** (flags1.b2, silencieux), b5
jamais posé.

Codes `err` (octet 5 de la 0x43) en STOCK + RD45, tuile « Erreurs » = « code N — libellé »
(`RD45_ERR`) : 1 surchauffe (inatteignable en V1.0.1), 2 TRAP étage de puissance, 4 poignée,
5 frein au démarrage, 8 sous-tension, 9 surtension, 10 Hall moteur, 11 comm display (jamais
posé), 14 phase / 12 V (mort). Tout code ≠ 0 pendant 3 s → moteur coupé et redémarrage
refusé. Échelles **déduites, à étalonner** : `V_Dc` ≈ 46,8 counts/V (`RD45_VDC_K`),
TX18-19 ≈ 1 118 counts/A (2,5 × 447, `RD45_CUR_K_DED`) — la tuile « Courant moteur »
affiche « ≈ A déduit » tant que `RD45_CUR_K` est `null`.

Vitesses : `4293/p` et `3960/est` km/h pour 2,2 m (`RD45_PERIM`) ; le display applique **sa**
circonférence (≈ 2,11 m sur le vélo de test du 21/09 → `spdX10` ≈ 0,96 × 3960/est). `est` et
`tickRaw` viennent de deux trames (0x46 relayée à 2 Hz, 0x43 à 5 Hz) : ±1 tick d'écart est
normal en roulant.

Tuiles (visibles **seulement en STOCK + preset RD45**, les « v4 » seulement avec le patch ≥ 4) :
« Patch » (stock / DIAG v3 / FIX v3 / FIX v4), « Vitesse capteur » (v3 : 4293/p, avec est,
stock et display ; v4 : 3960/tickRaw), « Rejets capteur » (changements de `n_bad` par minute
glissante), « Courant moteur » (≈ A déduit à 1 118 counts/A + brut, ou A si `RD45_CUR_K` est
renseigné), « Couple net »,
« Couple 10 bits », « Cadence capteur » (impulsions/s sur 2 s + Δ page 9), « Roue libre »
(bascules/s), « Temp. capteur », « Hall (RD45) » (Hall_Speed et rapport par km/h), « Pages du
patch » (10 lignes valeur + âge). La tuile « Trame 0x46 » garde l'hex et ajoute la version
(et « somme KO » si la somme de contrôle est fausse).

## Fiabilité sur Android (2026-09-21)

- **Wake lock écran** (`navigator.wakeLock`) tenu pendant tout enregistrement ou phase
  guidée, ré-acquis quand la page redevient visible, relâché à l'arrêt. Sans lui, l'écran
  s'éteint, Chrome passe la page en arrière-plan et **les notifications BLE ne sont plus
  livrées qu'en rafale au réveil** (run route du 21/09 : 2 030 lignes sur 2 363 reçues en
  0,75 s après un trou de 576 s). Ignoré si l'API est absente (Bluefy…).
- **Reconstruction du temps** : le 0x04 porte un compteur `seq` u8 à 5 Hz (200 ms). Quand
  deux 0x04 arrivent à moins de 50 ms, la ligne reçoit `t = t_précédent + 200 × Δseq`
  (mod 256), `tr` = 1 et sa réception réelle dans `ta`. La première ligne d'une rafale porte
  tout le trou : elle y est rattachée après coup, et **toute la rafale est ré-ancrée sur la
  réception de sa dernière ligne** (le paquet le plus récent = temps réel) — sinon elle se
  placerait après la fin réelle. Une rafale ne se clôt qu'après 3 paquets consécutifs revenus
  au rythme nominal (la livraison a des hoquets de ~240 ms) ; moins de 5 lignes = gigue BLE,
  rendues à leur temps de réception. Δseq étant modulo 256, une perte de plus de 51 s est
  invisible : la rafale est alors **compressée** (sur le run du 21/09, 2 043 lignes = 410 s
  reconstruites pour 576 s de trou), jamais décalée dans le futur. Le statut
  d'enregistrement affiche « ⚠ rafale de N s reconstruite » dès qu'une rafale > 5 s a été
  reconstruite. Rejeu : `node tools/dryrun-r.js index.html <run.jsonl>`.
- **GPS** : `watchPosition` haute précision pendant l'enregistrement (demande d'autorisation
  au premier ● Enregistrer) ; champs `gpsX10` / `gpsAcc` (voir « Format JSONL ») et tuile
  « GPS » (vitesse GPS, écart display / GPS en %, précision). Rien si refusé ou indisponible.

## Version mobile (sortie route)

Hébergée en HTTPS sur **GitHub Pages** : https://syklofr.github.io/syklo-z8-dashboard/
(repo public `SykloFR/syklo-z8-dashboard`, poussé depuis ce `index.html`).

- **Android : Chrome** (Web Bluetooth OK). Firefox ne supporte PAS Web Bluetooth.
- **iPhone** : navigateurs iOS ne supportent pas Web Bluetooth → app **Bluefy**.
- Niveau d'assist + mode lus du paquet SykloConnect **0x01** (~2 s), pas du 0x04.
- Workflow sortie : Connecter → ● Enregistrer → rouler → ■ Stop → Télécharger
  JSONL → déposer dans `bench/logs/`. Sous charge réelle, les niveaux se
  différencient (à vide ils saturent tous).
- Une seule connexion BLE à la fois : couper SykloConnect avant.
- Mise à jour de la page : éditer `index.html` **dans ce dépôt**, puis
  `git push origin master`.

## Protocole de test guidé (section « Protocole de test guidé » de la page)

Phases A/B/C (mode banc, OSF), S (pédalage, stock ou OSF) et R (capteurs RD45 en stock,
roue en l'air), chacune lançable seule. L'enregistrement JSONL démarre
automatiquement au lancement et se télécharge automatiquement à la fin (champ `stp`
= étape). Chaque étape affiche l'instruction, le temps restant de l'étape et le
temps total restant ; le chrono d'une étape ne part que lorsque l'opérateur fait
ce qui est demandé (pédaler, accélérer…).

### Phase A — moteur à blanc (~4 min, chaîne DÉPOSÉE)

Diagnostic rapide avant montage. Le moteur est poussé loin mais à vide.

| Étape | Durée | Ce qu'on vérifie |
|---|---|---|
| A1 Capteurs au repos | 20 s | offset couple 120-250 et stable, courant nul, aucune erreur |
| A2 Couple & cadence | 30 s | le capteur de couple répond (delta), la cadence compte |
| A3 Démarrages ×6 | 60 s | le moteur repart à chaque fois, et s'arrête entre chaque |
| A4 Montée L1→L5 | 50 s | courant croissant avec le niveau |
| A5 Haut régime | 30 s | ERPS max ≥ 230 (baseline 276), aucune erreur hall |
| A6 Sprints ×3 | 30 s | rampes rapides, courant ≤ plafond, la régulation tient |

### Phase B — banc en charge (~6 min, chaîne + home trainer)

Caractérisation globale. **La résistance du trainer est pilotée automatiquement**
(FTMS Control Point 0x2AD9 — Request Control, Start, Set Target Resistance) ; si le
contrôle n'est pas disponible, l'instruction affiche la consigne à régler à la main.
La résistance passe **au maximum dès la 3e étape** : sur un trainer ~600 W on sature
vite, et sans charge maximale le moteur tourne vite mais ne force pas.

| Étape | Durée | Résistance | Ce qu'on vérifie |
|---|---|---|---|
| B1 Mise en place | 15 s | 30 % | repos propre, tension de référence (pour le sag) |
| B2 Palier modéré | 60 s | 50 % | Pbatt/Proue cohérents, ratio stable |
| B3 Couple maximal | 60 s | **100 %** | courant proche du cap 23 A, pas d'E07, sag mesuré |
| B4 Pic de puissance | 25 s | **100 %** | Pbatt max (≥700 W attendu en 48V) |
| B5 Endurance | 90 s | 80 % | dérive du courant < 25 % sur 90 s |
| B6 Coupure nette | 15 s | 50 % | temps duty→0 après arrêt du pédalage (over-run) |

Verdict par étape (OK / ATTENTION / ÉCHEC) + « Copier le verdict » (JSON avec la
config moteur du paquet 0x05). Le mode ERG n'est **jamais** utilisé : sa double
boucle de régulation masque les écarts entre moteurs (cf. étude banc).

### Phase C — pédalage humain (~4 min, chaîne + home trainer, mode normal)

La chaîne d'entrée (capteur de couple → loi des niveaux → régulation). Références `REFC`
(run sain 29/07 14:39, provisoire) ; verdicts recalculables sans moteur avec
`node tools/replay-c.js index.html <run-protoC.jsonl> --cfg '{"mode":4,"aT":[…],"aP":[…]}'`.

| Étape | Ce qu'on vérifie | Verdict |
|---|---|---|
| C0 | offset couple, assistance fantôme, tension | absolus |
| C1a-c | profil capteur : pédalage tranquille (zone morte : delta médian ≥ 8), attaques (delta max vs réf 160), moulinage force faible | absolus + info |
| C1d | retour à zéro (dérive > 15 = hystérésis) ; **corrélation couple↔roue sur tout C1** : ATT si r < `REFC.c1corrAtt` (0,25 — sains 0,33-0,61) | étalonné 2026-09-11 |
| C2L1-5 | courant, à-coups (> 30 %), maintien (< 60 %), absence d'assistance ; le **ratio absolu** courant/(delta×cadence) est informatif (il dépend du preset) ; au niveau 5, la **progression 1→5** doit suivre la loi du preset (aT torque / aP power / la mieux suivie en hybrid) à ±25 % | progression vs loi |
| C2p | réponse aux pics (gain, latence, répétabilité) | info |
| C3 | over-run à la coupure (> 1 s = ATT), montée | réf 0,1 s |

Comparable uniquement à conditions égales (firmware moteur, preset display, street, batterie).

### Phase S — caractérisation niveau × vitesse en pédalage (stock OU OSF)

Constitue la base « loi d'assistance » d'un firmware (stock Tongsheng à répliquer sous
OSF). **Aucun mode banc, aucune trame envoyée au display** : c'est l'opérateur qui est
piloté. Spec : `chantier-z8-osf/specs/protocole-S-caracterisation-stock.md` (**v4** du
2026-09-24, section en tête — la v3 s'est révélée intenable au 1er banc réel).

**v4 en bref** : mode **séance** par défaut, soit un seul run d'environ 12 min pédalées.
Étalonnage L0 à 20 km/h en **résistance 40 / 70 / 100 %** (plus d'ERG : il part en
spirale à basse cadence), puis L1→L5 à la charge du panneau (résistance 100 %) sur les
paliers **20 et 14 km/h**, la traversée de coupure en L5 (option), et enfin un L0 de
contrôle. Palier = **20 s cumulées** dans ±1,5 km/h au bon niveau : sortir de la bande
exclut les échantillons sans rien remettre à zéro. Un échantillon compte après 1,5 s dans
la bande et 4 s après le début du palier, 90 s max. Le BMS JBD se **reconnecte seul**.
Fichier `…_banc-protoS-seance.jsonl`. Les modes « un niveau » et « étalonnage L0 seul »
servent à refaire un morceau. Rodage à blanc : `node tools/dryrun-s.js index.html sortie.jsonl [seance|dyn]`.

**Circonférence = celle RÉGLÉE AU DISPLAY** (banc Syklo : **2 300 mm**, vérifié sur les runs OSF :
cad/v = 2,30 rpm par km/h en 44/14). Les runs du 2026-09-24 matin portent 2 050 : dépouiller avec
`--circ 2300`. Une erreur de circonférence fausse les N·m et les rpm, **pas** les gains ni `pbat`.

**Mode loi : charge × vitesse** (2026-09-24 soir). Il sert à extraire la loi du stock sur toute
la plage de puissance pédale. Au labo, le même firmware passait à 100 W pédale et échouait à
150 W ; au banc maison, la loi est linéaire entre 20 et 80 W. À l'équilibre, ta puissance pédale
est imposée par la charge, la vitesse et la loi : on balaie donc les **charges** (`r40,r100,g5` =
résistance 40 %, 100 %, pente 5 % ; le D100 accepte la pente, vérifié en FTMS) aux **vitesses**
20 et 30 km/h, sur les **niveaux** choisis (`1,2,3` puis `4,5`). Le run commence par une ancre L0
(résistance 70 % à 20 km/h, contrôle de dérive de l'étalonnage fait en séance). Il se fait **en
débridé** (street OFF) pour dépasser 25 km/h ; confirmation demandée si street est ON. Fichier
`…_banc-protoS-loi.jsonl`. Le dépouillement `protoS-report.py` (avec les séances, qui portent
l'étalonnage) produit une section **LOI** :
- par niveau, un ajustement linéaire (a·P + b) et un ajustement en puissance (c·P^α) ;
- une loi **normalisée par Gear assist** (les niveaux se superposent-ils ?) ;
- une extrapolation au point de certification (150 W pédale), comparée au labo ;
- un contrôle de dépendance à la cadence ;
- le plafond Gear_current × 23 A, signalé quand il est atteint.
Paramètres du modèle : `--gear-assist`, `--gear-current`, `--imax` (défaut : prod V3.6.5 48 V).

**Modèle Tongsheng identifié** (prod V3.6.5 48 V, tableau « Gear parameters » lignes 110-115) :
- **Gear_current × 23 A = plafond de courant batterie du niveau.** Il est atteint en ~1 s au
  départ arrêté : 6,4/11,9/14,2/16,4/23,3 A mesurés, pour 6,9/11,5/13,8/16,1/23 A.
- **Gear assist = gain proportionnel** : P_assist(roue) = 3,28 × Gear assist × P_pédale entre
  20 et 80 W (α = 1,00, niveaux superposés à ±3 %).
- Le display affiche le courant **phase** : les « 23 A dès L3 » lus au display valent 14 A batterie.

**Mode dynamique** (ajouté le 2026-09-24 après la séance 2 : départ arrêté en L5 = 40 A phase /
~900 W batterie en 1 s, 0 → 39 km/h ; coupure street franche vers 26-27 km/h avec pic au
réengagement ; micro-coupures de 0,4-0,7 s suivies d'une surintensité). À chaque niveau 1→5 :
**départ arrêté** (arrêt ≥ 2 s, bip, effort franc et constant jusqu'à 20 km/h, 3 s d'observation
du dépassement) puis **2 reprises** à 16 km/h (bip : « poussez plus fort » 3 s, 2ᵉ bip : effort
normal 5 s). L'effort n'étant pas imposé, une **cible de couple** s'affiche (départ : repos + 60 ≈ 29 Nm ;
reprise : base + **10** ≈ +5 Nm, pour rester SOUS le plafond Gear_current, sinon k mesure le plafond), verte à ±6 : même effort à tous les niveaux et d'un firmware à l'autre. Marqueur `sph` dans le JSONL (`stop/go/after/settle/push/rel/stair`). Option coupure
street **en escalier 22 → 27 km/h au niveau 2** (au niveau 5 le gain ~4,5 empêche de monter palier
par palier). Run **débridé** (street OFF) : plage complète de puissance ; l'étape coupure attend que le street soit remis ON. Arrêt détecté sur le **volant du trainer** (le display affiche 0 dès ~6 km/h) ; verdicts calculés sur la vitesse trainer ramenée à l'échelle du display (× 1/0,917, rapport réappris en continu). Fichier `…_banc-protoS-dyn.jsonl`. Dépouillement : `python tools/protoS-dyn.py
<fichiers>` : départs (retard du courant, 0 → 15 km/h, pics cur / batt / roue, v max), accélérations
14 → 20 km/h des séances, reprises (k = Δcur / Δcouple, la « nervosité »), coupures et réengagements
jugés **en poussant** (couple ≥ repos + 8). La **vitesse du trainer** (`tspd`, FTMS ~6 Hz, le D100
ne diffuse pas de cadence) est enregistrée : celle du display est lissée et se fige 1-3 s à l'arrêt.

Principe : à **charge figée** (consigne du panneau « Home trainer », résistance 100 % en
série 1 — jamais ERG pour les niveaux assistés, la vitesse s'emballerait) et à vitesse
égale, la puissance roue `pmeca` est la même quel que soit le niveau : seul le partage
cycliste/moteur change. La **vitesse** est la grandeur pilote : à braquet fixe elle vaut
exactement une cadence (`cadEst`, tuile « Cadence estimée » — 44/14 × 2 300 mm (réglage du
display) → 2,306 rpm par km/h : 14 km/h = 32, 20 = 46, 25 = 58 rpm).

| Mode | Étapes | Ce qu'on obtient |
|---|---|---|
| **Séance** (défaut) | L0 : 20 km/h × résistance 40 / 70 / 100 % → L1…L5 : paliers 20 et 14 km/h à la charge du panneau → coupure 20 → 26 km/h en L5 (option) → L0 de contrôle | tout d'un coup, ~12 min pédalées ; chaque étape « niveau X » attend le display = pause |
| **Un niveau** | étape « niveau X au display » puis les paliers de la liste ; option coupure | refaire un niveau |
| **Étalonnage L0 seul** | L0, charges du champ (résistance %, ou `150W` = ERG) à la vitesse du champ | à L0 pmeca = 100 % cycliste → couple T = P/ω connu → **étalonnage `torque` ADC ↔ N·m** (à charge fixe unique le couple L0 serait le même à toutes les vitesses : d'où plusieurs résistances) |

Palier = **20 s cumulées** dans ±1,5 km/h au bon niveau. Les échantillons hors bande sont
exclus, rien n'est remis à zéro. Un échantillon compte après 1,5 s dans la bande et 4 s
après le début du palier ; 90 s max (≥ 10 s cumulées = ATTENTION, sinon ÉCHEC). **Bip**
et avance automatique ; « Refaire le palier » / « Étape suivante ». Consigne en gros et en
couleur (vert dans la bande, orange à ±3, rouge au-delà ou mauvais niveau), ligne de vie
cadence ≈ / couple / cur / roue / batt (« ⚠ BMS MUET » si le BMS décroche).
Garde-fous : télémétrie, banc désarmé, trainer (pmeca) et contrôle FTMS, ERG hors
étalonnage, grille ≠ résistance 100 %, pack < 43 V, **stock sans BMS** (pas de pbat),
AWE sous OSF.

Campagne : street **ON** (comme vendu), charge et braquet figés, **2 séances courtes**
(jours, états de charge) ; CV(pbat) et CV(pmeca) < 10 % par palier = base validée, sinon
3ᵉ séance ou run long. Fichier `…_banc-protoS-seance.jsonl` (ou `-L<n>`, `-L0-calib`),
`stp` = palier (`S-L0-r70-v20` = résistance 70 %, `S-L3-v14`), `stb` = 1 sur les
échantillons comptés, `meta` = braquet, consigne trainer, street, médianes.

Dépouillement : `python tools/protoS-report.py <dossier ou fichiers>` (`--id`, `--csv`) —
étalonnage sur tous les L0, puis par charge et par niveau × vitesse : P_cycliste,
**P_assist = pmeca − P_cycliste**, gain, `cur`, `pbat`, η, dispersion inter-runs,
coupures. Équivalence stock ↔ OSF = mêmes paliers, même charge → même P_assist (ou pbat).
Sous OSF `cur` redevient le courant batterie et `cad` réel doit coller à `cadEst` (contrôle
du braquet saisi).

### Phase R — cycle capteurs RD45, roue en l'air (stock + patch speedfix, ~5 min)

Bouton **« ▶ Phase R — capteurs RD45 »**, actif seulement si le display est en protocole
**stock** avec le preset **RD45** (`src & 15 == 2` et `src >> 4 == 2`, sinon `alert`). Vélo
sur pied, **roue arrière en l'air**, aucun trainer ni BMS. Même mécanique que la phase S :
instruction en gros, chrono d'étape, avance automatique ou « Étape suivante », « Refaire
l'étape », `stp` = `R0`…`R7` (`R6-20` … `R6-36` pour les paliers), archivage
`…_banc-protoR.jsonl` avec le verdict dans `meta`, « Copier le verdict » (JSON). Les réglages
(niveau, Max speed, marche) se font **sur le display par l'opérateur** : chaque instruction le
dit. Champ optionnel « cadence R2 » (rpm) → impulsions par tour du compteur capteur (v4).
Un critère qui n'existe qu'en patch v4 donne **« n/a (patch < v4) »** en v3 ou stock, jamais KO.

| Étape | Durée | Consigne | Verdict |
|---|---|---|---|
| **R0** Repos | 15 s | ne rien toucher | vitesse 0, `p` = 4500 / `est` ≥ 1750, TX22 = 0, `torque` stable (σ < 1), `err` = 0, 0 rejet ; v4 : Hall_Speed = 0, pages 2-4 = 0, **drapeaux silencieux** à 0 (page 4 b2 blocage rotor, page 12 b2 capteur de couple, page 3 b5 capteur vitesse — sinon KO nommé) |
| **R1** Pédales en arrière | 15 s | niveau 0, manivelles en arrière lentement | v4 : roue libre bascule ≥ 5 fois **et** compteur cadence net ≤ 1 → « capteur cassette : sens OK » |
| **R2** Pédalage à vide | 20 s | niveau 0, ~60 tr/min sans forcer | TX22 < 3 ; v4 : compteur monotone (mod 127) → impulsions/s (+ par tour si cadence saisie), roue libre bascule, Hall_Speed = 0 |
| **R3** Appui pédale | 25 s | niveau 0, frein arrière serré, 3 × 3 s d'appui fort | 3 montées TX22 ≥ 8 et retour à 0 < 1 s après relâché ; v4 : couple 10 bits ≥ +100 sur le repos → « capteur de couple OK » |
| **R4** Marche | 20 s (chrono dès 2 km/h) | maintenir la marche (walk assist) du display | vitesse 3-8 km/h, TX18-19 > 0, `err` = 0 ; v4 : Hall_Speed > 0 et Hall/km/h stable (CV < 5 % sur 10 s) → « Hall + moteur OK » |
| **R5** Démarrages ×6 | 60 s | niveau 1, 3 s pédalés / 5 s d'arrêt × 6 | démarrage = TX18-19 > 1000 dans la seconde après TX22 ≥ 4 ; arrêt = TX18-19 < 500 dans les 2 s après TX22 < 2 ; n/6 (OK 6/6, ATTENTION ≥ 3) |
| **R6** Paliers Max speed | 4 × 20 s (chrono dès 5 km/h) | niveau 2, Max speed **20, 25, 32, 36** réglé sur le display, pédaler doucement | sur les 10 dernières s : CV vitesse < 3 %, vitesse ≈ 1,1 × Max speed ± 2 km/h, étendue / p < 15 %, rejets < 2 ; v4 : rapport Hall ± 5 % du palier précédent ; info v3 : période stock vs `est` (repliement > 30) |
| **R7** Arrêt / reprise | 20 s | depuis le palier 36 : arrêter, laisser ralentir, freiner, repédaler | v3 : `est` ≥ 1750 ≤ 2 s après `p` = 4500 ; à la reprise `est/p` entre 0,85 et 1,0 dès la 3ᵉ ligne → « timeouts OK » (v4 : jugé sur `tickRaw` du 0x04, = `est` en FIX : ≥ 1750 dans les 3 s après la dernière ligne > 4 km/h, puis reprise sans saut > 40 % sur 6 lignes) |

Verdict final **par organe** : cassette/cadence, capteur de couple, capteur de vitesse,
Hall + moteur, chaîne couple → courant, timeouts, UART/erreurs (`ckErr` / `commErr`
inchangés et `err` = 0 sur tout le run, code RD45 nommé sinon), **drapeaux silencieux**
(v4 : les trois bits ci-dessus à 0 en R0 **et sur tout le run**, l'étape où un bit a été vu
est nommée ; v3 : n/a) — OK / ATTENTION / ÉCHEC / n/a + le chiffre mesuré,
et pour chaque ÉCHEC « ce que le prochain run doit vérifier ». Rodage à blanc sur un RD45
simulé (v3 et v4) : `node tools/dryrun-r.js index.html`.

### E08 et assist-with-error (phase A)

Chaîne déposée, la roue ne tourne jamais → **E08 (capteur vitesse) est inévitable**
dès que le moteur tourne assez longtemps, et sans contre-mesure il coupe
l'assistance et bloque le test (constaté au banc le 2026-07-24).

**Le mode doit être activé À LA MAIN, au menu du display**, avant la phase A :
`Assist > Assist with error > enable`. Le dashboard le **lit** (paquet 0x02,
octet 10 bit 1), l'affiche dans une tuile, et **refuse de lancer la phase A**
tant qu'il n'est pas actif. E08 est alors **toléré** par les verdicts de la
phase A (les autres erreurs restent bloquantes). En phase B (roue entraînée par
le trainer), E08 ne doit pas apparaître : sa présence est signalée en ATTENTION.

### 🔴 Pourquoi le dashboard n'écrit RIEN en BLE

Une version antérieure activait ce mode par commande BLE (`[15,0,1]` sur NUS RX).
**C'était la cause du `err06` constaté au banc le 2026-07-24.** Toute commande BLE
arme une écriture EEPROM 500 ms plus tard, et `flash_write_words()` appelle
`wait_gc()` qui **boucle en bloquant jusqu'à 1000 ms** :

```c
for (volatile int count = 0; count < 1000 && !gc_done; count++) {
    sd_app_evt_wait(); nrf_delay_ms(1);      // eeprom_hw.c
}
```

Pendant ce blocage le display n'émet plus rien vers le moteur, qui lève
`ERROR_FATAL` après ~750 ms sans communication (`comm_error_counter > 30`) —
affiché **err06**. La commande censée éviter l'arrêt du test le provoquait.

**Le dashboard est donc en lecture seule vis-à-vis du display.** Les seules
écritures BLE restantes vont au home trainer, appareil distinct, sans effet sur
la liaison display↔moteur.

⚠️ Le mode **persiste en EEPROM display** et serait dangereux sur route
(assistance maintenue malgré une erreur) : le panneau de fin de phase A rappelle
de le **redésactiver** avant de rouler.

### Séquence recommandée avant la phase A

1. Menu display : `Assist with error` → **enable**
2. **Couper la batterie**, rallumer — la sortie de menu écrit l'EEPROM et peut
   elle-même provoquer un `err06` ; le power-cycle repart d'un état propre et
   efface les erreurs mémorisées
3. Connecter le dashboard, vérifier la tuile « Assist w/ error » = ACTIF
4. Lancer la phase A

### Codes d'erreur — décodage réel (chemin Z8-OSF)

⚠️ **« err06 » n'est PAS une surchauffe.** Le TSDZ8 n'a pas de sonde de température.
Le SW102 affiche `err06` pour le bit 5 du bitfield moteur, qui est `ERROR_FATAL` —
partagé par trois causes distinctes.

| Bit | Code affiché | Signification réelle |
|---|---|---|
| 0x01 | — | moteur non initialisé (attente de la config) |
| 0x02 | err02 | capteur de couple |
| 0x04 | err03 | capteur de cadence |
| 0x08 | err04 | moteur bloqué |
| 0x10 | err05 | accélérateur |
| **0x20** | **err06** | **FATAL** : communication perdue (> 750 ms), sous-tension, ou « moteur tourne seul » (patch P09) |
| 0x40 | err07 | surintensité |
| 0x80 | err08 | capteur de vitesse |

⚠️ **Les erreurs sont cumulatives et ne s'effacent jamais.** Le firmware fait `|=`
et ne remet à zéro que `ERROR_NOT_INIT` : une erreur reste mémorisée jusqu'à la
**coupure de l'alimentation du moteur**. Redémarrer le display ne suffit pas — pire,
le redémarrage du display coupe la communication > 750 ms et **provoque lui-même**
un `err06`.

**Conséquence pratique** : entre deux tests, couper la batterie, pas le display.
Le dashboard refuse désormais de lancer un protocole si une erreur est déjà
mémorisée (E08 excepté en phase A) et affiche laquelle.

### Watchdog télémétrie

Le `gattserverdisconnected` ne part pas toujours quand le display redémarre
(constaté au banc). Le dashboard surveille donc le flux 0x04 : après 5 s sans
paquet, le bouton repasse en « Reconnecter (BLE) » ; pendant un test, le chrono
de l'étape est **mis en pause** et un bandeau demande la reconnexion.
