# syklo-z8-dashboard — Télémétrie bench Z8-OSF (Web BLE)

**Ce dépôt est la SOURCE UNIQUE de la page.** Toute modification se fait ici, puis
`git push origin master` : GitHub Pages republie automatiquement sur
https://syklofr.github.io/syklo-z8-dashboard/ (1 à 2 min).

Le chantier `Dev-Agent-Syklo/chantier-z8-osf/tools/ble-dashboard/` ne contient plus
qu'un pointeur vers ce dépôt — il n'y a plus de copie à synchroniser.

---

Page unique (`index.html`, zéro dépendance) qui se connecte au SW102 en Web
Bluetooth (service NUS) et affiche en live le **paquet 0x04** du firmware
2.18.0-z8osf : ADC torque brut + delta, cadence, duty, ERPS, FOC, courant ADC,
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

1. « Enregistrer » avant un run → « Stop » → « Télécharger JSONL » →
   déposer le fichier dans `chantier-z8-osf/bench/logs/` → Claude l'analyse.
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

⚠️ Le ratio **n'est PAS le rendement du moteur** : la puissance à la roue inclut
l'apport du cycliste. Pour approcher un rendement, il faut soustraire une mesure
de référence faite au même braquet et à la même vitesse, assistance coupée.

Un garde-fou ignore les valeurs hors [0, 3000] W (trames partielles au démarrage).

## Format JSONL

`{t, seq, torque, delta, cad, duty, erps, foc, cur, voltX10, err, hall, spdX10, pow, pmeca, src}`
(t = epoch ms ; valeurs brutes firmware, tension = voltX10/10 V,
vitesse = spdX10/10 km/h ; `pow` = puissance batterie W, `pmeca` = puissance roue W,
`null` si le trainer n'est pas connecté ; `src` = octet 19 du 0x04, `null` si
display < 2.18.10 — voir section suivante.)

## Moteur en firmware STOCK Tongsheng (display ≥ 2.18.10)

Un moteur resté en firmware stock (TSDZ8/RD45) remonte quand même une télémétrie
exploitable : l'octet 19 du 0x04 (nouveau) déclare la source — bits 0-3 =
protocole **détecté** par le display (0 aucun, 1 OSF/mbrusa, 2 stock Tongsheng),
bits 4-7 = motor_version configuré. Recopié dans chaque ligne JSONL (`src`).

En stock, le display remplit le 0x04 depuis la trame native 9 octets :

| Champ | En stock |
|---|---|
| `torque` | **signal couple brut Tongsheng** (octet 3 de la trame) — échelle et offset ≠ ADC OSF (le repère « vide 120-250 » ne s'applique pas) |
| `cur` | courant batterie, **converti à la même unité que l'OSF** (0,16 A/LSB → ×0,16 = A, formules inchangées) |
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

Deux phases **découplées**, chacune lançable seule. L'enregistrement JSONL démarre
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
