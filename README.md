# Audit Bureau Propre — version 1.30.0 (OCR + export Excel)

Application web (HTML/JS) pour réaliser vos audits "bureau propre" avec votre téléphone :
scanner plein écran au toucher de l'image → analyse **automatique** de trois orientations (90° en
premier, puis 0° et 270°, jamais à l'envers) et lecture
du numéro d'asset ou du nom, puis export Excel en fin d'audit. Aucun recadrage ni rotation manuelle
n'est nécessaire en usage normal.

## Confidentialité

- Tout le traitement (photos + OCR) se fait **localement dans le navigateur**, via WebAssembly
  (Tesseract.js). Aucune photo, aucun texte, aucune donnée n'est envoyée sur Internet.
- L'application ne fait **aucun appel réseau** : les bibliothèques OCR (`vendor/`) et les
  fichiers de langue (`lang/`) sont embarqués localement, ils ne sont pas téléchargés depuis un CDN.
- La liste des PC non attachés est stockée uniquement dans le stockage local du téléphone
  (`localStorage`), jamais transmise.
- Seuls les fichiers que vous générez volontairement sortent de l'application: l'Excel d'audit ou le
  ZIP du test OCR avec les photos originales. Vous choisissez ensuite le canal de partage.

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
> affichée par `server.js` permet d'ouvrir l'application, mais sur iOS une adresse IP en HTTP
> ouvre la caméra photo native comme solution de repli : cette fenêtre se ferme après la photo,
> c'est une restriction de sécurité du navigateur. Pour garder le scanner live ouvert et afficher
> l'encart de confirmation dans cette fenêtre, utilisez une adresse HTTPS. Sur le PC qui héberge
> l'application, `http://localhost:8080` peut utiliser la caméra locale.

## Utilisation pendant l'audit

1. Renseignez **Étage**, **BU** et **Agence** en haut de l'écran. Elles restent préremplies d'un PC
  à l'autre, mais vous pouvez les modifier avant chaque ajout : leurs valeurs sont conservées
  séparément pour chaque PC et apparaissent dans l'export Excel.
2. **Étiquette d'asset** : démarrez le **scanner live** ; la caméra s'ouvre en plein écran. Attendez
  la fin de l'initialisation OCR, puis cadrez l'étiquette et touchez l'image pour déclencher l'analyse.
  Un indicateur plein écran reste visible pendant le chargement de la caméra et de l'OCR : attendez
  qu'il disparaisse avant de toucher l'image. La reconnaissance commence par 90°, puis teste les
  deux autres orientations. Si le numéro est
  trouvé, un encart vert s'affiche en bas du scanner. Touchez cet encart pour garder la valeur et
  fermer le scanner ; touchez l'image pour refaire le scan. Si rien n'est trouvé, l'écran flashe en
  rouge et vous pouvez retoucher l'image pour réessayer. Pendant une
  reconnaissance, touchez à nouveau l'image pour reprendre une photo : l'ancien résultat et sa
  vérification sont effacés. Utilisez **Arrêter** pour quitter ce mode.
  Le bloc **Photo capturée** permet ensuite de replier l'aperçu de l'image.
3. **Écran de verrouillage** : utilisez le scanner live de la même façon, en attendant
  l'initialisation OCR, puis en cadrant le nom affiché et en touchant l'image. Le nom est lu dans
  l'orientation normale, sans recherche de rotation ; une barre indique l'avancement de la
  reconnaissance et le scan se ferme si le nom est trouvé.
  Le bloc **Photo capturée** permet ensuite de replier l'aperçu de l'image. Le nom est pré-rempli
  automatiquement ; vérifiez/corrigez si besoin. Lorsqu'un nom est trouvé, touchez l'encart vert
  pour le garder et fermer le scanner, ou touchez l'image pour refaire le scan.

  Le moteur OCR est préchargé en arrière-plan après l'ouverture de la fenêtre principale afin de
  réduire l'attente au démarrage du premier scan. La reconnaissance applique un passage standard
  (niveaux de gris et étirement global du contraste), recherche les lignes en mode texte épars,
  puis relit la ligne retenue en mode bloc unique. Le numéro d'asset est recherché dans trois
  orientations (90°, 0°, 270°); le nom est recherché à 0° uniquement. Aucun second passage avec
  seuillage adaptatif n'est exécuté actuellement.
4. Complétez éventuellement le numéro d'asset, le nom, le bureau/la salle et un commentaire.
5. Cliquez sur **"Ajouter à la liste"**.
6. Répétez pour chaque PC non attaché trouvé.
7. Pour corriger une ligne, cliquez sur **"Modifier"** dans la colonne Actions, modifiez les champs,
   puis cliquez sur **"Enregistrer la modification"**.
8. En fin de tournée, cliquez sur **"Exporter le fichier"** puis choisissez OneDrive dans la
  feuille de partage native. Si le partage natif n'est pas disponible, le fichier est téléchargé
  et peut être ouvert ou partagé vers OneDrive depuis l'application Fichiers.
9. Le bouton "Vider la liste" efface définitivement les entrées et toutes les informations du PC
  stockées sur l'appareil (à utiliser une fois l'export récupéré).

## Tester la qualité de l'OCR

En bas de l'écran, ouvrez **"Tester la qualité de l'OCR"**, puis choisissez séparément **Batterie
d'étiquettes** ou **Batterie de lock screens**. Pour une série portant sur la même valeur attendue,
saisissez-la une fois puis ouvrez la caméra. Chaque appui sur **"Prendre et tester"** capture une image,
l'analyse automatiquement avec le même pipeline OCR que l'utilisation normale et ajoute au rapport la
photo originale et ses diagnostics. La caméra reste ouverte pour enchaîner les prises; **"Fermer la
caméra"** revient à la batterie, et **"Quitter le mode test"** arrête le test. L'ajout depuis la galerie
reste disponible; les entrées d'audit ne sont jamais modifiées.

Le bouton de partage produit un fichier ZIP contenant `report.json` et les photos originales, sans
recompression. Le rapport inclut les valeurs attendues, textes bruts et extraits, correspondances,
CER, confiances Tesseract, temps, lignes détectées par orientation, coordonnées des zones, dimensions
décodées, version/configuration OCR et informations navigateur/appareil disponibles. Les noms de
fichiers d'origine sont remplacés par des identifiants d'échantillon. Les ZIP ne sont pas compressés
au-delà des photos déjà compressées et peuvent donc être volumineux.

Le rapport et les photos restent en mémoire locale jusqu'à ce que vous choisissiez explicitement le
partage natif ou le téléchargement. La case de confirmation est obligatoire. Les photos originales
peuvent contenir des noms, du contenu d'écran ou des métadonnées EXIF, y compris une localisation:
vérifiez les images et choisissez un canal autorisé avant l'envoi. Aucun rapport n'est envoyé à
l'application ou automatiquement sur Internet. Si le partage natif n'est pas disponible, le ZIP est
téléchargé pour être partagé manuellement. Limites par batterie: 20 photos, 15 Mio par photo et
100 Mio au total.

## Structure du dossier

```
index.html        page principale
styles.css        mise en forme
app.js            logique de l'application (OCR, extraction, liste, export et benchmark)
server.js         petit serveur local sans dépendance (voir Option A)
vendor/           Tesseract.js + moteur OCR (WASM) + SheetJS, en local
lang/             données de langue Tesseract (eng + fra), en local
OCR_AUDIT.md      audit initial et protocole d'évaluation OCR
```

## Limites connues

- Le scanner live de l'étiquette analyse une photo prise au toucher dans trois orientations (90° en
  premier, puis 0° et 270° ; l'image à l'envers n'est pas testée). Un écran de
  chargement bloque les clics jusqu'à ce que la caméra et l'OCR soient prêts.
  La première analyse est plus longue, le temps de charger le moteur OCR.
- Le scanner du nom utilise directement l'orientation normale ; la détection de la zone de texte
  prend néanmoins quelques secondes.
- La reconnaissance du numéro d'asset et du nom est une **suggestion automatique** : relisez
  toujours les champs avant d'ajouter une entrée à la liste.
- Si l'étiquette/l'écran n'est pas détecté automatiquement (éclairage difficile, reflet...),
  utilisez le bloc "Réglage manuel" pour tourner l'image et dessiner vous-même le cadre.
