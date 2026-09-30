# Audit Bureau Propre — version 1.37.0 (OCR + export Excel)

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
- Les photos et résultats de chaque scan réel sont conservés dans IndexedDB sur l'appareil jusqu'au
  partage réussi des éléments d'amélioration ou au vidage de la liste.
- L'Excel et le ZIP ne quittent l'appareil qu'après une action explicite; le ZIP contient les photos
  originales et peut inclure des données personnelles, du contenu d'écran ou des métadonnées EXIF.

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
9. Le bouton **"Envoyer les éléments pour améliorer l'application"** n'est activé qu'après l'export
  du fichier d'audit actuel. Si vous modifiez les compteurs ou les listes, exportez à nouveau avant
  de pouvoir envoyer le ZIP.
10. Le bouton d'envoi crée un ZIP avec chaque photo
  prise pendant un scan réel, son résultat OCR, ses diagnostics et les informations de contexte.
  Après confirmation, choisissez vous-même le canal de partage dans la feuille native. Un partage
  réussi supprime ensuite toutes les données locales, y compris la liste et les compteurs.
11. **"Vider la liste"** supprime aussi les photos et résultats conservés localement.

## Envoi des scans

Chaque tentative réelle est enregistrée avant le démarrage de l'OCR, y compris les captures sans
valeur extraite, les suggestions incertaines, les erreurs et les analyses interrompues. Les images
sont gardées sans recompression dans IndexedDB; les diagnostics incluent les lignes détectées par
orientation, les scores, les recadrages, les niveaux de confiance, les reprises, la durée, le type de
scan, les dimensions, les réglages caméra disponibles et les informations navigateur.

Le ZIP `amelioration_audit_bureau_propre_<date>_<heure>.zip` contient `report.json` et les photos
associées sous `photos/`. Il est préparé localement; l'application ne l'envoie à aucun serveur.
Il faut d'abord exporter le fichier d'audit correspondant aux données actuelles; toute modification
des compteurs ou listes invalide cet export et bloque le bouton jusqu'au prochain export réussi.
Vous devez confirmer l'avertissement de confidentialité puis sélectionner une destination dans le
partage natif. Si cette fonction n'est pas disponible, le ZIP est téléchargé et les données restent
sur l'appareil jusqu'à leur partage manuel ou au clic sur **"Vider la liste"**. En cas d'annulation,
les données restent également disponibles pour un nouvel essai.

## Structure du dossier

```
index.html        page principale
styles.css        mise en forme
app.js            logique de l'application (OCR, extraction, liste, export et archive des scans)
server.js         petit serveur local sans dépendance (voir Option A)
vendor/           Tesseract.js + moteur OCR (WASM) + SheetJS, en local
lang/             données de langue Tesseract (eng + fra), en local
```

## Limites connues

- Le scanner live de l'étiquette analyse une photo prise au toucher dans trois orientations (90° en
  premier, puis 0° et 270° ; l'image à l'envers n'est pas testée). Un écran de
  chargement bloque les clics jusqu'à ce que la caméra et l'OCR soient prêts.
  La première analyse est plus longue, le temps de charger le moteur OCR.
- Le scanner du nom utilise directement l'orientation normale ; la détection de la zone de texte
  prend néanmoins quelques secondes. Si la relecture de la ligne principale ne suffit pas, le moteur
  relit jusqu'à quatre lignes candidates en PSM 7 avant de conclure.
- La reconnaissance du numéro d'asset et du nom est une **suggestion automatique** : relisez
  toujours les champs avant d'ajouter une entrée à la liste.
- Une image de nom détectée comme peu nette affiche un conseil de reprise; une proposition de nom
  partielle reste visible mais doit être vérifiée. Ces signaux ne garantissent pas l'exactitude.
- Si l'étiquette/l'écran n'est pas détecté automatiquement (éclairage difficile, reflet...),
  utilisez le bloc "Réglage manuel" pour tourner l'image et dessiner vous-même le cadre.
