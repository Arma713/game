# 🌡️ Volet Malin

Application web (installable comme app mobile) qui te dit **quand ouvrir ou fermer tes volets** pour garder une température intérieure agréable, été comme hiver.

---

## Sommaire

- [Ce que fait l'app](#ce-que-fait-lapp)
- [Comment fonctionne la recommandation](#comment-fonctionne-la-recommandation)
- [Connecter thermomètres et volets (Home Assistant)](#connecter-thermomètres-et-volets-home-assistant)
- [Notifications](#notifications)
- [Structure du projet](#structure-du-projet)
- [Tester en local](#tester-en-local)
- [Installer comme app mobile (PWA)](#installer-comme-app-mobile-pwa)
- [Déployer en ligne](#déployer-en-ligne)
- [Personnaliser](#personnaliser)
- [Limites connues](#limites-connues)
- [Stack technique](#stack-technique)

---

## Ce que fait l'app

1. Tu donnes ta position (géolocalisation) ou le nom de ta ville.
2. L'app récupère la météo heure par heure via [Open-Meteo](https://open-meteo.com/) (gratuit, sans clé API).
3. Tu renseignes ta température intérieure actuelle et ta plage de confort (ex. 19–24°C).
4. L'app te dit immédiatement s'il faut **fermer** ou **ouvrir** tes volets, avec l'explication.
5. Une frise des **24 prochaines heures** met en évidence les moments où changer d'avis (ex. "Fermer vers 11h", "Ouvrir vers 21h").

Si la géolocalisation ou la météo automatique échoue (pas de réseau, permission refusée...), un **mode manuel** prend le relais : tu entres toi-même la température extérieure et si c'est le jour ou la nuit.

## Comment fonctionne la recommandation

La logique (dans `getRecommendation()` de `app.js`) compare température extérieure, température intérieure, plage de confort et moment de la journée :

**Le jour :**
- Extérieur plus chaud que ta plage de confort → **fermer** (bloque la chaleur et le rayonnement solaire)
- Extérieur plus frais que ta plage de confort → **ouvrir** (profite du soleil pour réchauffer la pièce)
- Extérieur dans la plage → **ouvrir** (profite de la lumière naturelle)

**La nuit :**
- Extérieur plus frais que ta plage de confort → **fermer** (limite les pertes de chaleur, isolation)
- Intérieur plus chaud que ta plage ET extérieur plus frais qu'intérieur → **ouvrir** (aère et rafraîchit la maison)
- Sinon → **fermer** (isolation nocturne par défaut)

C'est le même raisonnement qu'on applique intuitivement l'été (fermer les volets la journée, ouvrir la nuit pour rafraîchir) et l'hiver (ouvrir au soleil, fermer la nuit pour garder la chaleur).

## Connecter thermomètres et volets (Home Assistant)

L'app peut se brancher sur [Home Assistant](https://www.home-assistant.io/), la plateforme domotique open source qui fédère la plupart des thermomètres connectés (Zigbee, Bluetooth, Netatmo…) et des volets roulants (Somfy/TaHoma, Legrand, modules Zigbee…).

Une fois connectée :

- **Thermomètre intérieur** : la température intérieure de l'app est lue automatiquement depuis le capteur choisi (rafraîchie toutes les 5 minutes), plus besoin de la saisir.
- **Volets** : boutons *Ouvrir* / *Fermer* pour piloter les volets cochés, et bouton **Appliquer la recommandation** qui exécute directement le conseil affiché (fermer → ferme les volets, ouvrir → les ouvre).

### Mise en place

1. Tes appareils doivent déjà être intégrés à Home Assistant (les volets apparaissent comme des entités `cover.*`, les thermomètres comme `sensor.*` en °C).
2. Dans Home Assistant : profil → onglet **Sécurité** → **Jetons d'accès longue durée** → **Créer un jeton**.
3. Dans l'app, carte **Maison connectée** : colle l'adresse de ton Home Assistant et le jeton, puis **Connecter**.

### Points d'attention

- **HTTPS** : si l'app est servie en HTTPS (Netlify, GitHub Pages…), l'adresse Home Assistant doit aussi être en HTTPS (ex. lien Nabu Casa `https://xxxx.ui.nabu.casa`) — les navigateurs bloquent les appels HTTP depuis une page HTTPS. En local (`http://localhost`), une adresse HA locale en HTTP fonctionne.
- **CORS** : Home Assistant doit autoriser l'origine de l'app. Ajoute dans `configuration.yaml` :
  ```yaml
  http:
    cors_allowed_origins:
      - https://ton-app.netlify.app
  ```
- **Jeton** : il est stocké uniquement dans le navigateur de ton appareil (localStorage), jamais envoyé ailleurs qu'à ton Home Assistant. Ne l'utilise pas sur un appareil partagé ; tu peux le révoquer à tout moment depuis ton profil HA.

## Notifications

Le bouton **🔔 Activer les notifications** programme une alerte au moment exact où la recommandation bascule (ex. "Fermez vos volets 🌡️" quand la chaleur arrive), calculée d'après les prévisions des prochaines 48 h. La carte affiche la prochaine alerte prévue.

Deux mécanismes complémentaires (sans serveur — l'app est 100 % statique) :

- **App ouverte ou en arrière-plan** : minuterie interne calée sur les transitions des prévisions, re-programmée à chaque rafraîchissement météo.
- **App fermée** (Chrome/Android, app installée) : *Periodic Background Sync* — le service worker revérifie la météo environ toutes les heures et notifie si la recommandation a changé depuis la dernière alerte. Les deux canaux se déduplique via un instantané partagé en IndexedDB.

Limites honnêtes :

- **iPhone/iPad** : notifications disponibles uniquement pour l'app **installée sur l'écran d'accueil** (iOS 16.4+), et pas de vérification en arrière-plan app fermée (le Periodic Background Sync n'existe pas sur iOS). L'alerte partira si l'app est ouverte ou en arrière-plan récent.
- La fréquence du Periodic Background Sync est décidée par le navigateur (selon l'usage du site) — l'heure de l'alerte app fermée est approximative.
- Une fiabilité totale app fermée nécessiterait un serveur de push (Web Push + VAPID) — possible en ajoutant un petit backend plus tard.

## Structure du projet

```
game/
├── index.html          Page principale (structure + balises PWA)
├── style.css            Styles (thème clair/sombre automatique)
├── app.js                Logique métier, appels météo, PWA
├── manifest.json         Manifeste de l'app installable
├── sw.js                 Service worker (cache hors-ligne)
└── icons/                Icônes de l'app (72px → 512px + maskable)
```

Aucune dépendance, aucun build : ce sont des fichiers statiques purs (HTML/CSS/JS vanilla).

## Tester en local

```bash
cd game
python3 -m http.server 8000
```

Ouvre `http://localhost:8000` dans ton navigateur. `localhost` compte comme un contexte sécurisé, donc le service worker s'enregistre et tu peux vérifier le manifeste dans **DevTools → Application**.

⚠️ Depuis un autre appareil (ton téléphone) sur le même Wi-Fi via l'IP locale (`http://192.168.x.x:8000`), le service worker et le bouton d'installation **ne fonctionneront pas** : il faut du HTTPS (voir plus bas).

## Installer comme app mobile (PWA)

Une fois l'app servie en HTTPS (voir [Déployer en ligne](#déployer-en-ligne)) :

- **Android / Chrome** : un bandeau "Installer" apparaît automatiquement en haut de l'app. Un appui suffit.
- **iOS / Safari** : le bandeau indique la marche à suivre : bouton **Partager** (icône carrée avec une flèche) → **Sur l'écran d'accueil**.

Une fois installée, l'app s'ouvre en plein écran comme une vraie application, avec sa propre icône. Le shell de l'app (HTML/CSS/JS/icônes) reste disponible hors-ligne grâce au service worker ; seule la récupération de la météo nécessite une connexion.

## Déployer en ligne

Deux options simples pour obtenir une URL HTTPS publique :

**Netlify Drop (le plus rapide, sans compte)**
1. Va sur https://app.netlify.com/drop
2. Glisse-dépose le dossier `game`
3. Récupère l'URL générée (ex. `random-name.netlify.app`) et ouvre-la sur ton téléphone

**GitHub Pages**
1. Repo → Settings → Pages
2. Choisis la branche à publier (ex. `main` ou `claude/shutter-temp-optimizer-gox5zy`) et la racine `/`
3. L'app sera servie sur `https://<utilisateur>.github.io/<repo>/`

## Personnaliser

- **Couleurs / thème** : variables CSS en haut de `style.css` (`--primary`, `--close-color`, `--open-color`, etc.), avec variantes clair/sombre automatiques.
- **Plage de confort par défaut** : attributs `value` des champs `#input-min` / `#input-max` dans `index.html`.
- **Logique de recommandation** : fonction `getRecommendation()` dans `app.js`, si tu veux affiner les règles (ex. tenir compte de l'orientation des fenêtres, de l'humidité, etc.).
- **Icônes** : régénérables avec le script Pillow utilisé pour les créer (carré arrondi + lignes blanches façon volet), à adapter si tu veux un autre visuel.

## Limites connues

- La météo automatique dépend d'Open-Meteo (gratuit, sans clé, mais soumis à ses propres limites de disponibilité).
- Pas de prise en compte de l'orientation des fenêtres, de l'ensoleillement direct ou de l'humidité — uniquement la température et jour/nuit.
- Le service worker met en cache le shell de l'app mais pas les données météo (toujours récupérées en direct pour rester à jour).

## Stack technique

HTML / CSS / JavaScript vanilla, sans framework ni étape de build. API météo et géocodage : [Open-Meteo](https://open-meteo.com/) (gratuites, sans clé API).
