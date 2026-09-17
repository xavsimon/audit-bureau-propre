# Audit Bureau Propre — application locale (OCR + export Excel)

Application web (HTML/JS) pour réaliser vos audits "bureau propre" avec votre téléphone :
photo de l'étiquette d'asset → lecture **automatique** du numéro d'asset (orientation et zone de
texte détectées toutes seules), photo de l'écran de verrouillage → lecture **automatique** du nom,
puis export Excel en fin d'audit. Aucun recadrage ni rotation manuelle n'est nécessaire en usage normal.

## Confidentialité

- Tout le traitement (photos + OCR) se fait **localement dans le navigateur**, via WebAssembly
  (Tesseract.js). Aucune photo, aucun texte, aucune donnée n'est envoyée sur Internet.
- L'application ne fait **aucun appel réseau** : les bibliothèques OCR (`vendor/`) et les
  fichiers de langue (`lang/`) sont embarqués localement, ils ne sont pas téléchargés depuis un CDN.
- La liste des PC non attachés est stockée uniquement dans le stockage local du téléphone
  (`localStorage`), jamais transmise.
- Seul le fichier `.xlsx` que vous générez volontairement avec le bouton "Exporter" sort de
  l'application (vous choisissez ensuite quoi en faire : l'envoyer par mail, le stocker, etc.).

## Pourquoi il faut "servir" l'application (ne pas juste double-cliquer sur index.html)

Les navigateurs mobiles (Chrome, Safari) interdisent la création de *Web Workers* — nécessaires
à Tesseract.js pour faire l'OCR — quand une page est ouverte directement en `file://`. Il faut donc
servir les fichiers via une petite adresse locale `http://...`. Cela reste 100% local (rien ne sort
de votre réseau), ce n'est pas un serveur "sur Internet".

Deux façons simples de faire cela, au choix :

### Option A — Depuis un PC (le plus simple si vous avez déjà Node.js, par ex. via VS Code)

1. Copiez ce dossier sur un PC connecté au **même Wi-Fi** que votre téléphone.
2. Ouvrez un terminal dans ce dossier et lancez :
   ```
   node server.js
   ```
3. Le terminal affiche une adresse du type `http://192.168.x.x:8080`.
4. Sur votre téléphone (même Wi-Fi), ouvrez cette adresse dans le navigateur.

### Option B — Directement sur le téléphone Android (autonome, sans PC), via Termux

1. Installez [Termux](https://termux.dev/) (gratuit, open-source, disponible sur F-Droid).
2. Copiez ce dossier sur le téléphone (stockage interne).
3. Dans Termux :
   ```
   pkg install python
   cd /sdcard/chemin/vers/le/dossier
   python -m http.server 8080
   ```
4. Ouvrez `http://localhost:8080` dans le navigateur du téléphone.

> Sur iPhone, l'option A (PC + même Wi-Fi) est la plus simple, Safari n'ayant pas d'équivalent Termux.

## Utilisation pendant l'audit

1. **Étiquette d'asset** : prenez la photo de l'étiquette (dans n'importe quel sens). L'application
   teste automatiquement les 4 orientations, repère la ligne "Asset: ..." et relit cette zone en
   haute qualité. Le numéro d'asset détecté est pré-rempli en quelques secondes — vérifiez-le tout
   de même avant de continuer (l'OCR n'est jamais garanti à 100%).
2. **Écran de verrouillage** : prenez la photo de l'écran. Le nom affiché est détecté et pré-rempli
   automatiquement de la même façon. Vérifiez/corrigez si besoin.
3. Si un résultat est incorrect, ouvrez le bloc **"Résultat incorrect ? Réglage manuel"** : vous
   pouvez alors tourner l'image, dessiner vous-même un cadre autour du texte, puis "Relire".
4. Complétez éventuellement le bureau/la salle et un commentaire.
5. Cliquez sur **"Ajouter à la liste"**.
6. Répétez pour chaque PC non attaché trouvé.
7. En fin de tournée, cliquez sur **"Exporter en Excel (.xlsx)"** pour générer le fichier de sortie.
8. Le bouton "Vider la liste" efface définitivement les entrées stockées sur l'appareil (à utiliser
   une fois l'export récupéré).

## Structure du dossier

```
index.html        page principale
styles.css        mise en forme
app.js            logique de l'application (OCR, extraction, liste, export)
server.js         petit serveur local sans dépendance (voir Option A)
vendor/           Tesseract.js + moteur OCR (WASM) + SheetJS, en local
lang/             données de langue Tesseract (eng + fra), en local
```

## Limites connues

- La détection automatique (orientation + zone de texte) prend quelques secondes (elle teste les
  4 orientations possibles). La toute première photo de la session est un peu plus longue, le
  temps de charger le moteur OCR.
- La reconnaissance du numéro d'asset et du nom est une **suggestion automatique** : relisez
  toujours les champs avant d'ajouter une entrée à la liste.
- Si l'étiquette/l'écran n'est pas détecté automatiquement (éclairage difficile, reflet...),
  utilisez le bloc "Réglage manuel" pour tourner l'image et dessiner vous-même le cadre.
