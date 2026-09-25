# Audit OCR - Audit Bureau Propre

Date: 2026-09-25
Périmètre: audit statique de la version du workspace, sans modification du moteur ni benchmark sur des captures réelles.

## Synthèse

L'application utilise déjà plusieurs choix pertinents pour une photo mobile: un worker Tesseract réutilisé, un préchargement différé, un traitement entièrement dans le navigateur, une recherche sparse-text dans la photo, une sélection de ligne puis une relecture recadrée. Changer de moteur n'est donc pas le premier levier à essayer.

Les priorités révélées par le code sont:

1. Corriger la divergence entre le README et l'exécution: le chemin adaptatif décrit dans le README n'est jamais activé par la configuration actuelle.
2. Mesurer sur un petit jeu de vérité terrain avant/après, et enregistrer séparément les temps de capture, préparation, détection et relecture.
3. Garder le score de confiance, le texte brut et les normalisations pour ne pas présenter une valeur corrigée comme certaine.
4. Vérifier si le cadre visuel de capture correspond aux étiquettes réelles: il guide l'utilisateur, mais l'image entière est transmise à la détection OCR.
5. Comparer de façon contrôlée PSM, ROI, prétraitements et modèles de langue sur Android et iOS avant d'ajouter OpenCV ou un second moteur.

Aucun taux d'exactitude, temps ou coût mémoire de l'application n'est mesuré dans cet audit. Le dépôt ne contient pas de photos de benchmark ni de tests OCR avec transcription attendue. Les gains mentionnés ci-dessous sont des hypothèses à vérifier, pas des résultats.

## 1. Chaîne actuelle

| Étape | Constat dans le code | Perte ou risque possible |
| --- | --- | --- |
| Déclenchement | En mode live, toucher l'image vidéo déclenche la capture. Si `getUserMedia` n'est pas disponible ou si le contexte n'est pas sécurisé, l'application ouvre un `<input type="file" accept="image/*" capture="environment">`. Voir [index.html](index.html) et [app.js](app.js). | La capture live dépend de HTTPS/localhost et des permissions du navigateur. Sur certains iPhone en HTTP par IP, le repli photo native est attendu. Aucun contrôle qualité ne bloque une prise inutilisable. |
| Caméra | `getUserMedia` demande la caméra arrière (`facingMode: ideal environment`) et une taille idéale de 1280 x 720, sans audio. La taille réellement négociée n'est pas lue ni journalisée. Voir [app.js](app.js). | `ideal` est une préférence, pas une garantie de résolution, d'autofocus ou de fréquence. On ne vérifie ni les contraintes réellement obtenues, ni la stabilité de la mise au point. |
| Image capturée | Le mode live dessine la frame entière à `video.videoWidth` x `video.videoHeight` dans un canvas. L'aperçu et l'OCR utilisent la même source décodée. Pas d'encodage JPEG/PNG, `toBlob` ou `toDataURL` dans la chaîne OCR. Voir [app.js](app.js). | Pas de perte due à une compression applicative avec perte. La frame complète contient aussi le décor: le rectangle `scan-frame` est seulement une aide visuelle, il ne délimite pas l'image reconnue. |
| Fichier photo | Le repli charge le fichier par URL objet dans `Image`, puis révoque l'URL à `load`/`error`. Il n'y a pas de redimensionnement ni de recompression fichier avant OCR. Voir [app.js](app.js). | Aucun traitement EXIF explicite. Les navigateurs modernes orientent généralement les images décodées selon EXIF, mais le résultat exact, les limites de taille et la mémoire doivent être vérifiés sur Safari iOS et les appareils Android ciblés. |
| Rotation | L'aperçu peut être rendu avec une rotation interne. En capture live, le numéro d'asset essaie 90°, 0°, 270° (pas 180°); le nom essaie seulement 0°. Pas de deskew général. Voir [app.js](app.js). | Les orientations à l'envers ou une légère inclinaison peuvent échouer. La recherche à trois orientations augmente le temps asset. |
| Redimensionnement | Le canvas OCR plafonne le grand côté à 1800 px. Après crop, il agrandit au plus x4 pour que le grand côté atteigne au moins 700 px. Le canvas utilise un lissage de haute qualité. Voir `buildOcrCanvas` dans [app.js](app.js). | Le plafond peut supprimer du détail sur une photo haute résolution avant le crop. L'agrandissement interpole des pixels et ne recrée pas les détails manquants; le bon seuil dépend de la taille réelle des caractères. |
| Prétraitement standard | RGB vers niveaux de gris puis étirement linéaire des valeurs min/max sur toute l'image. Pas de gamma, égalisation locale, suppression d'ombre, débruitage ou sharpening. Voir [app.js](app.js). | Un reflet ou pixel extrême peut fixer min/max et réduire le contraste utile. L'étirement global ne corrige pas un fond éclairé de manière inégale. |
| Prétraitement adaptatif | Une fonction de seuillage à moyenne locale est implémentée (rayon proportionnel au petit côté, marge de seuil -8), après niveaux de gris. La branche existe dans [app.js](app.js), mais `getLiveConfig` ne définit jamais `retryPreprocess`: la condition qui relance le traitement adaptatif est toujours fausse. Le README affirme à tort que le nom utilise automatiquement cette seconde lecture. |
| Modèle OCR | Tesseract.js **5.1.1**, confirmé par la version intégrée au bundle `vendor/tesseract.min.js`. Chargement via `createWorker('eng+fra', 1, ...)`: OEM 1 (LSTM seulement), worker unique, chemins explicites locaux `vendor/worker.min.js`, `vendor/` et `lang/`. Voir [app.js](app.js), [index.html](index.html). |
| Langues et stockage | `eng.traineddata.gz` (1,89 Mio) et `fra.traineddata.gz` (0,58 Mio) sont dans `lang/`; total compressé 2,47 Mio. Les fichiers WASM JS présents font chacun environ 3,76 ou 4,52 Mio; Tesseract choisit une variante compatible. `cacheMethod: 'write'` autorise le cache local IndexedDB de Tesseract. La source exacte/commit des modèles de langue n'est pas documentée. |
| Paramètres OCR | Pour la détection, PSM 11 (sparse text) avec sortie `blocks`; les lignes sont sélectionnées par heuristique. La meilleure bbox est étendue proportionnellement et relue en PSM 6 (single block). Numéro: trois rotations; nom: une. Worker partagé sérialisé avec une file promise. Voir [app.js](app.js). |
| Contraintes caractères | Aucune whitelist ou blacklist n'est configurée. Le numéro d'asset accepte une extraction assez large, puis un `5` initial est converti en `S`. Le nom est choisi par une heuristique de forme et une liste de mots exclus. Voir [app.js](app.js). |
| Confiance et résultat | Les confiances de lignes entrent dans le score de sélection, avec un bonus très fort pour la ligne contenant « Asset ». Le score final et la confiance ne sont pas conservés dans le champ/UI. Il n'y a pas de seuil de confiance ni de statut « ambigu ». Voir [app.js](app.js). |
| Localité | Les scripts, modèles et worker OCR sont référencés par chemins locaux. L'application ne contient pas d'appel `fetch`, XHR, WebSocket ou envoi de frame dans `app.js`; le serveur du dépôt ne sert que des fichiers statiques. Le traitement OCR est donc local dans le code inspecté. À confirmer lors du test de déploiement en observant les requêtes réseau, notamment pour s'assurer qu'aucune dépendance ou politique d'hébergement ne change. |

Les tailles indiquées sont des tailles de fichiers du workspace (Mio, arrondies), pas une mesure de pic mémoire ou de transfert réel: seule la variante WASM sélectionnée est chargée. Le moteur et les deux modèles restent en mémoire/caches selon le navigateur.

### Post-traitement actuel

- Asset: priorité à une valeur après le mot « asset », sinon motif générique lettres/chiffres (3 à 15 caractères); mise en majuscules; remplacement de `5` initial par `S`.
- Nom: suppression de lignes correspondant aux mots interdits, classement heuristique, conservation des mots initialement capitalisés en tête de ligne. Ce n'est pas une validation de nom de personne.
- La valeur extraite est préremplie dans un champ modifiable et le scanner demande une validation tactile. C'est une protection utile, mais la valeur brute, les remplacements, le score de ligne et le score final ne sont pas présentés ou stockés.
- Les confusions `O/0`, `I/1/l`, `B/8` et `S/5` ne sont pas résolues par règle métier explicite. Ne pas les corriger silencieusement: garder brut/normalisé, marquer la correction et demander confirmation si plusieurs lectures sont plausibles.

## 2. Structure connue et ROI

Les attentes de formulaire donnent déjà un signal exploitable: un identifiant de type `S123456` est associé au libellé « Asset »; un nom est recherché sur un écran de verrouillage. Aujourd'hui le logiciel ne connaît toutefois ni géométrie fixe, ni dimensions de l'étiquette, ni coordonnées stables de ses champs. Il ne détecte pas le contour de l'étiquette, ne corrige pas la perspective et n'a pas de lecteur code-barres/QR.

La stratégie existante est déjà une première approche ROI: PSM 11 trouve des lignes dans la photo entière, une heuristique sélectionne une ligne, puis le rectangle de cette ligne est recadré et relu en PSM 6. Ce n'est pas encore une segmentation métier robuste: la ligne peut être un faux positif, la bbox est légèrement élargie, et la relecture n'applique pas de whitelist propre au champ.

Hypothèse à tester en priorité: si les photos cadrent suffisamment souvent la même étiquette, cadrer/détecter la zone de l'étiquette puis relire uniquement le libellé et l'identifiant séparément fera gagner davantage que des filtres d'image sur la photo entière. Si la position varie fortement, conserver sparse-text en détection et améliorer la sélection/validation est plus robuste qu'un crop aux coordonnées fixes.

## 3. Prétraitements à évaluer

Chaque variante part de l'image source décodée, pas de la sortie d'un autre filtre, pour comparer les traitements sans cumuler leurs artefacts.

| Variante | État actuel / intérêt possible | Risque à mesurer |
| --- | --- | --- |
| Gris + contraste global | Déjà le pipeline standard. Bon baseline peu coûteux. | Les reflets et ombres font varier les extrêmes globaux. |
| Gamma / normalisation locale | À comparer sur faible lumière et luminosité inégale. Une normalisation locale de type CLAHE est une candidate, pas une amélioration présumée. | Amplifie bruit, moiré et texture d'écran; réglage dépendant de l'étiquette. |
| Seuillage adaptatif | Fonction déjà présente mais actuellement inatteignable via la configuration. Tester comme une variante indépendante sur ombres/faible contraste. | Peut effacer caractères fins, accents et gris imprimés; le rayon/seuil actuels sont heuristiques. |
| Otsu / seuil global | Facile à tester dans Canvas ou OpenCV.js sur fond uniforme. | Échec probable si éclairage non uniforme, ombre ou fond multicolore. |
| Réduction de bruit / suppression d'ombre | Candidat uniquement après analyse des erreurs et du bruit dominant; OpenCV.js fournit les primitives. | Lissage des petits chiffres et bords fins; coût mémoire/copier Mat/canvas. |
| Sharpening / déflou | Essai limité sur flou léger détecté. | Les halos ne restaurent pas le détail perdu et favorisent les faux traits. Un flou important exige une nouvelle photo. |
| Deskew / perspective | À faire seulement si les photos montrent une inclinaison ou un quadrilatère d'étiquette exploitable. | Détection de contour incertaine dans le décor, resampling, coût et pertes au warp. |
| Crop, résolution et marges | Comparer frame entière, crop visuel demandé à l'utilisateur, ROI automatique et facteur d'agrandissement. | Un crop trop serré coupe jambages/accents; l'upscale ne recrée aucun détail. |

OpenCV.js est un outil de traitement, pas un moteur OCR. Il apporte thresholding Otsu/adaptatif, morphologie, filtres et transformations géométriques, mais ajoute un runtime et des copies mémoire. D'abord comparer une ou deux opérations simples en Canvas; intégrer OpenCV seulement si les tests montrent un gain reproductible ou si la détection de contour le justifie.

## 4. Optimisations Tesseract à tester

- Comparer PSM 11 pour trouver des lignes, PSM 6 pour une ROI multi-ligne, PSM 7 pour une seule ligne et PSM 8 pour un mot isolé. Garder les réglages propres à chaque étape du worker partagé et toujours les rétablir explicitement.
- Comparer la photo entière et le crop de l'interface, puis séparer libellé/identifiant quand la géométrie est connue. Le crop doit être validé contre la vérité terrain, pas contre la confiance seule.
- Comparer `eng`, `fra`, `eng+fra` sur le champ concerné. La langue française peut aider pour les noms/accents; un identifiant alphanumérique n'a pas besoin d'un dictionnaire bilingue. Mesurer taille chargée, initialisation et qualité, car langue/modèle peuvent influencer l'espace de recherche.
- Comparer les modèles `tessdata_fast` et `tessdata_best` (et la variante effectivement en place). Ne pas déduire la famille des deux modèles locaux uniquement de leur nom ou taille: provenance et version ne sont pas enregistrées. Épingler les URLs/commits et checksums avant une comparaison.
- Tester une whitelist limitée seulement sur l'ROI identifiant, après confirmer le jeu de caractères autorisé. Une whitelist trop stricte peut exclure tiret ou lettre réelle et transformer une erreur en omission.
- Garder le worker existant. Le préchargement à l'inactivité et la file sérialisée sont déjà adaptés aux lectures répétées; multiplier les workers sur mobile augmente la RAM et peut ralentir l'appareil.
- Exploiter sortie `blocks` pour conserver bbox, texte et confiance par ligne. Une faible confiance ou un désaccord de deux lectures doit produire un résultat à confirmer, pas une correction automatique.

## 5. Jeu d'essai et méthode de mesure

Le dépôt ne comporte pas de dataset représentatif et je n'ai pas effectué de benchmark visuel ou réel. Constituer d'abord 30 à 50 captures anonymisées avec transcription exacte, puis enrichir selon les échecs. Inclure plusieurs modèles Android et iPhone disponibles, et équilibrer: lumière normale/faible, ombre, reflet, rotation, inclinaison, distance, taille de texte et flou léger. Garder les images sur un appareil/dossier local de test; ne pas les inclure dans Git ni dans une télémétrie.

Pour chaque image, enregistrer localement un identifiant non nominatif, vérité terrain des champs, appareil/navigateur, conditions, variante testée, texte OCR brut, valeur normalisée, correction appliquée, confiances, durée prétraitement/détection/relecture/total et résultat accepté/corrigé. Vérifier d'abord manuellement les annotations. Une option utile est un petit fichier JSON de vérité terrain sans image, avec chemins vers un jeu privé non versionné.

Métriques principales:

- exactitude complète du champ asset et exactitude complète du nom; indicateur central: taux de captures où tous les champs requis sont exacts sans correction manuelle;
- taux de corrections manuelles et faux résultats acceptés; compter séparément les absences de résultat et les mauvaises valeurs;
- CER sur les transcriptions pour diagnostiquer les erreurs, sans le substituer au taux d'identifiants parfaitement reconnus;
- temps médian et p95 de l'ouverture à la valeur proposée et du seul OCR, après échauffement et premier chargement séparés;
- pic mémoire si les outils de chaque navigateur le permettent, ou à défaut stabilité (échec d'allocation, rechargement/onglet tué, latence dégradée) sur longues sessions;
- poids réseau/cache à froid et reprise hors réseau après chargement local.

Protocole d'ablation recommandé: A0 baseline figée; A1 activer uniquement la lecture adaptative annoncée; A2 ajouter PSM/ROI; A3 modifier une famille de prétraitement à la fois; A4 comparer modèle/langue; A5 challenger PaddleOCR.js ou TrOCR sur les mêmes images. Ordre des variantes randomisé par image, cache chaud/froid séparé, même vérité terrain et même appareil. Publier les résultats agrégés, jamais les photos sensibles.

Avant chaque essai, fixer un seuil de conservation. Proposition initiale à confirmer: +5 points de pourcentage sur les champs parfaitement reconnus, sans hausse des faux résultats acceptés, avec p95 mobile ne dépassant pas 2x le baseline et un budget mémoire/poids explicite. Si le gain n'est pas démontré, conserver le baseline.

## 6. Moteurs locaux navigateur

| Solution | Réalité browser/local et maturité | Mobile / ressources | Conclusion pour ce cas |
| --- | --- | --- | --- |
| Tesseract.js 5.1.1 actuel | WebAssembly dans Web Worker; Apache-2.0. Le projet est mature et conçu pour navigateur. Worker/core/lang peuvent être servis depuis le même origin et les modèles sont mis en cache localement. | CPU/WASM, compatible avec navigateurs modernes; pas de matrice formelle Android/iOS par appareil. Coût et qualité dépendent des modèles et dimensions. | Baseline la moins risquée. Mesurer un upgrade vers une version maintenue avant toute migration: la version installée est ancienne par rapport à la documentation actuelle. |
| PaddleOCR.js officiel | SDK navigateur récent `@paddleocr/paddleocr-js` 0.4.2, licence Apache-2.0 au package; pipeline ONNX Runtime Web + OpenCV.js, détection puis reconnaissance, résultats avec bbox/score; worker dédié disponible. Le SDK peut être servi localement si runtime WASM, modèles (archives `.tar`) et paths sont tous explicitement locaux. | WASM est le point de départ prudent. ORT expose WebGPU, mais disponibilité et couverture d'opérateurs varient; la documentation consultée indique Chrome/Android récents mais Safari seulement en Technology Preview pour WebGPU. Le SDK est jeune et nécessite build/worker/module + contraintes d'en-têtes selon backend. Taille exacte des modèles et mémoire pour notre configuration ne sont pas publiées dans le README inspecté, à mesurer. | Challenger le plus pertinent si la segmentation/sparse text du pipeline actuel plafonne. Prototype autonome et audit réseau requis; ne pas présumer iOS ou offline au seul vu de « browser SDK ». |
| Transformers.js + TrOCR ONNX | Transformers.js (Apache-2.0) exécute ONNX en navigateur via WASM et peut utiliser WebGPU; des exports TrOCR compatibles existent (par exemple dépôts Xenova). Le poids/modèle a sa propre licence, à vérifier séparément. Chargement local possible en configurant les chemins locaux et en désactivant les modèles distants. | Poids et runtime supérieurs à Tesseract; architecture encodeur-décodeur et pré/post-traitement plus complexes. WebGPU ne doit pas être une dépendance iOS. Compatibilité WASM à valider sur Safari mobile avec modèle quantifié. | Candidat expérimental de reconnaissance de ligne/crop très propre, pas premier choix pour détecter une étiquette entière. Vérifier poids, licences, peak RAM et latence sur appareils bas/milieu de gamme. |
| Scribe.js | JavaScript et exécution locale browser possibles; AGPL-3.0. Le projet annonce un mode qualité plus précis mais plus lent, son comparatif indique typiquement 40–90% de runtime supplémentaire face au mode vitesse et un chargement additionnel de modèle. C'est un comparatif du projet, à réévaluer indépendamment. | Plus lourd que Tesseract; ressources optionnelles, chargées selon le mode. | À exclure sans validation juridique de l'AGPL ou licence commerciale et sans bénéfice démontré sur le jeu réel. Ce n'est pas une alternative de pile totalement indépendante du monde Tesseract. |
| EasyOCR | Projet Apache-2.0 principalement PyTorch/Python; l'installation documentée charge les poids depuis Python, sans runtime browser/WASM maintenu officiellement. | Pas une solution web mobile locale raisonnablement intégrable telle quelle. Un port/export et son runtime seraient un projet distinct. | Non retenu comme bibliothèque directe. Ne pas confondre démo hébergée ou API Python avec OCR côté navigateur. |
| OpenCV.js | Bibliothèque de vision côté navigateur, pas OCR. Apache-2.0 en versions actuelles. | WASM/JS local possible; copies d'images et mémoire à surveiller. | Complément de prétraitement/cadrage uniquement, à justifier par les mesures. |

Pour ONNX Runtime Web, ONNX n'est que le format d'exécution: la qualité, la licence et la taille proviennent du modèle concret. Sur iOS, prévoir un chemin WASM fonctionnel et considérer WebGPU comme accélération facultative après validation Safari réelle. Il faut aussi désactiver tout téléchargement par défaut, héberger les fichiers runtime/modèles même origine, puis vérifier dans DevTools que l'inférence n'effectue aucun appel externe.

Sources primaires consultées le 2026-09-25: [Tesseract.js](https://github.com/naptha/tesseract.js), [API Tesseract.js](https://github.com/naptha/tesseract.js/blob/master/docs/api.md), [installation locale Tesseract.js](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md), [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/), [WebGPU EP](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html), [OpenCV.js](https://docs.opencv.org/4.x/d5/d10/tutorial_js_root.html), [PaddleOCR.js SDK](https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js), [Transformers.js](https://github.com/huggingface/transformers.js), [TrOCR small printed ONNX](https://huggingface.co/Xenova/trocr-small-printed), [Scribe.js](https://github.com/scribeocr/scribe.js) et [comparatif Scribe/Tesseract](https://github.com/scribeocr/scribe.js/blob/master/docs/scribe_vs_tesseract.md). Les versions et compatibilités des modèles doivent être figées au moment d'un prototype, ces dépôts évoluant.

## 7. UX de capture à évaluer

- Mesurer la qualité avant l'OCR: netteté locale, luminosité et contraste. Si c'est insuffisant, afficher une consigne simple (« stabilisez », « rapprochez-vous », « évitez le reflet ») et laisser l'utilisateur reprendre. Ne pas prétendre réparer un flou important.
- Examiner si le cadre dessiné correspond à la proportion et position réelles de l'étiquette. Aujourd'hui il n'y a ni crop caméra, ni détection qui vérifie son contenu; une zone de guide plus explicite et réellement appliquée pourrait réduire le décor.
- Mesurer les contraintes caméra obtenues (`track.getSettings()`), et essayer plusieurs résolutions demandées sur les appareils supportés; ne choisir une résolution plus élevée que si les caractères gagnent en pixels utiles sans ralentir l'OCR.
- Laisser l'autofocus/exposition faire la mise au point, mais attendre un instant stable après l'ouverture et vérifier le résultat sur iOS/Android. Pas de contrainte de focus explicite dans le code actuel.
- Ajouter un repli clair vers photo native quand caméra live indisponible; tester séparément permission refusée, HTTP sur IP, HTTPS, rotations EXIF et annulation de capture.

## 8. Trois options

| Option | Contenu et gains attendus | Complexité / impact mobile / risques | Dépendance à la mesure |
| --- | --- | --- | --- |
| A - minimale | Corriger l'activation du pass adaptatif réellement voulu; enregistrer des métriques temporaires locales; conserver confiance et OCR brut; valider la syntaxe sans correction silencieuse; comparer PSM 7/6/11 et éventuellement `eng` contre `eng+fra`; documenter versions/modèles. Gain faible à moyen attendu, latence généralement limitée à un retry quand la première lecture échoue. | Faible; peu d'impact sur structure/UI. Risque de faux positifs par whitelist/règles métier et de surcoût si retry trop fréquent. Modèle inchangé, poids nul ou faible. Android/iOS restent sur WASM existant. | Conserver chaque ajout seulement si le taux exact progresse et le taux de fausse acceptation ne monte pas. C'est le meilleur premier incrément. |
| B - intermédiaire | Pipeline configurable original/gris-étiré/adaptatif/Otsu sur ROI; cadrage réel ou détection/crop; paramètres spécialisés identifiant/nom; score final de confiance, raw/normalisé/correction visible, seuil de confirmation; seconde passe seulement en cas d'incertitude. Gain potentiellement élevé si image, cadrage ou format du champ est la cause dominante. | Moyenne; changements dans `app.js`, UI de confirmation et données benchmark. CPU/mémoire augmentent si multi-pass; OpenCV.js ajouterait runtime notable, donc seulement si démontré. La géométrie fixe peut mal généraliser. | Mesurer chaque étape séparément, y compris les captures ratées. Tester Android et Safari/iOS, pas seulement desktop. Recommandée après l'option A si les limites sont dans pixels/ROI/validation. |
| C - avancée | Challenger les captures difficiles avec PaddleOCR.js en WASM local (détection + reconnaissance), ou TrOCR sur ROI ligne. Fallback vers second moteur seulement si premier résultat absent/faible/ambigu; résultat final doit rester validable. Peut apporter robustesse aux décors et aux caractères si le modèle convient. | Élevée; moteur, worker, modèles, outil/build, licences et empaquetage offline. Augmentation inconnue du poids et de la RAM; premier chargement et p95 peuvent fortement monter. WebGPU est facultatif et ne garantit pas Safari. Risque d'une UX plus lente et de divergences des deux moteurs. | N'engager qu'un prototype séparé après baseline, avec assets locaux épinglés, mesures complètes sur appareils réels et revue de licences. Migration/remplacement déconseillé sans gain substantiel sur les champs exacts. |

## Recommandation et étapes

1. Geler la version courante et obtenir le jeu privé annoté. Établir l'exactitude, la latence froide/chaude, les erreurs acceptées et le comportement sur les appareils disponibles.
2. Corriger le décalage de configuration adaptative/documentation et instrumenter localement un mode benchmark sans envoyer ni persister les photos hors appareil. Avant/après doit utiliser exactement les mêmes images et labels.
3. Comparer une seule variable à la fois: modes PSM/whitelist ROI, langue/modèles épinglés, puis prétraitement/cadrage. Conserver le brut, la confiance et l'historique des transformations pour rendre toute correction explicable.
4. Améliorer le guidage caméra là où les mesures attribuent l'erreur à une entrée floue, petite, sombre ou mal cadrée. N'ajouter OpenCV.js que pour une transformation prouvée utile.
5. Si les erreurs restantes concernent la détection de texte en décor ou la lecture de lignes difficiles, faire un prototype PaddleOCR.js self-hosted et/ou TrOCR WASM. Comparer d'abord hors du flux utilisateur, puis activer un fallback seulement si exactitude des champs, faux positifs, p95 et mémoire respectent les seuils.

Recommandation actuelle: **Option A d'abord, puis B sur les défauts révélés par les données**. PaddleOCR.js mérite un essai ciblé en option C; aucune donnée présente ne justifie encore d'en faire le moteur principal. Les scores de confiance Tesseract ne sont pas des probabilités calibrées: les exploiter comme signal de tri à valider, jamais comme garantie d'exactitude.

## Limites de cet audit

- Pas de photo utilisateur ou dataset disponible dans le workspace; aucun CER, taux de champs, temps mobile ou mémoire mesuré.
- Aucun téléphone Android/iOS n'a été piloté pendant cet audit. Les variations de caméra, EXIF, permissions, mémoire de canvas et WebGPU nécessitent des essais réels.
- Le numéro de version Tesseract.js est identifiable dans le bundle, mais la provenance, le commit, le checksum et la famille exacte des deux fichiers `traineddata` ne sont pas consignés par l'application.
- Le README annonce 1.17.0 alors que l'interface et les assets portent 1.28.0; ses étapes OCR ne décrivent donc pas de manière fiable le comportement livré.
- Aucun changement n'a été fait au code applicatif dans cette première livraison.