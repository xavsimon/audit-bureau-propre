'use strict';

/*
 * Audit Bureau Propre — logique 100% locale (aucun appel réseau).
 * OCR via Tesseract.js (fichiers vendor/ et lang/ servis localement).
 * Export via SheetJS (vendor/xlsx.full.min.js).
 */

const STORAGE_KEY = 'audit-bureau-propre-entries-v1';

// ---------- Etat des deux zones de capture (asset / nom) ----------
function createCaptureState(fileInputId, canvasId, rotateBtnId, invertBtnId, resetCropBtnId, ocrBtnId, wrapId, cropBoxId, liveBtnId, liveWrapId, liveVideoId, liveStatusId, stopLiveBtnId) {
  return {
    fileInput: document.getElementById(fileInputId),
    canvas: document.getElementById(canvasId),
    rotateBtn: document.getElementById(rotateBtnId),
    invertBtn: document.getElementById(invertBtnId),
    resetCropBtn: document.getElementById(resetCropBtnId),
    ocrBtn: document.getElementById(ocrBtnId),
    wrap: document.getElementById(wrapId),
    cropBox: document.getElementById(cropBoxId),
    liveBtn: document.getElementById(liveBtnId),
    liveWrap: document.getElementById(liveWrapId),
    liveVideo: document.getElementById(liveVideoId),
    liveStatus: document.getElementById(liveStatusId),
    stopLiveBtn: document.getElementById(stopLiveBtnId),
    image: null,
    rotation: 0,
    invert: false,
    // Zone recadrée, en fractions [0,1] du canvas affiché (post-rotation). null = image entière.
    crop: null,
    liveStream: null,
    liveActive: false,
    liveBusy: false,
    liveTimer: null,
    liveRotationIndex: 0,
    liveStableValue: '',
    liveStableCount: 0,
    liveStableMisses: 0,
    liveSaved: null,
  };
}

const assetState = createCaptureState(
  'fileAsset', 'canvasAsset', 'rotateAsset', 'invertAsset', 'resetCropAsset', 'ocrAsset', 'wrapAsset', 'cropBoxAsset',
  'startLiveAsset', 'liveWrapAsset', 'liveVideoAsset', 'liveStatusAsset', 'stopLiveAsset'
);
const nameState = createCaptureState(
  'fileName', 'canvasName', 'rotateName', 'invertName', 'resetCropName', 'ocrName', 'wrapName', 'cropBoxName',
  'startLiveName', 'liveWrapName', 'liveVideoName', 'liveStatusName', 'stopLiveName'
);

function getImageDimensions(image) {
  return {
    width: image.videoWidth || image.naturalWidth || image.width,
    height: image.videoHeight || image.naturalHeight || image.height,
  };
}

function loadImageFile(input, state) {
  return new Promise((resolve, reject) => {
    const file = input.files && input.files[0];
    if (!file) return reject(new Error('Aucun fichier'));
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      state.image = img;
      state.rotation = 0;
      state.invert = false;
      state.crop = null;
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = reject;
    img.src = url;
  });
}

// Dessine l'image dans le canvas visible, en appliquant la rotation choisie.
function renderPreview(state) {
  const { canvas, image, rotation } = state;
  if (!image) return;
  const { width: imageWidth, height: imageHeight } = getImageDimensions(image);
  if (!imageWidth || !imageHeight) return;
  const ctx = canvas.getContext('2d');
  const swapped = rotation % 180 !== 0;
  const w = swapped ? imageHeight : imageWidth;
  const h = swapped ? imageWidth : imageHeight;
  canvas.width = w;
  canvas.height = h;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(image, -imageWidth / 2, -imageHeight / 2, imageWidth, imageHeight);
  ctx.restore();
  updateCropBoxUI(state);
}

function updateCropBoxUI(state) {
  const { cropBox, crop, canvas } = state;
  if (!crop || !canvas.width) {
    cropBox.hidden = true;
    return;
  }
  cropBox.hidden = false;
  const { offX, offY, dispW, dispH } = imageDisplayRect(canvas);
  cropBox.style.left = `${offX + crop.x * dispW}px`;
  cropBox.style.top = `${offY + crop.y * dispH}px`;
  cropBox.style.width = `${crop.w * dispW}px`;
  cropBox.style.height = `${crop.h * dispH}px`;
}

// Le canvas est affiché avec `object-fit: contain` (CSS) : sa boîte peut donc
// contenir des bandes vides ("letterboxing") de part et d'autre de l'image
// réellement dessinée. Cette fonction calcule le rectangle exact (en pixels
// écran) occupé par le contenu de l'image, pour convertir correctement les
// coordonnées pointeur <-> fractions de l'image native.
function imageDisplayRect(canvas) {
  const rect = canvas.getBoundingClientRect();
  const canvasAspect = canvas.width / canvas.height;
  const boxAspect = rect.width / rect.height;
  let dispW;
  let dispH;
  let offX;
  let offY;
  if (canvasAspect > boxAspect) {
    dispW = rect.width;
    dispH = rect.width / canvasAspect;
    offX = 0;
    offY = (rect.height - dispH) / 2;
  } else {
    dispH = rect.height;
    dispW = rect.height * canvasAspect;
    offY = 0;
    offX = (rect.width - dispW) / 2;
  }
  return { rect, offX, offY, dispW, dispH };
}

// Sélection tactile/souris d'une zone de recadrage sur le canvas affiché.
function wireCropSelection(state) {
  const { wrap, canvas } = state;
  let dragStart = null;

  const posFromEvent = (e) => {
    const { rect, offX, offY, dispW, dispH } = imageDisplayRect(canvas);
    const x = (e.clientX - rect.left - offX) / dispW;
    const y = (e.clientY - rect.top - offY) / dispH;
    return { x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1) };
  };

  wrap.addEventListener('pointerdown', (e) => {
    if (!state.image) return;
    wrap.setPointerCapture(e.pointerId);
    dragStart = posFromEvent(e);
    state.crop = { x: dragStart.x, y: dragStart.y, w: 0, h: 0 };
    updateCropBoxUI(state);
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!dragStart) return;
    const p = posFromEvent(e);
    const x = Math.min(dragStart.x, p.x);
    const y = Math.min(dragStart.y, p.y);
    const w = Math.abs(p.x - dragStart.x);
    const h = Math.abs(p.y - dragStart.y);
    state.crop = { x, y, w, h };
    updateCropBoxUI(state);
  });

  const endDrag = () => {
    if (!dragStart) return;
    dragStart = null;
    if (!state.crop || state.crop.w < 0.03 || state.crop.h < 0.03) {
      state.crop = null;
      updateCropBoxUI(state);
    }
  };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);
}

// Construit un canvas hors-écran recadré + prétraité (niveaux de gris,
// contraste étiré, inversion optionnelle) prêt pour l'OCR.
function buildOcrCanvas(state) {
  const { image, rotation, invert, crop } = state;
  const { width: imageWidth, height: imageHeight } = getImageDimensions(image);
  const swapped = rotation % 180 !== 0;
  const fullW = swapped ? imageHeight : imageWidth;
  const fullH = swapped ? imageWidth : imageHeight;

  const MAX_DIM = 1800;
  const scale = Math.min(1, MAX_DIM / Math.max(fullW, fullH));
  const rotW = Math.round(fullW * scale);
  const rotH = Math.round(fullH * scale);

  // 1) Dessine l'image tournée dans un canvas intermédiaire.
  const rotated = document.createElement('canvas');
  rotated.width = rotW;
  rotated.height = rotH;
  const rctx = rotated.getContext('2d');
  rctx.save();
  rctx.translate(rotW / 2, rotH / 2);
  rctx.rotate((rotation * Math.PI) / 180);
  const dw = swapped ? rotH : rotW;
  const dh = swapped ? rotW : rotH;
  rctx.drawImage(image, -dw / 2, -dh / 2, dw, dh);
  rctx.restore();

  // 2) Extrait la zone recadrée (si définie), avec un léger agrandissement si
  //    la zone est petite (améliore la reconnaissance des petits caractères).
  let cropW = rotW;
  let cropH = rotH;
  let sx = 0;
  let sy = 0;
  if (crop) {
    sx = Math.round(crop.x * rotW);
    sy = Math.round(crop.y * rotH);
    cropW = Math.max(1, Math.round(crop.w * rotW));
    cropH = Math.max(1, Math.round(crop.h * rotH));
  }
  const MIN_DIM = 700;
  const upscale = Math.min(4, Math.max(1, MIN_DIM / Math.max(cropW, cropH)));
  const outW = Math.round(cropW * upscale);
  const outH = Math.round(cropH * upscale);

  const off = document.createElement('canvas');
  off.width = outW;
  off.height = outH;
  const ctx = off.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(rotated, sx, sy, cropW, cropH, 0, 0, outW, outH);

  // 3) Niveaux de gris + étirement de contraste + inversion optionnelle.
  const imgData = ctx.getImageData(0, 0, outW, outH);
  const d = imgData.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = gray;
    if (gray < min) min = gray;
    if (gray > max) max = gray;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    let v = ((d[i] - min) * 255) / range;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(imgData, 0, 0);
  return off;
}

function wireCapture(state, onReady) {
  state.fileInput.addEventListener('change', async () => {
    try {
      await loadImageFile(state.fileInput, state);
      renderPreview(state);
      state.rotateBtn.disabled = false;
      state.invertBtn.disabled = false;
      state.resetCropBtn.disabled = false;
      state.ocrBtn.disabled = false;
      if (onReady) onReady();
    } catch (e) {
      alert("Impossible de charger l'image.");
    }
  });

  state.rotateBtn.addEventListener('click', () => {
    state.rotation = (state.rotation + 90) % 360;
    state.crop = null;
    renderPreview(state);
  });

  state.invertBtn.addEventListener('click', () => {
    state.invert = !state.invert;
  });

  state.resetCropBtn.addEventListener('click', () => {
    state.crop = null;
    updateCropBoxUI(state);
  });

  state.liveBtn.addEventListener('click', () => startLiveScan(state, getLiveConfig(state)));
  state.stopLiveBtn.addEventListener('click', () => stopLiveScan(state, true));

  wireCropSelection(state);
}

wireCapture(assetState, () => runAssetOcr());
wireCapture(nameState, () => runNameOcr());

// ---------- Tesseract worker (chargé une seule fois, 100% local) ----------
let workerPromise = null;
function abs(relativePath) {
  // Le worker Tesseract est chargé via un Blob (importScripts), qui ne peut pas
  // résoudre les chemins relatifs : il faut donc des URL absolues.
  return new URL(relativePath, window.location.href).href;
}
function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('eng+fra', 1, {
      workerPath: abs('vendor/worker.min.js'),
      corePath: abs('vendor/'),
      langPath: abs('lang'),
      cacheMethod: 'write',
      logger: () => {},
    });
  }
  return workerPromise;
}

// Un seul worker Tesseract est partagé entre l'étiquette et l'écran : sans
// verrou, deux analyses lancées en même temps (ex. deux photos prises coup sur
// coup) se marchent dessus (paramètres PSM écrasés l'un par l'autre). Cette
// file d'attente sérialise tous les appels OCR.
let ocrQueue = Promise.resolve();
function withOcrLock(fn) {
  const result = ocrQueue.then(fn, fn);
  ocrQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function runOcr(state, progressEl) {
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '6' });
  const ocrCanvas = buildOcrCanvas(state);
  progressEl.textContent = 'Analyse en cours...';
  const { data } = await worker.recognize(ocrCanvas, {}, { text: true });
  progressEl.textContent = '';
  return data.text || '';
}

// ---------- Détection automatique (orientation + zone de texte) ----------
const ROTATIONS = [0, 90, 180, 270];
const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

function flattenLines(data) {
  const lines = [];
  (data.blocks || []).forEach((b) => (b.paragraphs || []).forEach((p) => (p.lines || []).forEach((l) => {
    const text = (l.text || '').trim();
    if (text) lines.push({ text, confidence: l.confidence, bbox: l.bbox });
  })));
  return lines;
}

// Repère la ligne la plus probable pour un numéro d'asset ("Asset: XXXX" en priorité).
function scoreAssetLines(lines) {
  let bestLine = null;
  let bestScore = -Infinity;
  for (const l of lines) {
    let score = l.confidence;
    if (/asset/i.test(l.text)) score += 200;
    else if (!/\d/.test(l.text)) continue;
    if (score > bestScore) {
      bestScore = score;
      bestLine = l;
    }
  }
  return { line: bestLine, score: bestLine ? bestScore : -Infinity };
}

// Repère la ligne la plus probable pour un nom de personne (score OCR + heuristique de forme).
function scoreNameLines(lines) {
  let bestLine = null;
  let bestScore = -Infinity;
  for (const l of lines) {
    if (!/[A-Za-zÀ-ÿ]/.test(l.text) || NAME_STOPWORDS.test(l.text)) continue;
    const score = l.confidence + scoreNameLine(l.text) * 15;
    if (score > bestScore) {
      bestScore = score;
      bestLine = l;
    }
  }
  return { line: bestLine, score: bestLine ? bestScore : -Infinity };
}

// Essaie les 4 orientations, repère automatiquement la meilleure zone de texte
// (mode "texte épars" = robuste face aux photos avec beaucoup de texture parasite),
// puis relit cette zone en haute qualité (recadrée + agrandie) pour un résultat propre.
async function autoRecognize(state, scoreFn, progressEl) {
  const worker = await getWorker();
  let best = null;

  await worker.setParameters({ tessedit_pageseg_mode: '11' });
  for (let i = 0; i < ROTATIONS.length; i += 1) {
    const rotation = ROTATIONS[i];
    progressEl.textContent = `Détection de l'orientation... (${i + 1}/${ROTATIONS.length})`;
    state.rotation = rotation;
    state.crop = null;
    const canvas = buildOcrCanvas(state);
    // eslint-disable-next-line no-await-in-loop
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    const { line, score } = scoreFn(flattenLines(data));
    if (line && score > (best ? best.score : -Infinity)) {
      best = {
        rotation,
        score,
        crop: {
          x: line.bbox.x0 / canvas.width,
          y: line.bbox.y0 / canvas.height,
          w: (line.bbox.x1 - line.bbox.x0) / canvas.width,
          h: (line.bbox.y1 - line.bbox.y0) / canvas.height,
        },
      };
    }
  }

  if (!best) {
    state.rotation = 0;
    state.crop = null;
    renderPreview(state);
    progressEl.textContent = '';
    return '';
  }

  // Marge autour de la ligne détectée (évite de couper un caractère), calculée
  // proportionnellement à la taille de la ligne : une marge fixe trop généreuse
  // finit par englober des éléments voisins (photo de profil, icône...) et
  // perturbe la relecture.
  const padX = best.crop.w * 0.25 + 0.015;
  const padY = best.crop.h * 0.4 + 0.01;
  const x = Math.max(0, best.crop.x - padX);
  const y = Math.max(0, best.crop.y - padY);
  state.rotation = best.rotation;
  state.crop = {
    x,
    y,
    w: clamp01(Math.min(1 - x, best.crop.w + padX * 2)),
    h: clamp01(Math.min(1 - y, best.crop.h + padY * 2)),
  };
  renderPreview(state);

  progressEl.textContent = 'Lecture précise...';
  await worker.setParameters({ tessedit_pageseg_mode: '6' });
  const refinedCanvas = buildOcrCanvas(state);
  const { data } = await worker.recognize(refinedCanvas, {}, { text: true });
  progressEl.textContent = '';
  return data.text || '';
}

// ---------- Extraction heuristique ----------
function extractAssetNumber(text) {
  const cleaned = text.replace(/\r/g, '');
  let m = cleaned.match(/asset[^A-Za-z0-9]{0,4}([A-Za-z0-9][A-Za-z0-9\-]{2,14})/i);
  if (m) return m[1].toUpperCase();
  m = cleaned.match(/\b([A-Z]{1,3}\d{4,8})\b/);
  if (m) return m[1].toUpperCase();
  return '';
}

const NAME_STOPWORDS = /pour d[ée]verrouiller|options? de connexion|mot de passe|entrer|appuyez|glissez|touch id|face id|empreinte|verrouill|lecteur|analysez|doigt|windows|iphone|ipad|entsperren|password|pin\b/i;

function scoreNameLine(line) {
  const words = line.split(/\s+/).filter(Boolean);
  let score = 0;
  if (words.length >= 2 && words.length <= 4) score += 3;
  if (words.length === 1 && line.length >= 3) score += 1;
  if (/^[A-ZÀ-Ý]/.test(line)) score += 1;
  if (line.length >= 4 && line.length <= 30) score += 1;
  if (/\d/.test(line)) score -= 2;
  return score;
}

function extractName(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => /[A-Za-zÀ-ÿ]/.test(l))
    .filter((l) => !NAME_STOPWORDS.test(l));
  if (!lines.length) return '';
  lines.sort((a, b) => scoreNameLine(b) - scoreNameLine(a));
  // Ne garde que la suite de "mots de nom" en tête de ligne (Capitalisé ou
  // TOUT EN MAJUSCULES) ; s'arrête au premier résidu OCR (ponctuation, lettre
  // isolée...) du type "SIMON Xavier - à".
  const wordRe = /^[A-ZÀ-Ý]([a-zà-ÿ]+|[A-ZÀ-Ý]*)$/;
  const kept = [];
  for (const tok of lines[0].split(/\s+/)) {
    if (!wordRe.test(tok)) break;
    kept.push(tok);
  }
  return kept.join(' ') || lines[0];
}

const LIVE_CONFIRMATIONS = 2;
const LIVE_INTERVAL_MS = 250;
const LIVE_CROP = { x: 0.08, y: 0.15, w: 0.84, h: 0.70 };
const LIVE_ROTATION = 0;

function getLiveConfig(state) {
  if (state === assetState) {
    return {
      fieldId: 'fieldAsset',
      rawId: 'rawAsset',
      progressId: 'progressAsset',
      extract: extractAssetNumber,
    };
  }
  return {
    fieldId: 'fieldName',
    rawId: 'rawName',
    progressId: 'progressName',
    extract: (text) => {
      const value = extractName(text);
      return scoreNameLine(value) >= 2 ? value : '';
    },
  };
}

function normalizeLiveValue(value) {
  return value.replace(/\s+/g, ' ').trim().toLocaleUpperCase('fr-FR');
}

function restoreLiveState(state) {
  if (!state.liveSaved) return;
  const saved = state.liveSaved;
  state.liveSaved = null;
  state.image = saved.image;
  state.rotation = saved.rotation;
  state.invert = saved.invert;
  state.crop = saved.crop;
  if (state.image) renderPreview(state);
}

function stopLiveScan(state, restore = true) {
  if (state.liveTimer !== null) {
    clearTimeout(state.liveTimer);
    state.liveTimer = null;
  }
  state.liveActive = false;
  state.liveBusy = false;
  if (state.liveStream) {
    state.liveStream.getTracks().forEach((track) => track.stop());
    state.liveStream = null;
  }
  state.liveVideo.pause();
  state.liveVideo.srcObject = null;
  state.liveWrap.hidden = true;
  state.canvas.hidden = false;
  state.fileInput.disabled = false;
  state.liveBtn.disabled = false;
  state.stopLiveBtn.disabled = false;
  if (restore) restoreLiveState(state);
  const hasImage = Boolean(state.image);
  state.rotateBtn.disabled = !hasImage;
  state.invertBtn.disabled = !hasImage;
  state.resetCropBtn.disabled = !hasImage;
  state.ocrBtn.disabled = !hasImage;
  state.liveStableValue = '';
  state.liveStableCount = 0;
  state.liveStableMisses = 0;
  if (!restore) state.liveSaved = null;
  state.liveStatus.textContent = '';
}

function captureVideoFrame(state) {
  const { videoWidth, videoHeight } = state.liveVideo;
  if (!videoWidth || !videoHeight) return null;
  const frame = document.createElement('canvas');
  frame.width = videoWidth;
  frame.height = videoHeight;
  frame.getContext('2d').drawImage(state.liveVideo, 0, 0, videoWidth, videoHeight);
  return frame;
}

function flashScanSuccess() {
  document.body.classList.remove('scan-success-flash');
  void document.body.offsetWidth;
  document.body.classList.add('scan-success-flash');
  window.setTimeout(() => document.body.classList.remove('scan-success-flash'), 700);
}

function completeLiveScan(state, config, value, text) {
  const frame = captureVideoFrame(state);
  state.image = frame;
  state.rotation = LIVE_ROTATION;
  state.crop = null;
  document.getElementById(config.rawId).textContent = text.trim();
  document.getElementById(config.fieldId).value = value;
  stopLiveScan(state, false);
  if (frame) renderPreview(state);
  document.getElementById(config.progressId).textContent = `Détection confirmée : ${value}`;
  flashScanSuccess();
}

function scheduleLiveScan(state, config, delay = LIVE_INTERVAL_MS) {
  if (!state.liveActive) return;
  state.liveTimer = window.setTimeout(() => scanLiveFrame(state, config), delay);
}

async function scanLiveFrame(state, config) {
  state.liveTimer = null;
  if (!state.liveActive || state.liveBusy) return;
  if (state.liveVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    scheduleLiveScan(state, config);
    return;
  }

  state.liveBusy = true;
  state.rotation = LIVE_ROTATION;
  state.crop = LIVE_CROP;
  const frame = captureVideoFrame(state);
  if (!frame) {
    state.liveBusy = false;
    state.liveStatus.textContent = 'Mise au point de la caméra...';
    scheduleLiveScan(state, config);
    return;
  }
  state.image = frame;
  try {
    const text = await withOcrLock(() => runOcr(state, state.liveStatus));
    if (!state.liveActive) return;
    const value = config.extract(text);
    if (value) {
      const normalized = normalizeLiveValue(value);
      state.liveStableMisses = 0;
      if (normalized === state.liveStableValue) {
        state.liveStableCount += 1;
      } else {
        state.liveStableValue = normalized;
        state.liveStableCount = 1;
      }
      state.liveStatus.textContent = `Lecture détectée (${state.liveStableCount}/${LIVE_CONFIRMATIONS}) : ${value}`;
      if (state.liveStableCount >= LIVE_CONFIRMATIONS) {
        completeLiveScan(state, config, value, text);
      }
    } else {
      state.liveStableMisses += 1;
      if (state.liveStableMisses > ROTATIONS.length + 1) {
        state.liveStableValue = '';
        state.liveStableCount = 0;
      }
      state.liveStatus.textContent = 'Recherche en cours...';
    }
  } catch (e) {
    if (state.liveActive) state.liveStatus.textContent = 'Lecture impossible, réessayez...';
  } finally {
    state.liveBusy = false;
    scheduleLiveScan(state, config);
  }
}

async function startLiveScan(state, config) {
  if (state.liveActive) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('La caméra nécessite une page HTTPS ou localhost dans un navigateur compatible.');
    return;
  }

  state.liveSaved = {
    image: state.image,
    rotation: state.rotation,
    invert: state.invert,
    crop: state.crop,
  };
  state.image = null;
  state.crop = null;
  state.rotation = 0;
  state.invert = false;
  state.liveActive = true;
  state.liveBusy = false;
  state.liveRotationIndex = 0;
  state.liveStableValue = '';
  state.liveStableCount = 0;
  state.liveStableMisses = 0;
  state.liveBtn.disabled = true;
  state.fileInput.disabled = true;
  state.canvas.hidden = true;
  state.liveWrap.hidden = false;
  state.liveStatus.textContent = 'Connexion à la caméra...';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (!state.liveActive) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    state.liveStream = stream;
    state.liveVideo.srcObject = stream;
    await state.liveVideo.play();
    state.liveStatus.textContent = 'Cadrez le texte dans le viseur...';
    scheduleLiveScan(state, config, 400);
  } catch (e) {
    stopLiveScan(state, true);
    const message = e.name === 'NotAllowedError'
      ? "L'accès à la caméra a été refusé."
      : "Impossible d'ouvrir la caméra.";
    alert(message);
  }
}

async function runAssetOcr() {
  const btn = document.getElementById('ocrAsset');
  const progressEl = document.getElementById('progressAsset');
  btn.disabled = true;
  if (assetState.crop === null) progressEl.textContent = 'En attente...';
  try {
    // Si l'utilisateur a lui-même dessiné un cadre, on respecte son choix ;
    // sinon on détecte automatiquement l'orientation et la zone du texte.
    const text = await withOcrLock(() => (assetState.crop
      ? runOcr(assetState, progressEl)
      : autoRecognize(assetState, scoreAssetLines, progressEl)));
    document.getElementById('rawAsset').textContent = text.trim();
    const guess = extractAssetNumber(text);
    if (guess) document.getElementById('fieldAsset').value = guess;
  } catch (e) {
    progressEl.textContent = '';
    alert("Erreur pendant l'OCR : " + e.message);
  } finally {
    btn.disabled = false;
  }
}

async function runNameOcr() {
  const btn = document.getElementById('ocrName');
  const progressEl = document.getElementById('progressName');
  btn.disabled = true;
  if (nameState.crop === null) progressEl.textContent = 'En attente...';
  try {
    const text = await withOcrLock(() => (nameState.crop
      ? runOcr(nameState, progressEl)
      : autoRecognize(nameState, scoreNameLines, progressEl)));
    document.getElementById('rawName').textContent = text.trim();
    const guess = extractName(text);
    if (guess) document.getElementById('fieldName').value = guess;
  } catch (e) {
    progressEl.textContent = '';
    alert("Erreur pendant l'OCR : " + e.message);
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('ocrAsset').addEventListener('click', runAssetOcr);
document.getElementById('ocrName').addEventListener('click', runNameOcr);

// ---------- Liste des entrées (persistée localement sur l'appareil) ----------
function loadEntries() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function saveEntries(entries) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

let entries = loadEntries();
let editingIndex = null;

function renderTable() {
  const tbody = document.querySelector('#entryTable tbody');
  tbody.innerHTML = '';
  entries.forEach((entry, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${entry.date}</td>
      <td>${entry.heure}</td>
      <td>${escapeHtml(entry.asset)}</td>
      <td>${escapeHtml(entry.nom)}</td>
      <td>${escapeHtml(entry.bureau)}</td>
      <td>${escapeHtml(entry.commentaire)}</td>
      <td>
        <button class="row-edit" data-idx="${idx}" title="Modifier" aria-label="Modifier">✎</button>
        <button class="row-del" data-idx="${idx}" title="Supprimer" aria-label="Supprimer">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById('entryCount').textContent = entries.length;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

document.querySelector('#entryTable tbody').addEventListener('click', (e) => {
  const editBtn = e.target.closest('.row-edit');
  if (editBtn) {
    const idx = Number(editBtn.dataset.idx);
    const entry = entries[idx];
    if (!entry) return;
    editingIndex = idx;
    document.getElementById('fieldAsset').value = entry.asset;
    document.getElementById('fieldName').value = entry.nom;
    document.getElementById('fieldRoom').value = entry.bureau;
    document.getElementById('fieldComment').value = entry.commentaire;
    document.getElementById('rawAsset').textContent = '';
    document.getElementById('rawName').textContent = '';
    document.getElementById('addEntry').textContent = '💾 Enregistrer la modification';
    document.getElementById('cancelEdit').hidden = false;
    document.getElementById('step-extra').scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('fieldAsset').focus();
    return;
  }
  const btn = e.target.closest('.row-del');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  entries.splice(idx, 1);
  if (idx === editingIndex) resetEntryForm();
  else if (editingIndex !== null && idx < editingIndex) editingIndex -= 1;
  saveEntries(entries);
  renderTable();
});

function resetEntryForm() {
  editingIndex = null;
  document.getElementById('fieldAsset').value = '';
  document.getElementById('fieldName').value = '';
  document.getElementById('fieldComment').value = '';
  document.getElementById('rawAsset').textContent = '';
  document.getElementById('rawName').textContent = '';
  document.getElementById('addEntry').textContent = '➕ Ajouter à la liste';
  document.getElementById('cancelEdit').hidden = true;
}

document.getElementById('addEntry').addEventListener('click', () => {
  const asset = document.getElementById('fieldAsset').value.trim();
  const nom = document.getElementById('fieldName').value.trim();
  const bureau = document.getElementById('fieldRoom').value.trim();
  const commentaire = document.getElementById('fieldComment').value.trim();

  if (!asset || !nom) {
    alert("Merci de renseigner au minimum le N° Asset et le nom avant d'ajouter à la liste.");
    return;
  }

  if (editingIndex === null) {
    const now = new Date();
    entries.push({
      date: now.toLocaleDateString('fr-FR'),
      heure: now.toLocaleTimeString('fr-FR'),
      asset,
      nom,
      bureau,
      commentaire,
    });
  } else {
    entries[editingIndex] = {
      ...entries[editingIndex],
      asset,
      nom,
      bureau,
      commentaire,
    };
  }
  saveEntries(entries);
  renderTable();

  // Réinitialise les champs de saisie pour la prochaine machine (garde le bureau).
  resetEntryForm();
});

document.getElementById('cancelEdit').addEventListener('click', resetEntryForm);

document.getElementById('clearAll').addEventListener('click', () => {
  if (!entries.length) return;
  if (!confirm('Supprimer définitivement toutes les entrées de la liste ?')) return;
  entries = [];
  resetEntryForm();
  saveEntries(entries);
  renderTable();
});

function buildExportWorkbook() {
  const rows = entries.map((e) => ({
    Date: e.date,
    Heure: e.heure,
    'N° Asset': e.asset,
    'Nom de la personne connectée': e.nom,
    'Bureau / Salle': e.bureau,
    Commentaire: e.commentaire,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 28 }, { wch: 20 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'PC non attachés');
  return wb;
}

function getExportFile() {
  const now = new Date();
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const filename = `audit_bureau_propre_${stamp}.xlsx`;
  const data = XLSX.write(buildExportWorkbook(), { bookType: 'xlsx', type: 'array' });
  return new File([data], filename, {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

function downloadExportFile(file) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function ensureEntriesForExport() {
  if (!entries.length) {
    alert('La liste est vide.');
    return false;
  }
  return true;
}

document.getElementById('shareOneDrive').addEventListener('click', async () => {
  if (!ensureEntriesForExport()) return;
  const file = getExportFile();
  if (!navigator.share || !navigator.canShare || !navigator.canShare({ files: [file] })) {
    downloadExportFile(file);
    alert('Le partage natif n’est pas disponible ici. Le fichier a été téléchargé : ouvrez-le puis choisissez OneDrive.');
    return;
  }
  try {
    await navigator.share({
      title: 'Audit Bureau Propre',
      text: 'Export Excel de l’audit bureau propre',
      files: [file],
    });
  } catch (e) {
    if (e.name !== 'AbortError') {
      downloadExportFile(file);
      alert('Le partage n’a pas pu être ouvert. Le fichier a été téléchargé : choisissez OneDrive depuis vos fichiers.');
    }
  }
});

renderTable();
