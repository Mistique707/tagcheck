/**
 * Reading the plate off a camera frame.
 *
 * Plate text in a car park is small, angled and often filthy, so the pixels get
 * cleaned up before any recognition happens: crop to what the member framed,
 * upscale, flatten to grey, stretch the contrast, then threshold. That work
 * matters more to the result than which engine runs afterwards.
 */

import { OCR_SOURCES, OCR_TIMEOUT_MS } from './config.js';

/** Guide-box geometry, kept in step with the .guide rule in styles.css. */
const GUIDE = { inset: 0.08, aspect: 4 / 1.4 };
const TARGET_WIDTH = 1100;

/**
 * Crop the guide box out of the video frame.
 *
 * The preview is drawn with object-fit: cover, so part of the camera image is
 * off-screen. Undoing that scaling is what makes the crop match the box the
 * member actually aimed with.
 */
export function cropGuideRegion(video, displayWidth, displayHeight) {
  const videoWidth = video.videoWidth;
  const videoHeight = video.videoHeight;
  if (!videoWidth || !videoHeight) return null;

  const scale = Math.max(displayWidth / videoWidth, displayHeight / videoHeight);
  const offsetX = (videoWidth * scale - displayWidth) / 2;
  const offsetY = (videoHeight * scale - displayHeight) / 2;

  const boxWidth = displayWidth * (1 - GUIDE.inset * 2);
  const boxHeight = boxWidth / GUIDE.aspect;
  const boxLeft = displayWidth * GUIDE.inset;
  const boxTop = (displayHeight - boxHeight) / 2;

  const source = {
    x: (boxLeft + offsetX) / scale,
    y: (boxTop + offsetY) / scale,
    w: boxWidth / scale,
    h: boxHeight / scale,
  };

  const canvas = document.createElement('canvas');
  canvas.width = TARGET_WIDTH;
  canvas.height = Math.round(TARGET_WIDTH / GUIDE.aspect);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, source.x, source.y, source.w, source.h, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Draw a chosen photo at a size the engine can work with. */
export function canvasFromImage(image) {
  const width = Math.min(TARGET_WIDTH * 1.6, image.naturalWidth || image.width);
  const ratio = width / (image.naturalWidth || image.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width);
  canvas.height = Math.round((image.naturalHeight || image.height) * ratio);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Flatten to grey and stretch the histogram so faint plates gain contrast. */
export function toGrayscale(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  const grey = new Uint8ClampedArray(pixels.length / 4);

  let min = 255;
  let max = 0;
  for (let i = 0, g = 0; i < pixels.length; i += 4, g += 1) {
    const value = (pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114) | 0;
    grey[g] = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const span = Math.max(1, max - min);
  for (let g = 0, i = 0; g < grey.length; g += 1, i += 4) {
    const stretched = ((grey[g] - min) * 255) / span;
    grey[g] = stretched;
    pixels[i] = stretched;
    pixels[i + 1] = stretched;
    pixels[i + 2] = stretched;
    pixels[i + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return { canvas, grey };
}

/** Otsu: pick the threshold that best separates the two brightness clusters. */
function otsuThreshold(grey) {
  const histogram = new Uint32Array(256);
  for (const value of grey) histogram[value] += 1;

  const total = grey.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * histogram[i];

  let sumBackground = 0;
  let weightBackground = 0;
  let bestVariance = -1;
  let threshold = 128;

  for (let t = 0; t < 256; t += 1) {
    weightBackground += histogram[t];
    if (!weightBackground) continue;
    const weightForeground = total - weightBackground;
    if (!weightForeground) break;

    sumBackground += t * histogram[t];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground
      * (meanBackground - meanForeground) ** 2;

    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Produce a hard black-and-white copy. Indian plates come in white-on-black,
 * black-on-white and black-on-yellow, so the copy is oriented to dark text on a
 * light background whichever way round the original was.
 */
export function toBinary(source, grey) {
  const threshold = otsuThreshold(grey);
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.createImageData(canvas.width, canvas.height);

  let dark = 0;
  for (const value of grey) if (value < threshold) dark += 1;
  const invert = dark > grey.length * 0.55;

  for (let g = 0, i = 0; g < grey.length; g += 1, i += 4) {
    let on = grey[g] > threshold;
    if (invert) on = !on;
    const value = on ? 255 : 0;
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }

  ctx.putImageData(image, 0, 0);
  return canvas;
}

/* Engines ----------------------------------------------------------------- */

const WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${url}"]`);
    if (existing) {
      if (existing.dataset.loaded) resolve();
      else {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', reject);
      }
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.async = true;
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      resolve();
    });
    script.addEventListener('error', () => reject(new Error(`could not load ${url}`)));
    document.head.appendChild(script);
  });
}

let workerPromise;

async function getWorker(onProgress) {
  if (workerPromise) return workerPromise;

  workerPromise = (async () => {
    let source = OCR_SOURCES.cdn;
    try {
      const head = await fetch(OCR_SOURCES.local.script, { method: 'HEAD' });
      if (head.ok) source = OCR_SOURCES.local;
    } catch {
      // No self-hosted copy: the CDN it is.
    }

    await loadScript(source.script);
    if (!window.Tesseract) throw new Error('recognition engine unavailable');

    const worker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: source.workerPath,
      corePath: source.corePath,
      langPath: source.langPath,
      logger: (message) => {
        if (message.status === 'recognizing text' && onProgress) onProgress(message.progress);
      },
    });

    await worker.setParameters({
      tessedit_char_whitelist: WHITELIST,
      // A plate is one line of text, so tell the engine not to hunt for layout.
      tessedit_pageseg_mode: '7',
    });
    return worker;
  })();

  try {
    return await workerPromise;
  } catch (error) {
    workerPromise = undefined;
    throw error;
  }
}

/** Chrome on Android exposes a native detector that costs no download. */
async function nativeRead(canvas) {
  if (!('TextDetector' in window)) return [];
  try {
    const detector = new window.TextDetector();
    const blocks = await detector.detect(canvas);
    return blocks.map((block) => block.rawValue);
  } catch {
    return [];
  }
}

async function engineRead(canvas, onProgress) {
  const worker = await getWorker(onProgress);
  const { data } = await worker.recognize(canvas);
  const lines = (data.lines || []).map((line) => line.text);
  return [data.text, ...lines].filter(Boolean);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('ocr_timeout')), ms)),
  ]);
}

/**
 * Read a prepared canvas and return every candidate string found.
 *
 * Both the thresholded and the plain grey copies are offered to the engine:
 * thresholding wins on dirty plates and loses on shiny embossed ones, and the
 * caller scores all the candidates together anyway.
 */
export async function readPlate(canvas, { onProgress, onStage } = {}) {
  const { canvas: greyCanvas, grey } = toGrayscale(canvas);
  const binary = toBinary(greyCanvas, grey);

  if (onStage) onStage('looking at the plate');
  const native = await nativeRead(binary);
  const candidates = [...native];

  if (onStage) onStage('reading the characters');
  try {
    candidates.push(...await withTimeout(engineRead(binary, onProgress), OCR_TIMEOUT_MS));
    candidates.push(...await withTimeout(engineRead(greyCanvas, onProgress), OCR_TIMEOUT_MS));
  } catch (error) {
    if (!candidates.length) throw error;
  }

  return candidates;
}

/** Free the engine when the app goes to the background for a while. */
export async function releaseEngine() {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = undefined;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // Nothing to release.
  }
}
