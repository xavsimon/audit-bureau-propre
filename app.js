'use strict';

/*
 * Audit Bureau Propre — logique 100% locale (aucun appel réseau).
 * OCR via Tesseract.js (fichiers vendor/ et lang/ servis localement).
 * Export via SheetJS (vendor/xlsx.full.min.js).
 */

const STORAGE_KEY = 'audit-bureau-propre-entries-v1';
const AUDIT_STATS_STORAGE_KEY = 'audit-bureau-propre-stats-v1';
const UNSECURED_ENTRIES_STORAGE_KEY = 'audit-bureau-propre-unsecured-v1';
const OTHER_COMMENTS_STORAGE_KEY = 'audit-bureau-propre-other-v1';

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
  reportNoMatch = true,
  diagnostics = null
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
    const preprocessingStartedAt = performance.now();
    const canvas = buildOcrCanvas(state, preprocess);
    const preprocessingMs = Math.round(performance.now() - preprocessingStartedAt);
    const recognitionStartedAt = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const { data } = await worker.recognize(canvas, {}, { blocks: true });
    const recognitionMs = Math.round(performance.now() - recognitionStartedAt);
    if (!isCurrent()) return '';
    const lines = flattenLines(data);
    const { line, score } = scoreFn(lines);
    if (diagnostics) {
      diagnostics.rotations.push({
        rotation,
        imageWidth: canvas.width,
        imageHeight: canvas.height,
        preprocessingMs,
        recognitionMs,
        lines: lines.map((item) => ({
          text: item.text,
          confidence: item.confidence,
          bbox: item.bbox,
        })),
        selectedText: line?.text || '',
        selectedConfidence: line?.confidence ?? null,
        selectionScore: Number.isFinite(score) ? score : null,
      });
    }
    if (line && score > (best ? best.score : -Infinity)) {
      best = {
        rotation,
        score,
        lineText: line.text,
        lineConfidence: line.confidence,
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
    if (diagnostics) diagnostics.selectedDetection = null;
    state.rotation = 0;
    state.crop = null;
    renderPreview(state);
    if (reportNoMatch) reportProgress(100, 'Aucun texte détecté.');
    return '';
  }
  if (diagnostics) {
    diagnostics.selectedDetection = {
      rotation: best.rotation,
      text: best.lineText,
      confidence: best.lineConfidence,
      selectionScore: best.score,
      bbox: best.crop,
    };
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
  const refinementPreprocessingStartedAt = performance.now();
  const refinedCanvas = buildOcrCanvas(state, preprocess);
  const refinementPreprocessingMs = Math.round(performance.now() - refinementPreprocessingStartedAt);
  const refinementStartedAt = performance.now();
  const { data } = await worker.recognize(refinedCanvas, {}, { text: true });
  const refinementMs = Math.round(performance.now() - refinementStartedAt);
  if (!isCurrent()) return '';
  if (diagnostics) {
    diagnostics.refinement = {
      confidence: data.confidence ?? null,
      text: data.text || '',
      imageWidth: refinedCanvas.width,
      imageHeight: refinedCanvas.height,
      preprocessingMs: refinementPreprocessingMs,
      recognitionMs: refinementMs,
    };
  }
  reportProgress(100, 'Reconnaissance terminée.');
  return data.text || '';
}

// ---------- Extraction heuristique ----------
function extractAssetNumber(text) {
  const cleaned = text.replace(/\r/g, '');
  let m = cleaned.match(/asset[^A-Za-z0-9]{0,4}([A-Za-z0-9][A-Za-z0-9\-]{2,14})/i);
  if (m) return normalizeAssetNumber(m[1]);
  m = cleaned.match(/\b([A-Z5]{1,3}\d{4,8})\b/);
  if (m) return normalizeAssetNumber(m[1]);
  return '';
}

function normalizeAssetNumber(value) {
  const normalized = value.toUpperCase();
  return normalized.startsWith('5') ? `S${normalized.slice(1)}` : normalized;
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
  // isolée...) du type "Paul DUGENOU - à".
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
      fieldId: 'unsecuredAsset',
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
    fieldId: 'unsecuredName',
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
  const progress = document.getElementById(config.progressId);
  progress.textContent = window.isSecureContext
    ? 'Scanner live indisponible. Ouverture de la caméra photo...'
    : 'Mode live indisponible en HTTP sur iOS. La caméra photo va s\'ouvrir ; utilisez HTTPS pour garder le scanner ouvert.';
  state.fallbackInput.value = '';
  state.fallbackInput.click();
}

async function startLiveScan(state, config) {
  if (state.liveActive) return;
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
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

function loadAuditStats() {
  try {
    const stored = JSON.parse(localStorage.getItem(AUDIT_STATS_STORAGE_KEY) || '{}');
    return {
      secured: Math.max(0, Number.parseInt(stored.secured, 10) || 0),
      unsecuredWithCollaborator: Math.max(0, Number.parseInt(stored.unsecuredWithCollaborator, 10) || 0),
    };
  } catch (e) {
    return { secured: 0, unsecuredWithCollaborator: 0 };
  }
}

function loadStoredList(key) {
  try {
    const stored = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch (e) {
    return [];
  }
}

function saveStoredList(key, values) {
  localStorage.setItem(key, JSON.stringify(values));
}

function saveAuditStats() {
  localStorage.setItem(AUDIT_STATS_STORAGE_KEY, JSON.stringify(auditStats));
}

let entries = loadEntries();
let auditStats = loadAuditStats();
let unsecuredEntries = loadStoredList(UNSECURED_ENTRIES_STORAGE_KEY);
let otherComments = loadStoredList(OTHER_COMMENTS_STORAGE_KEY);
let editingUnsecuredIndex = null;

function renderAuditCounters() {
  document.getElementById('securedCount').textContent = auditStats.secured;
  document.getElementById('unsecuredCount').textContent = auditStats.unsecuredWithCollaborator;
  document.getElementById('unsecuredFreeCount').textContent = unsecuredEntries.length;
  document.getElementById('otherCount').textContent = otherComments.length;
  const totalSeen = auditStats.secured + auditStats.unsecuredWithCollaborator + unsecuredEntries.length;
  const securedRate = totalSeen
    ? Math.round(((auditStats.secured + auditStats.unsecuredWithCollaborator) / totalSeen) * 100)
    : 0;
  const unsecuredRate = totalSeen
    ? Math.round((unsecuredEntries.length / totalSeen) * 100)
    : 0;
  document.getElementById('totalSeenCount').textContent = totalSeen;
  document.getElementById('securedRate').textContent = `${securedRate} %`;
  document.getElementById('unsecuredRate').textContent = `${unsecuredRate} %`;
}

function changeAuditCounter(counter, amount) {
  auditStats[counter] = Math.max(0, auditStats[counter] + amount);
  saveAuditStats();
  renderAuditCounters();
}

document.getElementById('incrementSecured').addEventListener('click', () => changeAuditCounter('secured', 1));
document.getElementById('decrementSecured').addEventListener('click', () => changeAuditCounter('secured', -1));
document.getElementById('incrementUnsecured').addEventListener('click', () => changeAuditCounter('unsecuredWithCollaborator', 1));
document.getElementById('decrementUnsecured').addEventListener('click', () => changeAuditCounter('unsecuredWithCollaborator', -1));
renderAuditCounters();

function openAuditModal(id) {
  const modal = document.getElementById(id);
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function closeAuditModal(id) {
  const modal = document.getElementById(id);
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
  if (!document.querySelector('.audit-modal:not([hidden])')) document.body.classList.remove('modal-open');
}

function prepareModalCapture(state) {
  const config = getLiveConfig(state);
  clearLiveResult(state, config);
  document.getElementById(config.fieldId).value = '';
  state.liveBtn.click();
}

function resetUnsecuredModal() {
  document.getElementById('unsecuredAsset').value = '';
  document.getElementById('unsecuredName').value = '';
  document.getElementById('unsecuredComment').value = '';
  document.getElementById('unsecured-modal-title').textContent = 'Ajouter un PC non sécurisé';
  editingUnsecuredIndex = null;
}

function openUnsecuredModal(index = null) {
  if (index === null) {
    resetUnsecuredModal();
  } else {
    const entry = unsecuredEntries[index];
    if (!entry) return;
    editingUnsecuredIndex = index;
    document.getElementById('unsecured-modal-title').textContent = 'Modifier un PC non sécurisé';
    document.getElementById('unsecuredAsset').value = entry.asset || '';
    document.getElementById('unsecuredName').value = entry.nom || '';
    document.getElementById('unsecuredComment').value = entry.commentaire || '';
  }
  openAuditModal('unsecuredModal');
}

document.getElementById('addUnsecuredFree').addEventListener('click', () => {
  openUnsecuredModal();
});

document.getElementById('scanUnsecuredAsset').addEventListener('click', () => prepareModalCapture(assetState));
document.getElementById('scanUnsecuredName').addEventListener('click', () => prepareModalCapture(nameState));
document.getElementById('cancelUnsecured').addEventListener('click', () => {
  closeAuditModal('unsecuredModal');
  resetUnsecuredModal();
});
document.getElementById('confirmUnsecured').addEventListener('click', () => {
  const asset = document.getElementById('unsecuredAsset').value.trim();
  const nom = document.getElementById('unsecuredName').value.trim();
  const commentaire = document.getElementById('unsecuredComment').value.trim();
  if (!asset && !nom && !commentaire) {
    alert('Renseignez au moins une information pour ce PC.');
    return;
  }
  if (editingUnsecuredIndex === null) {
    const now = new Date();
    unsecuredEntries.push({
      date: now.toLocaleDateString('fr-FR'),
      heure: now.toLocaleTimeString('fr-FR'),
      asset,
      nom,
      commentaire,
    });
  } else {
    unsecuredEntries[editingUnsecuredIndex] = {
      ...unsecuredEntries[editingUnsecuredIndex],
      asset,
      nom,
      commentaire,
    };
  }
  saveStoredList(UNSECURED_ENTRIES_STORAGE_KEY, unsecuredEntries);
  renderAuditCounters();
  renderTable();
  closeAuditModal('unsecuredModal');
  resetUnsecuredModal();
});

document.getElementById('addOther').addEventListener('click', () => {
  document.getElementById('otherComment').value = '';
  openAuditModal('otherModal');
  document.getElementById('otherComment').focus();
});
document.getElementById('cancelOther').addEventListener('click', () => {
  closeAuditModal('otherModal');
  document.getElementById('otherComment').value = '';
});
document.getElementById('confirmOther').addEventListener('click', () => {
  const commentaire = document.getElementById('otherComment').value.trim();
  if (!commentaire) {
    alert('Saisissez un commentaire.');
    return;
  }
  const now = new Date();
  otherComments.push({
    date: now.toLocaleDateString('fr-FR'),
    heure: now.toLocaleTimeString('fr-FR'),
    commentaire,
  });
  saveStoredList(OTHER_COMMENTS_STORAGE_KEY, otherComments);
  renderAuditCounters();
  closeAuditModal('otherModal');
  document.getElementById('otherComment').value = '';
});

function renderTable() {
  const tbody = document.querySelector('#entryTable tbody');
  tbody.innerHTML = '';
  unsecuredEntries.forEach((entry) => {
    const index = unsecuredEntries.indexOf(entry);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(entry.asset)}</td>
      <td>${escapeHtml(entry.nom)}</td>
      <td>${escapeHtml(entry.commentaire)}</td>
      <td>
        <button class="row-action row-edit" data-idx="${index}" type="button" title="Modifier ce PC" aria-label="Modifier ce PC">🖉</button>
        <button class="row-action row-del" data-idx="${index}" type="button" title="Supprimer ce PC" aria-label="Supprimer ce PC">🗑</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById('entryCount').textContent = unsecuredEntries.length;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

document.querySelector('#entryTable tbody').addEventListener('click', (event) => {
  const editButton = event.target.closest('.row-edit');
  if (editButton) {
    openUnsecuredModal(Number(editButton.dataset.idx));
    return;
  }
  const deleteButton = event.target.closest('.row-del');
  if (!deleteButton) return;
  const index = Number(deleteButton.dataset.idx);
  if (!unsecuredEntries[index] || !confirm('Supprimer ce PC de la liste ?')) return;
  unsecuredEntries.splice(index, 1);
  saveStoredList(UNSECURED_ENTRIES_STORAGE_KEY, unsecuredEntries);
  renderAuditCounters();
  renderTable();
});

document.getElementById('clearAll').addEventListener('click', () => {
  const hasAuditData = entries.length || auditStats.secured || auditStats.unsecuredWithCollaborator
    || unsecuredEntries.length || otherComments.length;
  if (hasAuditData && !confirm('Supprimer définitivement toutes les entrées et remettre les compteurs à zéro ?')) return;
  resetAuditData();
});

function resetAuditData() {
  entries = [];
  auditStats = { secured: 0, unsecuredWithCollaborator: 0 };
  unsecuredEntries = [];
  otherComments = [];
  editingUnsecuredIndex = null;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(AUDIT_STATS_STORAGE_KEY);
  localStorage.removeItem(UNSECURED_ENTRIES_STORAGE_KEY);
  localStorage.removeItem(OTHER_COMMENTS_STORAGE_KEY);
  resetUnsecuredModal();
  document.getElementById('otherComment').value = '';
  closeAuditModal('unsecuredModal');
  closeAuditModal('otherModal');
  renderAuditCounters();
  renderTable();
}

function buildExportWorkbook() {
  const exportRow = (type, values = {}) => ({
    Type: type,
    Date: values.date || '',
    Heure: values.heure || '',
    'N° Asset': values.asset || '',
    'Nom de la personne connectée': values.nom || '',
    'Bureau / Salle': values.bureau || '',
    Commentaire: values.commentaire || '',
    Nombre: values.nombre ?? '',
  });
  const rows = [
    exportRow('Compteur', {
      date: 'Bilan de l’audit',
      commentaire: 'PCs sécurisés',
      nombre: auditStats.secured,
    }),
    exportRow('Compteur', {
      date: 'Bilan de l’audit',
      commentaire: 'PCs non sécurisés avec collaborateur devant le PC',
      nombre: auditStats.unsecuredWithCollaborator,
    }),
    ...entries.map((e) => exportRow('PC non attaché', e)),
    ...unsecuredEntries.map((e) => exportRow('PC non sécurisé', e)),
    ...otherComments.map((e) => exportRow('Autre', e)),
  ];
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 10 }, { wch: 14 }, { wch: 28 }, { wch: 20 }, { wch: 72 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Audit');
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
  if (!entries.length && !auditStats.secured && !auditStats.unsecuredWithCollaborator
    && !unsecuredEntries.length && !otherComments.length) {
    alert('La liste et les compteurs sont vides.');
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

// ---------- Batterie locale de qualité OCR ----------
const OCR_TEST_MAX_IMAGES = 20;
const OCR_TEST_MAX_FILE_BYTES = 15 * 1024 * 1024;
const OCR_TEST_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const OCR_TEST_APP_VERSION = '1.31.0';
const OCR_TEST_TESSERACT_VERSION = '5.1.1';
let ocrTestMode = null;
let ocrTestItems = [];
let ocrTestRunning = false;
let ocrTestNextId = 1;

const ocrTestModal = document.getElementById('ocrTestModal');
const ocrTestChoices = document.getElementById('ocrTestChoices');
const ocrTestWorkspace = document.getElementById('ocrTestWorkspace');
const ocrTestImageList = document.getElementById('ocrTestImageList');
const ocrTestProgress = document.getElementById('ocrTestProgress');
const ocrTestResults = document.getElementById('ocrTestResults');
const ocrTestRunButton = document.getElementById('runOcrTest');
const ocrTestShareButton = document.getElementById('shareOcrTestReport');
const ocrTestConsent = document.getElementById('confirmOcrTestShare');
const ocrTestCameraPicker = document.getElementById('ocrTestCameraPicker');
const ocrTestBatchExpected = document.getElementById('ocrTestBatchExpected');
const ocrTestCameraPopup = document.getElementById('ocrTestCameraPopup');
const ocrTestCameraVideo = document.getElementById('ocrTestCameraVideo');
const ocrTestCameraStatus = document.getElementById('ocrTestCameraStatus');
const ocrTestTakePhotoButton = document.getElementById('takeOcrTestPhoto');
const ocrTestStopCameraButton = document.getElementById('stopOcrTestCamera');
let ocrTestCameraStream = null;
let ocrTestCameraBusy = false;

function resetOcrTest() {
  stopOcrTestCamera();
  ocrTestItems.forEach((item) => URL.revokeObjectURL(item.previewUrl));
  ocrTestItems = [];
  ocrTestMode = null;
  ocrTestRunning = false;
  ocrTestImageList.replaceChildren();
  ocrTestResults.replaceChildren();
  ocrTestResults.hidden = true;
  ocrTestProgress.textContent = '';
  ocrTestChoices.hidden = false;
  ocrTestWorkspace.hidden = true;
  ocrTestConsent.checked = false;
  ocrTestRunButton.disabled = true;
  ocrTestShareButton.disabled = true;
  ocrTestBatchExpected.value = '';
  document.getElementById('runOcrTest').textContent = 'Lancer la batterie';
  updateOcrTestButtons();
}

function exitOcrTestMode() {
  stopOcrTestCamera();
  closeAuditModal('ocrTestModal');
  resetOcrTest();
}

function openOcrTestMode(mode) {
  resetOcrTest();
  ocrTestMode = mode;
  ocrTestChoices.hidden = true;
  ocrTestWorkspace.hidden = false;
  document.getElementById('ocrTestModeLabel').textContent = mode === 'asset'
    ? 'Batterie d’étiquettes d’asset'
    : 'Batterie de lock screens';
  openAuditModal('ocrTestModal');
}

document.getElementById('openOcrTest').addEventListener('click', () => {
  resetOcrTest();
  openAuditModal('ocrTestModal');
});
document.getElementById('startAssetBattery').addEventListener('click', () => openOcrTestMode('asset'));
document.getElementById('startNameBattery').addEventListener('click', () => openOcrTestMode('name'));
document.getElementById('cancelOcrTest').addEventListener('click', () => {
  if (ocrTestRunning || ocrTestCameraBusy) return;
  exitOcrTestMode();
});
document.getElementById('addOcrTestPhotos').addEventListener('click', openOcrTestCamera);
ocrTestStopCameraButton.addEventListener('click', stopOcrTestCamera);
ocrTestTakePhotoButton.addEventListener('click', captureAndTestOcrPhoto);
ocrTestBatchExpected.addEventListener('input', () => {
  const expected = ocrTestBatchExpected.value.trim();
  ocrTestItems.forEach((item) => { item.expected = expected; });
  invalidateOcrTestResults();
  updateOcrTestButtons();
});

function addOcrTestFiles(fileList, source = 'camera-capture') {
  const files = Array.from(fileList || []);
  if (!files.length) return [];
  let totalBytes = ocrTestItems.reduce((sum, item) => sum + item.file.size, 0);
  let rejected = 0;
  let added = 0;
  const addedItems = [];
  for (const file of files) {
    if (!file.type.startsWith('image/') || file.size > OCR_TEST_MAX_FILE_BYTES
      || ocrTestItems.length >= OCR_TEST_MAX_IMAGES || totalBytes + file.size > OCR_TEST_MAX_TOTAL_BYTES) {
      rejected += 1;
      continue;
    }
    const item = {
      id: ocrTestNextId++,
      file,
      source,
      expected: ocrTestBatchExpected.value.trim(),
      previewUrl: URL.createObjectURL(file),
      result: null,
    };
    totalBytes += file.size;
    ocrTestItems.push(item);
    addedItems.push(item);
    added += 1;
  }
  if (added) invalidateOcrTestResults();
  renderOcrTestItems();
  if (rejected) {
    ocrTestProgress.textContent = `${rejected} photo(s) ignorée(s). Limites: ${OCR_TEST_MAX_IMAGES} photos, 15 Mio par photo et 100 Mio par batterie.`;
  }
  return addedItems;
}

ocrTestCameraPicker.addEventListener('change', () => {
  addOcrTestFiles(ocrTestCameraPicker.files, 'camera-capture-picker');
  ocrTestCameraPicker.value = '';
});

async function openOcrTestCamera() {
  if (!ocrTestBatchExpected.value.trim()) {
    ocrTestProgress.textContent = 'Saisissez d’abord la valeur attendue pour cette série.';
    ocrTestBatchExpected.focus();
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    ocrTestProgress.textContent = 'Caméra en direct indisponible dans ce contexte. Ouverture de la caméra photo du navigateur.';
    ocrTestCameraPicker.click();
    return;
  }
  if (ocrTestCameraStream) return;
  ocrTestCameraPopup.hidden = false;
  document.body.classList.add('capture-active');
  ocrTestCameraStatus.textContent = 'Connexion à la caméra…';
  ocrTestTakePhotoButton.disabled = true;
  updateOcrTestButtons();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (ocrTestCameraPopup.hidden) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    ocrTestCameraStream = stream;
    ocrTestCameraVideo.srcObject = stream;
    await ocrTestCameraVideo.play();
    await enterCaptureFullscreen(ocrTestCameraPopup);
    ocrTestCameraStatus.textContent = 'Cadrez l’étiquette ou le nom, puis prenez autant de photos que nécessaire.';
    ocrTestTakePhotoButton.disabled = false;
    updateOcrTestButtons();
  } catch (error) {
    stopOcrTestCamera();
    ocrTestProgress.textContent = error.name === 'NotAllowedError'
      ? 'L’accès à la caméra a été refusé.'
      : 'Impossible d’ouvrir la caméra. Vérifiez les autorisations du navigateur.';
  }
}

function stopOcrTestCamera() {
  if (ocrTestCameraStream) {
    ocrTestCameraStream.getTracks().forEach((track) => track.stop());
    ocrTestCameraStream = null;
  }
  ocrTestCameraVideo.pause();
  ocrTestCameraVideo.srcObject = null;
  ocrTestCameraPopup.hidden = true;
  ocrTestTakePhotoButton.disabled = false;
  ocrTestStopCameraButton.disabled = false;
  document.body.classList.remove('capture-active');
  exitCaptureFullscreen(ocrTestCameraPopup);
  updateOcrTestButtons();
}

async function captureAndTestOcrPhoto() {
  if (!ocrTestCameraStream || ocrTestCameraBusy) return;
  const frame = captureVideoFrame(ocrTestCameraVideo);
  if (!frame) {
    ocrTestCameraStatus.textContent = 'Mise au point de la caméra…';
    return;
  }
  ocrTestCameraBusy = true;
  ocrTestTakePhotoButton.disabled = true;
  ocrTestStopCameraButton.disabled = true;
  ocrTestCameraStatus.textContent = 'Enregistrement de la photo…';
  ocrTestCameraPopup.classList.add('capture-photo-flash');
  window.setTimeout(() => ocrTestCameraPopup.classList.remove('capture-photo-flash'), 300);
  try {
    const blob = await new Promise((resolve) => frame.toBlob(resolve, 'image/jpeg', 0.94));
    if (!blob) throw new Error('Impossible de créer la photo.');
    const file = new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' });
    const [item] = addOcrTestFiles([file], 'live-camera');
    if (!item) throw new Error('Photo refusée: vérifiez les limites de taille et de nombre.');
    ocrTestCameraStatus.textContent = `Photo ${ocrTestItems.length} ajoutée. Cadrez la suivante.`;
  } catch (error) {
    ocrTestCameraStatus.textContent = error?.message || 'Échec de la capture.';
  } finally {
    ocrTestCameraBusy = false;
    ocrTestTakePhotoButton.disabled = false;
    ocrTestStopCameraButton.disabled = false;
    updateOcrTestButtons();
  }
}

function renderOcrTestItems() {
  ocrTestImageList.replaceChildren();
  ocrTestItems.forEach((item, index) => {
    const row = document.createElement('li');
    row.className = 'ocr-test-image-item';
    const image = document.createElement('img');
    image.className = 'ocr-test-thumbnail';
    image.src = item.previewUrl;
    image.alt = `Aperçu ${index + 1}`;
    const details = document.createElement('span');
    details.className = 'ocr-test-photo-label';
    details.textContent = `Photo ${index + 1} · ${item.file.type || 'type inconnu'} · ${(item.file.size / 1024 / 1024).toFixed(2)} Mio`;
    row.append(image, details);
    ocrTestImageList.append(row);
  });
  updateOcrTestButtons();
}

function invalidateOcrTestResults() {
  const hadResults = ocrTestItems.some((item) => item.result);
  ocrTestItems.forEach((item) => { item.result = null; });
  ocrTestResults.replaceChildren();
  ocrTestResults.hidden = true;
  if (hadResults) ocrTestProgress.textContent = 'Photo ou valeur attendue modifiée. Relancez la batterie avant de partager.';
}

function updateOcrTestButtons() {
  const allExpectedValuesPresent = ocrTestItems.length > 0
    && ocrTestItems.every((item) => item.expected.trim());
  const allResultsPresent = ocrTestItems.length > 0
    && ocrTestItems.every((item) => item.result !== null);
  const cameraActive = Boolean(ocrTestCameraStream) || !ocrTestCameraPopup.hidden;
  ocrTestRunButton.disabled = ocrTestRunning || ocrTestCameraBusy || cameraActive || !allExpectedValuesPresent;
  ocrTestShareButton.disabled = ocrTestRunning || ocrTestCameraBusy || cameraActive || !allResultsPresent
    || !ocrTestConsent.checked;
  document.getElementById('cancelOcrTest').disabled = ocrTestRunning || ocrTestCameraBusy;
  document.getElementById('addOcrTestPhotos').disabled = ocrTestRunning || ocrTestCameraBusy;
  ocrTestTakePhotoButton.disabled = ocrTestRunning || ocrTestCameraBusy || !ocrTestCameraStream;
  ocrTestStopCameraButton.disabled = ocrTestRunning || ocrTestCameraBusy;
}

ocrTestConsent.addEventListener('change', updateOcrTestButtons);

function normalizeOcrTestValue(value, mode) {
  const compact = String(value || '').trim().replace(/\s+/g, ' ');
  return mode === 'asset' ? compact.toUpperCase() : compact.toLocaleLowerCase('fr');
}

function characterErrorRate(expected, actual) {
  const left = Array.from(expected);
  const right = Array.from(actual);
  if (!left.length) return right.length ? 1 : 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length] / left.length;
}

async function testOcrImage(item, index, total) {
  const templateState = ocrTestMode === 'asset' ? assetState : nameState;
  const config = getLiveConfig(templateState);
  const snapshot = {
    image: templateState.image,
    rotation: templateState.rotation,
    invert: templateState.invert,
    crop: templateState.crop,
  };
  const startedAt = performance.now();
  const diagnostics = { rotations: [] };
  try {
    const image = await loadImageFile(item.file);
    templateState.image = image;
    templateState.rotation = 0;
    templateState.crop = null;
    templateState.invert = false;
    renderPreview(templateState);
    const recognizedText = await withOcrLock(() => autoRecognize(
      templateState,
      config.score,
      config.detectOrientation,
      () => {},
      () => true,
      'standard',
      0,
      false,
      diagnostics
    ));
    const extractedValue = config.extract(recognizedText);
    const expected = item.expected.trim();
    const normalizedExpected = normalizeOcrTestValue(expected, ocrTestMode);
    const normalizedActual = normalizeOcrTestValue(extractedValue, ocrTestMode);
    item.result = {
      id: `sample-${String(index + 1).padStart(3, '0')}`,
      expected,
      recognizedText,
      extractedValue,
      exactMatch: normalizedExpected === normalizedActual,
      characterErrorRate: characterErrorRate(normalizedExpected, normalizedActual),
      elapsedMs: Math.round(performance.now() - startedAt),
      image: {
        source: item.source,
        mimeType: item.file.type || 'application/octet-stream',
        bytes: item.file.size,
        decodedWidth: image.naturalWidth,
        decodedHeight: image.naturalHeight,
      },
      diagnostics,
      error: null,
    };
  } catch (error) {
    item.result = {
      id: `sample-${String(index + 1).padStart(3, '0')}`,
      expected: item.expected.trim(),
      recognizedText: '',
      extractedValue: '',
      exactMatch: false,
      characterErrorRate: 1,
      elapsedMs: Math.round(performance.now() - startedAt),
      image: {
        source: item.source,
        mimeType: item.file.type || 'application/octet-stream',
        bytes: item.file.size,
      },
      diagnostics,
      error: String(error?.message || error),
    };
  } finally {
    templateState.image = snapshot.image;
    templateState.rotation = snapshot.rotation;
    templateState.invert = snapshot.invert;
    templateState.crop = snapshot.crop;
    if (snapshot.image) renderPreview(templateState);
  }
  ocrTestProgress.textContent = `Analyse ${index + 1}/${total} terminée.`;
}

function renderOcrTestResults() {
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const header = document.createElement('tr');
  ['Photo', 'Attendu', 'Reconnu', 'Correspondance', 'Confiance', 'Temps'].forEach((text) => {
    const cell = document.createElement('th');
    cell.textContent = text;
    header.append(cell);
  });
  head.append(header);
  const body = document.createElement('tbody');
  ocrTestItems.forEach((item, index) => {
    const result = item.result;
    const row = document.createElement('tr');
    const confidence = result?.diagnostics?.refinement?.confidence;
    [
      `Photo ${index + 1}`,
      item.expected,
      result?.extractedValue || result?.error || 'Aucune valeur',
      result?.exactMatch ? 'Exacte' : 'Différente',
      Number.isFinite(confidence) ? `${Math.round(confidence)} %` : 'N/D',
      result ? `${result.elapsedMs} ms` : 'N/D',
    ].forEach((text) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    });
    body.append(row);
  });
  table.append(head, body);
  ocrTestResults.replaceChildren(table);
  ocrTestResults.hidden = false;
}

ocrTestRunButton.addEventListener('click', async () => {
  if (ocrTestRunning || ocrTestRunButton.disabled) return;
  ocrTestRunning = true;
  ocrTestItems.forEach((item) => { item.result = null; });
  ocrTestResults.hidden = true;
  ocrTestProgress.textContent = 'Initialisation du moteur OCR…';
  renderOcrTestItems();
  updateOcrTestButtons();
  const start = performance.now();
  try {
    if (!await prepareOcr(ocrTestMode === 'asset' ? assetState : nameState)) {
      throw new Error('Le moteur OCR ne peut pas être initialisé.');
    }
    for (let index = 0; index < ocrTestItems.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await testOcrImage(ocrTestItems[index], index, ocrTestItems.length);
      renderOcrTestResults();
    }
    const exactCount = ocrTestItems.filter((item) => item.result?.exactMatch).length;
    ocrTestProgress.textContent = `Batterie terminée: ${exactCount}/${ocrTestItems.length} valeurs exactes; ${(performance.now() - start).toFixed(0)} ms au total.`;
  } catch (error) {
    ocrTestProgress.textContent = `Batterie interrompue: ${error?.message || error}`;
  } finally {
    ocrTestRunning = false;
    renderOcrTestItems();
    updateOcrTestButtons();
  }
});

const ZIP_CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function zipCrc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = (crc >>> 8) ^ ZIP_CRC32_TABLE[(crc ^ bytes[index]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipHeader(size, nameBytes, crc, offset, central = false, timestamp = new Date()) {
  const headerSize = central ? 46 : 30;
  const header = new Uint8Array(headerSize + nameBytes.length);
  const view = new DataView(header.buffer);
  const dosTime = (timestamp.getHours() << 11) | (timestamp.getMinutes() << 5) | Math.floor(timestamp.getSeconds() / 2);
  const dosDate = ((Math.max(1980, timestamp.getFullYear()) - 1980) << 9)
    | ((timestamp.getMonth() + 1) << 5) | timestamp.getDate();
  if (central) {
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint16(12, dosTime, true);
    view.setUint16(14, dosDate, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, size, true);
    view.setUint32(24, size, true);
    view.setUint16(28, nameBytes.length, true);
    view.setUint16(30, 0, true);
    view.setUint16(32, 0, true);
    view.setUint16(34, 0, true);
    view.setUint16(36, 0, true);
    view.setUint32(38, 0, true);
    view.setUint32(42, offset, true);
  } else {
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint16(10, dosTime, true);
    view.setUint16(12, dosDate, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, size, true);
    view.setUint32(22, size, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint16(28, 0, true);
  }
  header.set(nameBytes, headerSize);
  return header;
}

async function createOcrTestZip(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    // The file bytes are read one at a time for CRC calculation; photo blobs remain uncompressed.
    // eslint-disable-next-line no-await-in-loop
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    if (bytes.length > 0xffffffff || offset > 0xffffffff) throw new Error('Le rapport est trop volumineux pour le format ZIP.');
    const nameBytes = encoder.encode(entry.name);
    const crc = zipCrc32(bytes);
    const timestamp = new Date();
    const localHeader = zipHeader(bytes.length, nameBytes, crc, 0, false, timestamp);
    parts.push(localHeader, entry.blob);
    centralParts.push(zipHeader(bytes.length, nameBytes, crc, offset, true, timestamp));
    offset += localHeader.length + bytes.length;
  }
  const centralOffset = offset;
  centralParts.forEach((part) => { offset += part.length; });
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, offset - centralOffset, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);
  return new Blob([...parts, ...centralParts, end], { type: 'application/zip' });
}

function ocrTestPhotoExtension(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : 'image';
}

function buildOcrTestReport() {
  const successes = ocrTestItems.filter((item) => item.result?.exactMatch).length;
  const elapsedTimes = ocrTestItems.map((item) => item.result?.elapsedMs).filter(Number.isFinite).sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(elapsedTimes.length * 0.95) - 1);
  return {
    schema: 'audit-bureau-propre-ocr-benchmark/v1',
    createdAt: new Date().toISOString(),
    privacy: {
      processing: 'local-browser-only',
      photoPolicy: 'original-photo-bytes-included-in-this-explicitly-shared-archive',
      warning: 'Photos may contain personal information and EXIF metadata such as location.',
    },
    application: {
      version: OCR_TEST_APP_VERSION,
      tesseractJsVersion: OCR_TEST_TESSERACT_VERSION,
      languageModels: ['eng.traineddata.gz', 'fra.traineddata.gz'],
      recognitionEngineMode: 'LSTM (OEM 1)',
      pipeline: {
        detectorPageSegmentationMode: 11,
        refinementPageSegmentationMode: 6,
        preprocessing: 'grayscale + global min/max contrast stretch; no adaptive retry',
        maxLongSideBeforeCrop: 1800,
        minLongSideAfterCrop: 700,
        maxUpscale: 4,
        assetRotations: ROTATIONS,
        nameRotations: [0],
      },
    },
    environment: {
      userAgent: navigator.userAgent,
      platform: navigator.platform || null,
      languages: navigator.languages || [],
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemoryGiB: navigator.deviceMemory || null,
      screen: { width: screen.width, height: screen.height, pixelRatio: window.devicePixelRatio || 1 },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      secureContext: window.isSecureContext,
      onlineAtExport: navigator.onLine,
    },
    battery: {
      category: ocrTestMode === 'asset' ? 'asset-label' : 'lock-screen-name',
      sampleCount: ocrTestItems.length,
      exactMatches: successes,
      exactMatchRate: ocrTestItems.length ? successes / ocrTestItems.length : 0,
      medianSampleElapsedMs: elapsedTimes.length
        ? elapsedTimes[Math.floor((elapsedTimes.length - 1) / 2)]
        : null,
      p95SampleElapsedMs: elapsedTimes.length ? elapsedTimes[p95Index] : null,
      samples: ocrTestItems.map((item, index) => ({
        ...item.result,
        photoPath: `photos/sample-${String(index + 1).padStart(3, '0')}.${ocrTestPhotoExtension(item.file)}`,
      })),
    },
    notes: [
      'Expected values were entered by the operator. Exact match ignores letter case and collapses whitespace; asset values are compared uppercase.',
      'The character error rate is computed on the extracted field value, not the full raw OCR transcription.',
      'OCR confidence is Tesseract confidence, not a calibrated probability.',
      'Original images are stored byte-for-byte; filenames are replaced with sample IDs, but EXIF metadata is not removed.',
    ],
  };
}

async function createOcrTestReportFile() {
  const report = buildOcrTestReport();
  const entries = [{
    name: 'report.json',
    blob: new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
  }];
  ocrTestItems.forEach((item, index) => {
    entries.push({
      name: `photos/sample-${String(index + 1).padStart(3, '0')}.${ocrTestPhotoExtension(item.file)}`,
      blob: item.file,
    });
  });
  const zip = await createOcrTestZip(entries);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return new File([zip], `ocr_benchmark_${ocrTestMode}_${stamp}.zip`, { type: 'application/zip' });
}

function downloadOcrTestReport(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

ocrTestShareButton.addEventListener('click', async () => {
  if (!ocrTestConsent.checked || ocrTestShareButton.disabled) return;
  ocrTestShareButton.disabled = true;
  ocrTestProgress.textContent = 'Préparation du ZIP avec le rapport et les photos originales…';
  try {
    const file = await createOcrTestReportFile();
    if (!navigator.share || !navigator.canShare || !navigator.canShare({ files: [file] })) {
      downloadOcrTestReport(file);
      ocrTestProgress.textContent = `Rapport téléchargé (${(file.size / 1024 / 1024).toFixed(1)} Mio). Partagez ce ZIP par le canal autorisé.`;
      return;
    }
    await navigator.share({
      title: 'Rapport de qualité OCR',
      text: 'Rapport local de benchmark OCR, avec photos originales.',
      files: [file],
    });
    ocrTestProgress.textContent = 'Partage terminé. Les photos n’ont été transmises qu’au canal choisi.';
  } catch (error) {
    if (error.name !== 'AbortError') {
      ocrTestProgress.textContent = `Partage impossible: ${error?.message || error}`;
    } else {
      ocrTestProgress.textContent = 'Partage annulé. Le rapport reste disponible pour un nouvel essai.';
    }
  } finally {
    updateOcrTestButtons();
  }
});

renderTable();
scheduleOcrPreload();
