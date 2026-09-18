# Audit Bureau Propre — application locale (OCR + export Excel)

Application web (HTML/JS) pour réaliser vos audits "bureau propre" avec votre téléphone :
scanner plein écran au toucher de l'image → analyse **automatique** des quatre angles et lecture
du numéro d'asset ou du nom, puis export Excel en fin d'audit. Aucun recadrage ni rotation manuelle
n'est nécessaire en usage normal.

## Confidentialité

- Tout le traitement (photos + OCR) se fait **localement dans le navigateur**, via WebAssembly
  (Tesseract.js). Aucune photo, aucun texte, aucune donnée n'est envoyée sur Internet.
- L'application ne fait **aucun appel réseau** : les bibliothèques OCR (`vendor/`) et les
  fichiers de langue (`lang/`) sont embarqués localement, ils ne sont pas téléchargés depuis un CDN.
- La liste des PC non attachés est stockée uniquement dans le stockage local du téléphone
  (`localStorage`), jamais transmise.
- Seul le fichier `.xlsx` que vous générez volontairement avec le bouton "Exporter le fichier" sort de
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

> **Scanner live et HTTPS** : les navigateurs autorisent la caméra sur `https://` ou sur
> `http://localhost`, mais pas normalement sur une adresse IP en `http://`. L'adresse Wi-Fi
> affichée par `server.js` permet d'ouvrir l'application. Sur une adresse IP en HTTP, le même bouton
> ouvre la caméra native du téléphone comme solution de repli ; le scanner live reste disponible via
> HTTPS ou `http://localhost`. Sur le PC qui héberge l'application, `http://localhost:8080` peut
> utiliser la caméra locale.

## Utilisation pendant l'audit

1. Renseignez **Étage**, **BU** et **Agence** en haut de l'écran. Elles restent préremplies d'un PC
  à l'autre, mais vous pouvez les modifier avant chaque ajout : leurs valeurs sont conservées
  séparément pour chaque PC et apparaissent dans l'export Excel.
2. **Étiquette d'asset** : démarrez le **scanner live** ; la caméra s'ouvre en plein écran. Attendez
  la fin de l'initialisation OCR, puis cadrez l'étiquette et touchez l'image pour déclencher l'analyse.
  Les quatre angles sont analysés. Si le numéro est trouvé, l'écran flashe en vert, le numéro
  s'affiche en grand et le scan se ferme. Si rien n'est trouvé, l'écran flashe en rouge et vous
  pouvez retoucher l'image pour réessayer. Utilisez **Arrêter** pour quitter ce mode.
  Le bloc **Photo capturée** permet ensuite de replier l'aperçu de l'image.
3. **Écran de verrouillage** : utilisez le scanner live de la même façon, en attendant
  l'initialisation OCR, puis en cadrant le nom affiché et en touchant l'image. Les quatre angles sont
  analysés ; le scan se ferme si le nom est trouvé.
  Le bloc **Photo capturée** permet ensuite de replier l'aperçu de l'image. Le nom est pré-rempli
  automatiquement ; vérifiez/corrigez si besoin.
4. Complétez éventuellement le numéro d'asset, le nom, le bureau/la salle et un commentaire.
5. Cliquez sur **"Ajouter à la liste"**.
6. Répétez pour chaque PC non attaché trouvé.
7. Pour corriger une ligne, cliquez sur **"Modifier"** dans la colonne Actions, modifiez les champs,
   puis cliquez sur **"Enregistrer la modification"**.
8. En fin de tournée, cliquez sur **"Exporter le fichier"** puis choisissez OneDrive dans la
  feuille de partage native. Si le partage natif n'est pas disponible, le fichier est téléchargé
  et peut être ouvert ou partagé vers OneDrive depuis l'application Fichiers.
9. Le bouton "Vider la liste" efface définitivement les entrées stockées sur l'appareil (à utiliser
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

- Le scanner live analyse une photo prise au toucher, dans ses quatre orientations. La première
  analyse est plus longue, le temps de charger le moteur OCR.
- La détection automatique sur photo (orientation + zone de texte) prend quelques secondes.
- La reconnaissance du numéro d'asset et du nom est une **suggestion automatique** : relisez
  toujours les champs avant d'ajouter une entrée à la liste.
- Si l'étiquette/l'écran n'est pas détecté automatiquement (éclairage difficile, reflet...),
  utilisez le bloc "Réglage manuel" pour tourner l'image et dessiner vous-même le cadre.
