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

`{t, seq, torque, delta, cad, duty, erps, foc, cur, voltX10, err, hall, spdX10, pow, pmeca}`
(t = epoch ms ; valeurs brutes firmware, tension = voltX10/10 V,
vitesse = spdX10/10 km/h ; `pow` = puissance batterie W, `pmeca` = puissance roue W,
`null` si le trainer n'est pas connecté.)

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
