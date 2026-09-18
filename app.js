'use strict';

/*
 * Audit Bureau Propre — logique 100% locale (aucun appel réseau).
 * OCR via Tesseract.js (fichiers vendor/ et lang/ servis localement).
 * Export via SheetJS (vendor/xlsx.full.min.js).
 */

const STORAGE_KEY = 'audit-bureau-propre-entries-v1';
const CONTEXT_STORAGE_KEY = 'audit-bureau-propre-context-v1';

// ---------- Etat des deux zones de capture (asset / nom) ----------
function createCaptureState(canvasId, wrapId, cropBoxId, liveBtnId, liveWrapId, liveVideoId, liveStatusId, stopLiveBtnId, fallbackInputId, ocrLoadingId, scanProgressId) {
  return {
    canvas: document.getElementById(canvasId),
    wrap: document.getElementById(wrapId),
    cropBox: document.getElementById(cropBoxId),
    liveBtn: document.getElementById(liveBtnId),
    liveWrap: document.getElementById(liveWrapId),
    scanLoading: document.getElementById(liveWrapId).querySelector('.scan-loading'),
    liveResult: document.getElementById(liveWrapId).querySelector('.live-scan-result'),
    liveResultValue: document.getElementById(liveWrapId).querySelector('.live-scan-result strong'),
    liveVideo: document.getElementById(liveVideoId),
    liveStatus: document.getElementById(liveStatusId),
    stopLiveBtn: document.getElementById(stopLiveBtnId),
    fallbackInput: document.getElementById(fallbackInputId),
    ocrLoading: document.getElementById(ocrLoadingId),
    scanProgress: document.getElementById(scanProgressId),
    image: null,
    rotation: 0,
    invert: false,
    // Zone recadrée, en fractions [0,1] du canvas affiché (post-rotation). null = image entière.
    crop: null,
    liveStream: null,
    liveActive: false,
    liveBusy: false,
    scanReady: false,
    liveSaved: null,
    ocrReady: false,
    analysisGeneration: 0,
  };
}

const assetState = createCaptureState(
  'canvasAsset', 'wrapAsset', 'cropBoxAsset', 'startLiveAsset', 'liveWrapAsset', 'liveVideoAsset',
  'liveStatusAsset', 'stopLiveAsset', 'fallbackInputAsset', 'ocrLoadingAsset', 'scanProgressAsset'
);
const nameState = createCaptureState(
  'canvasName', 'wrapName', 'cropBoxName', 'startLiveName', 'liveWrapName', 'liveVideoName',
  'liveStatusName', 'stopLiveName', 'fallbackInputName', 'ocrLoadingName', 'scanProgressName'
);

function getImageDimensions(image) {
  return {
    width: image.videoWidth || image.naturalWidth || image.width,
    height: image.videoHeight || image.naturalHeight || image.height,
  };
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

// Renforce localement les lettres sombres sur un fond clair sans dépendre de
// la luminosité générale de la photo.
function applyAdaptiveThreshold(imgData, width, height, invert) {
  const d = imgData.data;
  const pixels = width * height;
  const gray = new Uint8Array(pixels);
  const stride = width + 1;
  const integral = new Float32Array((height + 1) * stride);

  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const value = d[pixel * 4];
      gray[pixel] = value;
      rowSum += value;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
    }
  }

  const radius = Math.max(8, Math.round(Math.min(width, height) * 0.015));
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = integral[(y1 + 1) * stride + x1 + 1]
        - integral[y0 * stride + x1 + 1]
        - integral[(y1 + 1) * stride + x0]
        + integral[y0 * stride + x0];
      let value = gray[y * width + x] < (sum / area) - 8 ? 0 : 255;
      if (invert) value = 255 - value;
      const offset = (y * width + x) * 4;
      d[offset] = d[offset + 1] = d[offset + 2] = value;
    }
  }
}

// Construit un canvas hors-écran recadré + prétraité (niveaux de gris,
// contraste étiré, inversion optionnelle) prêt pour l'OCR.
function buildOcrCanvas(state, preprocess = 'standard') {
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

  // 3) Niveaux de gris + prétraitement adapté au type de texte.
  const imgData = ctx.getImageData(0, 0, outW, outH);
  const d = imgData.data;
  if (preprocess === 'adaptive') {
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = gray;
    }
    applyAdaptiveThreshold(imgData, outW, outH, invert);
    ctx.putImageData(imgData, 0, 0);
    return off;
  }

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

function wireCapture(state) {
  state.liveBtn.addEventListener('click', () => {
    const config = getLiveConfig(state);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      openFallbackCapture(state, config);
      return;
    }
    startLiveScan(state, config);
  });
  state.stopLiveBtn.addEventListener('click', () => stopLiveScan(state, true));
  state.fallbackInput.addEventListener('change', async () => {
    const file = state.fallbackInput.files?.[0];
    state.fallbackInput.value = '';
    if (!file) return;
    try {
      const image = await loadImageFile(file);
      await analyzeCapturedImage(state, getLiveConfig(state), image, false);
    } catch (e) {
      document.getElementById(getLiveConfig(state).progressId).textContent = 'Photo impossible à lire.';
    }
  });
  state.liveWrap.addEventListener('click', (e) => {
    if (e.target.closest('.live-scan-result')) {
      acceptLiveResult(state, getLiveConfig(state));
      return;
    }
    if (e.target.closest('button, .camera-controls, .scan-loading')) return;
    captureLivePhoto(state, getLiveConfig(state));
  });
  state.liveWrap.addEventListener('keydown', (e) => {
    if (!e.target.closest('.live-scan-result') || !['Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    acceptLiveResult(state, getLiveConfig(state));
  });
}

wireCapture(assetState);
wireCapture(nameState);

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

function setOcrLoading(state, active) {
  state.ocrLoading.hidden = !active;
}

function setScanLoading(state, active, message) {
  const loading = state.scanLoading;
  if (!loading) return;
  loading.hidden = !active;
  if (message) loading.querySelector('.scan-loading-text').textContent = message;
}

async function prepareOcr(state) {
  if (state.ocrReady) return true;
  setOcrLoading(state, true);
  try {
    await getWorker();
    state.ocrReady = true;
    return true;
  } catch (e) {
    state.ocrReady = false;
    return false;
  } finally {
    if (state.ocrReady) setOcrLoading(state, false);
  }
}

function scheduleOcrPreload() {
  const preload = () => {
    getWorker()
      .then(() => {
        assetState.ocrReady = true;
        nameState.ocrReady = true;
      })
      .catch(() => {
        workerPromise = null;
      });
  };
  if (window.requestIdleCallback) {
    window.requestIdleCallback(preload, { timeout: 2500 });
  } else {
    window.setTimeout(preload, 800);
  }
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

// ---------- Détection automatique (orientation + zone de texte) ----------
const ROTATIONS = [90, 0, 270];
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

// Repère la meilleure zone de texte puis la relit en haute qualité. L'étiquette
// teste d'abord l'orientation la plus fréquente, puis les deux autres ; le nom
// est traité directement à 0 degré.
async function autoRecognize(
  state,
  scoreFn,
  detectOrientation,
  onProgress,
  isCurrent,
  preprocess = 'standard',
  progressFloor = 0,
  reportNoMatch = true
) {
  const reportProgress = (percent, message) => {
    const adjustedPercent = progressFloor
      ? progressFloor + Math.round((percent * (100 - progressFloor)) / 100)
      : percent;
    onProgress(adjustedPercent, message);
  };
  const worker = await getWorker();
  let best = null;
  const rotations = detectOrientation ? ROTATIONS : [0];

  await worker.setParameters({ tessedit_pageseg_mode: '11' });
  reportProgress(10, detectOrientation
    ? 'Préparation des 3 orientations (90° en premier)...'
    : preprocess === 'adaptive' ? 'Renforcement du contraste de l’écran...' : 'Recherche du nom...');
  for (let i = 0; i < rotations.length; i += 1) {
    if (!isCurrent()) return '';
    const rotation = rotations[i];
    const percent = 15 + Math.round(((i + 1) / rotations.length) * 60);
    const message = detectOrientation
      ? `Reconnaissance de l'orientation... (${i + 1}/${rotations.length})`
      : 'Reconnaissance du nom...';
    reportProgress(percent, message);
    state.rotation = rotation;
    state.crop = null;
    const canvas = buildOcrCanvas(state, preprocess);
    // eslint-disable-next-line no-await-in-loop
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    if (!isCurrent()) return '';
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
    if (reportNoMatch) reportProgress(100, 'Aucun texte détecté.');
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

  reportProgress(90, 'Lecture précise...');
  await worker.setParameters({ tessedit_pageseg_mode: '6' });
  const refinedCanvas = buildOcrCanvas(state, preprocess);
  const { data } = await worker.recognize(refinedCanvas, {}, { text: true });
  if (!isCurrent()) return '';
  reportProgress(100, 'Reconnaissance terminée.');
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

function getLiveConfig(state) {
  if (state === assetState) {
    return {
      fieldId: 'fieldAsset',
      progressId: 'progressAsset',
      resultId: 'scanResultAsset',
      resultValueId: 'scanResultValueAsset',
      scanProgressId: 'scanProgressAsset',
      score: scoreAssetLines,
      extract: extractAssetNumber,
      detectOrientation: true,
    };
  }
  return {
    fieldId: 'fieldName',
    progressId: 'progressName',
    resultId: 'scanResultName',
    resultValueId: 'scanResultValueName',
    scanProgressId: 'scanProgressName',
    score: scoreNameLines,
    detectOrientation: false,
    extract: (text) => {
      const value = extractName(text);
      return scoreNameLine(value) >= 2 ? value : '';
    },
  };
}

function restoreSavedState(state, saved) {
  if (!saved) return;
  state.image = saved.image;
  state.rotation = saved.rotation;
  state.invert = saved.invert;
  state.crop = saved.crop;
  if (state.image) renderPreview(state);
}

function setCaptureActive(active) {
  document.body.classList.toggle('capture-active', active);
}

async function enterCaptureFullscreen(element) {
  if (!element.requestFullscreen) return;
  try {
    await element.requestFullscreen();
  } catch (e) {
    // Le mode plein écran visuel reste disponible si le navigateur le refuse.
  }
}

async function exitCaptureFullscreen(element) {
  if (document.fullscreenElement !== element || !document.exitFullscreen) return;
  try {
    await document.exitFullscreen();
  } catch (e) {
    // Certains navigateurs quittent déjà le plein écran avec le bouton système.
  }
}

function updateCaptureButtons(state) {
  state.liveBtn.disabled = state.liveActive;
}

function updateScanProgress(state, config, liveCapture, percent, message) {
  const progressEl = document.getElementById(config.progressId);
  progressEl.textContent = message;
  const scanProgress = state.scanProgress;
  const bar = scanProgress.querySelector('progress');
  const text = scanProgress.querySelector('.scan-progress-text');
  const percentLabel = scanProgress.querySelector('.scan-progress-percent');
  const boundedPercent = Math.min(100, Math.max(0, percent));
  bar.value = boundedPercent;
  text.textContent = message;
  percentLabel.textContent = `${boundedPercent} %`;
  scanProgress.hidden = !message;
  if (liveCapture) state.liveStatus.textContent = message;
}

function resetScanProgress(state, config) {
  updateScanProgress(state, config, false, 0, '');
}

function stopLiveScan(state, restore = true) {
  state.analysisGeneration += 1;
  state.liveActive = false;
  state.liveBusy = false;
  state.scanReady = false;
  if (state.liveStream) {
    state.liveStream.getTracks().forEach((track) => track.stop());
    state.liveStream = null;
  }
  state.liveVideo.pause();
  state.liveVideo.srcObject = null;
  state.liveWrap.hidden = true;
  state.canvas.hidden = false;
  const exitPromise = exitCaptureFullscreen(state.liveWrap);
  setOcrLoading(state, false);
  setScanLoading(state, false);
  setCaptureActive(false);
  updateCaptureButtons(state);
  state.stopLiveBtn.disabled = false;
  resetScanProgress(state, getLiveConfig(state));
  if (restore) {
    restoreSavedState(state, state.liveSaved);
    state.liveSaved = null;
  }
  if (!restore) state.liveSaved = null;
  state.liveStatus.textContent = '';
  return exitPromise;
}

function captureVideoFrame(video) {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) return null;
  const frame = document.createElement('canvas');
  frame.width = videoWidth;
  frame.height = videoHeight;
  frame.getContext('2d').drawImage(video, 0, 0, videoWidth, videoHeight);
  return frame;
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image illisible'));
    };
    image.src = url;
  });
}

function flashScanSuccess() {
  document.body.classList.remove('scan-success-flash');
  document.body.classList.remove('scan-failure-flash');
  void document.body.offsetWidth;
  document.body.classList.add('scan-success-flash');
  window.setTimeout(() => document.body.classList.remove('scan-success-flash'), 700);
}

function flashScanFailure() {
  document.body.classList.remove('scan-success-flash');
  document.body.classList.remove('scan-failure-flash');
  void document.body.offsetWidth;
  document.body.classList.add('scan-failure-flash');
  window.setTimeout(() => document.body.classList.remove('scan-failure-flash'), 700);
}

function flashScanCapture(state) {
  state.liveWrap.classList.remove('capture-photo-flash');
  void state.liveWrap.offsetWidth;
  state.liveWrap.classList.add('capture-photo-flash');
  window.setTimeout(() => state.liveWrap.classList.remove('capture-photo-flash'), 300);
}

function flashLiveFailure(state) {
  state.liveWrap.classList.remove('capture-failure-flash');
  void state.liveWrap.offsetWidth;
  state.liveWrap.classList.add('capture-failure-flash');
  window.setTimeout(() => state.liveWrap.classList.remove('capture-failure-flash'), 700);
  flashScanFailure();
}

function clearLiveResult(state, config) {
  state.analysisGeneration += 1;
  document.getElementById(config.resultId).hidden = true;
  document.getElementById(config.resultValueId).textContent = '';
  state.liveResult.hidden = true;
  state.liveResultValue.textContent = '';
  resetScanProgress(state, config);
}

function acceptLiveResult(state, config) {
  const value = state.liveResultValue.textContent;
  if (!value) return;
  document.getElementById(config.resultValueId).textContent = value;
  document.getElementById(config.resultId).hidden = false;
  stopLiveScan(state, false);
}

function prepareLiveRetake(state, config) {
  clearLiveResult(state, config);
  document.getElementById(config.fieldId).value = '';
  state.rotation = 0;
  state.crop = null;
}

function resetScanVerification(state, config) {
  clearLiveResult(state, config);
  document.getElementById(config.fieldId).value = '';
  state.rotation = 0;
  state.crop = null;
}

async function analyzeCapturedImage(state, config, image, liveCapture) {
  if ((liveCapture && !state.liveActive) || (state.liveBusy && state !== assetState)) return;
  if (state.liveBusy && state === assetState) resetScanVerification(state, config);
  const analysisGeneration = ++state.analysisGeneration;
  state.liveBusy = true;
  state.liveBtn.disabled = true;
  const progressEl = document.getElementById(config.progressId);
  const statusEl = liveCapture ? state.liveStatus : progressEl;
  try {
    if (!await prepareOcr(state)) {
      statusEl.textContent = 'OCR indisponible. Réessayez.';
      return;
    }
    if (analysisGeneration !== state.analysisGeneration) return;
    const reportProgress = (percent, message) => {
      if (analysisGeneration === state.analysisGeneration) {
        updateScanProgress(state, config, liveCapture, percent, message);
      }
    };
    reportProgress(5, liveCapture ? 'Photo prise, démarrage de la reconnaissance...' : 'Démarrage de la reconnaissance...');
    if (liveCapture) flashScanCapture(state);
    state.rotation = 0;
    state.crop = null;
    state.image = image;
    renderPreview(state);
    const text = await withOcrLock(async () => {
      let recognizedText = await autoRecognize(
        state,
        config.score,
        config.detectOrientation,
        reportProgress,
        () => analysisGeneration === state.analysisGeneration,
        'standard',
        0,
        !config.retryPreprocess
      );
      if (config.retryPreprocess && !config.extract(recognizedText)) {
        recognizedText = await autoRecognize(
          state,
          config.score,
          config.detectOrientation,
          reportProgress,
          () => analysisGeneration === state.analysisGeneration,
          'adaptive',
          80
        );
      }
      return recognizedText;
    });
    if (analysisGeneration !== state.analysisGeneration) return;
    if (liveCapture && !state.liveActive) return;
    const value = config.extract(text);
    if (value) {
      document.getElementById(config.fieldId).value = value;
      if (liveCapture) {
        resetScanProgress(state, config);
        state.liveResultValue.textContent = value;
        state.liveResult.hidden = false;
        state.liveStatus.textContent = 'Valeur trouvée. Touchez l\'encart vert pour la garder, ou l\'image pour rescanner.';
      } else {
        document.getElementById(config.resultValueId).textContent = value;
        document.getElementById(config.resultId).hidden = false;
      }
      flashScanSuccess();
    } else {
      const message = liveCapture
        ? 'Aucun texte reconnu. Touchez l\'image pour réessayer.'
        : 'Aucun texte reconnu. Relancez la capture pour réessayer.';
      updateScanProgress(state, config, liveCapture, 100, message);
      if (liveCapture) flashLiveFailure(state);
      else flashScanFailure();
    }
  } catch (e) {
    if (analysisGeneration === state.analysisGeneration && (!liveCapture || state.liveActive)) {
      const message = liveCapture
        ? 'Lecture impossible. Touchez l\'image pour réessayer.'
        : 'Lecture impossible. Relancez la capture pour réessayer.';
      updateScanProgress(state, config, liveCapture, 100, message);
      if (liveCapture) flashLiveFailure(state);
      else flashScanFailure();
    }
  } finally {
    if (analysisGeneration === state.analysisGeneration) {
      state.liveBusy = false;
      updateCaptureButtons(state);
    }
  }
}

async function captureLivePhoto(state, config) {
  if (!state.liveActive) return;
  if (!state.scanReady) {
    state.liveStatus.textContent = 'Préparation du scan en cours...';
    return;
  }
  if (state.liveBusy && state !== assetState) return;
  if (!state.liveBusy) prepareLiveRetake(state, config);
  if (state.liveBusy && state === assetState) resetScanVerification(state, config);
  const frame = captureVideoFrame(state.liveVideo);
  if (!frame) {
    state.liveStatus.textContent = 'Mise au point de la caméra...';
    return;
  }
  await analyzeCapturedImage(state, config, frame, true);
}

function openFallbackCapture(state, config) {
  clearLiveResult(state, config);
  document.getElementById(config.progressId).textContent = 'Ouverture de la caméra...';
  state.fallbackInput.value = '';
  state.fallbackInput.click();
}

async function startLiveScan(state, config) {
  if (state.liveActive) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    openFallbackCapture(state, config);
    return;
  }

  state.liveSaved = {
    image: state.image,
    rotation: state.rotation,
    invert: state.invert,
    crop: state.crop,
  };
  clearLiveResult(state, config);
  state.image = null;
  state.crop = null;
  state.rotation = 0;
  state.invert = false;
  state.liveActive = true;
  state.liveBusy = false;
  state.scanReady = false;
  updateCaptureButtons(state);
  state.canvas.hidden = true;
  state.liveWrap.hidden = false;
  setScanLoading(state, true, 'Chargement du moteur OCR...');
  setCaptureActive(true);
  state.liveStatus.textContent = 'Connexion à la caméra...';
  const ocrReadyPromise = prepareOcr(state);

  try {
    await enterCaptureFullscreen(state.liveWrap);
    setScanLoading(state, true, 'Ouverture de la caméra...');
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
    setScanLoading(state, true, 'Finalisation du scan...');
    if (!await ocrReadyPromise) {
      await stopLiveScan(state, true);
      state.liveStatus.textContent = 'OCR indisponible. Réessayez.';
      return;
    }
    state.scanReady = true;
    setScanLoading(state, false);
    state.liveStatus.textContent = 'Cadrez le texte puis touchez l\'image pour analyser.';
  } catch (e) {
    stopLiveScan(state, true);
    const message = e.name === 'NotAllowedError'
      ? "L'accès à la caméra a été refusé."
      : "Impossible d'ouvrir la caméra.";
    alert(message);
  }
}

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

function loadAuditContext() {
  try {
    const stored = JSON.parse(localStorage.getItem(CONTEXT_STORAGE_KEY) || '{}');
    return {
      etage: String(stored.etage || ''),
      bu: String(stored.bu || ''),
      agence: String(stored.agence || ''),
    };
  } catch (e) {
    return { etage: '', bu: '', agence: '' };
  }
}

function saveAuditContext(context) {
  localStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(context));
}

let auditContext = loadAuditContext();
const contextFieldMap = {
  fieldFloor: 'etage',
  fieldBu: 'bu',
  fieldAgency: 'agence',
};

Object.entries(contextFieldMap).forEach(([fieldId, contextKey]) => {
  const field = document.getElementById(fieldId);
  field.value = auditContext[contextKey];
  field.addEventListener('input', () => {
    auditContext = {
      ...auditContext,
      [contextKey]: field.value,
    };
    saveAuditContext(auditContext);
  });
});

let entries = loadEntries();
let editingIndex = null;
let editingContextBackup = null;

if (entries.length) {
  document.querySelector('#audit-context details').open = false;
}

function getAuditContextFromFields() {
  return {
    etage: document.getElementById('fieldFloor').value.trim(),
    bu: document.getElementById('fieldBu').value.trim(),
    agence: document.getElementById('fieldAgency').value.trim(),
  };
}

function setAuditContextFields(context) {
  auditContext = {
    etage: context.etage || '',
    bu: context.bu || '',
    agence: context.agence || '',
  };
  document.getElementById('fieldFloor').value = auditContext.etage;
  document.getElementById('fieldBu').value = auditContext.bu;
  document.getElementById('fieldAgency').value = auditContext.agence;
}

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
        <button class="row-edit" data-idx="${idx}" title="Modifier cette ligne" aria-label="Modifier cette ligne">✎ Modifier</button>
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
    editingContextBackup = getAuditContextFromFields();
    editingIndex = idx;
    document.getElementById('fieldAsset').value = entry.asset;
    document.getElementById('fieldName').value = entry.nom;
    setAuditContextFields({
      etage: entry.etage || editingContextBackup.etage,
      bu: entry.bu || editingContextBackup.bu,
      agence: entry.agence || editingContextBackup.agence,
    });
    document.getElementById('fieldRoom').value = entry.bureau;
    document.getElementById('fieldComment').value = entry.commentaire;
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
  if (editingIndex !== null && editingContextBackup) {
    setAuditContextFields(editingContextBackup);
    saveAuditContext(auditContext);
  }
  editingIndex = null;
  editingContextBackup = null;
  document.getElementById('fieldAsset').value = '';
  document.getElementById('fieldName').value = '';
  clearLiveResult(assetState, getLiveConfig(assetState));
  clearLiveResult(nameState, getLiveConfig(nameState));
  document.getElementById('fieldComment').value = '';
  document.getElementById('addEntry').textContent = '➕ Ajouter à la liste';
  document.getElementById('cancelEdit').hidden = true;
}

document.getElementById('addEntry').addEventListener('click', () => {
  const asset = document.getElementById('fieldAsset').value.trim();
  const nom = document.getElementById('fieldName').value.trim();
  const bureau = document.getElementById('fieldRoom').value.trim();
  const commentaire = document.getElementById('fieldComment').value.trim();
  auditContext = getAuditContextFromFields();
  saveAuditContext(auditContext);

  const addingEntry = editingIndex === null;
  if (addingEntry) {
    const now = new Date();
    entries.push({
      date: now.toLocaleDateString('fr-FR'),
      heure: now.toLocaleTimeString('fr-FR'),
      asset,
      nom,
      etage: auditContext.etage,
      bu: auditContext.bu,
      agence: auditContext.agence,
      bureau,
      commentaire,
    });
  } else {
    entries[editingIndex] = {
      ...entries[editingIndex],
      asset,
      nom,
      etage: auditContext.etage,
      bu: auditContext.bu,
      agence: auditContext.agence,
      bureau,
      commentaire,
    };
  }
  saveEntries(entries);
  renderTable();
  if (addingEntry) document.querySelector('#audit-context details').open = false;

  // Réinitialise les champs de saisie pour la prochaine machine (garde le bureau).
  editingContextBackup = null;
  resetEntryForm();
});

document.getElementById('cancelEdit').addEventListener('click', resetEntryForm);

document.getElementById('clearAll').addEventListener('click', () => {
  if (entries.length && !confirm('Supprimer définitivement toutes les entrées de la liste ?')) return;
  entries = [];
  editingIndex = null;
  editingContextBackup = null;
  resetEntryForm();
  setAuditContextFields({});
  document.getElementById('fieldRoom').value = '';
  saveAuditContext(auditContext);
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(CONTEXT_STORAGE_KEY);
  document.querySelector('#audit-context details').open = true;
  renderTable();
});

function buildExportWorkbook() {
  const rows = entries.map((e) => ({
    Date: e.date,
    Heure: e.heure,
    'N° Asset': e.asset,
    'Nom de la personne connectée': e.nom,
    Étage: e.etage || '',
    BU: e.bu || '',
    Agence: e.agence || '',
    'Bureau / Salle': e.bureau,
    Commentaire: e.commentaire,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 28 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 20 }, { wch: 30 }];
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
scheduleOcrPreload();
