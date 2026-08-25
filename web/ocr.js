/**
 * Reading the plate off a camera frame.
 *
 * Plate text in a car park is small, angled and often filthy, so the pixels get
 * cleaned up before any recognition happens: crop to what the member framed,
 * upscale, flatten to grey, stretch the contrast, then threshold. That work
 * matters more to the result than which engine runs afterwards.
 *
 * The important domain fact: an Indian motorcycle plate is usually TWO ROWS
 * (state and district above, series and number below), not the single wide line
 * a car carries. Everything here is shaped around that -- the guide box is
 * roughly square, the engine is told it is reading a block rather than a line,
 * and the rows are stitched back together before being parsed.
 */

import { OCR_SOURCES, OCR_TIMEOUT_MS } from './config.js';
import { bestReading } from './shared/plate.js';

/**
 * Guide-box geometry, kept in step with the .guide rule in styles.css.
 * 2:1 holds a two-row motorcycle plate snugly and still contains a wide
 * single-row car plate with margin to spare.
 */
const GUIDE = { inset: 0.08, aspect: 2 };
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
 *
 * The inversion is judged from the middle of the crop only. The edges of the
 * guide box usually catch bumper, shadow and mudguard, and letting that darkness
 * vote flips the whole image the wrong way round.
 */
export function toBinary(source, grey) {
  const threshold = otsuThreshold(grey);
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.createImageData(canvas.width, canvas.height);

  let dark = 0;
  let counted = 0;
  const yStart = Math.floor(canvas.height * 0.25);
  const yEnd = Math.ceil(canvas.height * 0.75);
  const xStart = Math.floor(canvas.width * 0.2);
  const xEnd = Math.ceil(canvas.width * 0.8);
  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      if (grey[y * canvas.width + x] < threshold) dark += 1;
      counted += 1;
    }
  }
  const invert = counted > 0 && dark > counted * 0.55;

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
      // A 200 is not enough. Both the Node server and Firebase Hosting rewrite
      // unknown paths to index.html for the single-page app, so a missing
      // vendor file answers 200 with HTML -- and the browser then refuses to
      // execute it. Only a real JavaScript content type means the self-hosted
      // engine is actually there.
      const type = head.headers.get('content-type') || '';
      if (head.ok && /javascript|ecmascript/i.test(type)) source = OCR_SOURCES.local;
    } catch {
      // No self-hosted copy: the CDN it is.
    }

    await loadScript(source.script);
    if (!window.Tesseract) throw new Error('recognition engine unavailable');

    return window.Tesseract.createWorker('eng', 1, {
      workerPath: source.workerPath,
      corePath: source.corePath,
      langPath: source.langPath,
      logger: (message) => {
        if (message.status === 'recognizing text' && onProgress) onProgress(message.progress);
      },
    });
    // Deliberately no tessedit_char_whitelist here. It reads like an easy win --
    // a plate is only letters and digits -- but the LSTM engine handles a
    // whitelist badly and often returns nothing at all. Junk characters are
    // cheaper to strip afterwards, which scrub() in shared/plate.js already does.
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

/**
 * Every way the rows of a plate might be put back together.
 *
 * A two-row plate arrives as two separate lines, so neither line is a whole
 * plate on its own. The joins are offered alongside the individual lines and
 * scored together, which lets a single-row plate win on its own line and a
 * two-row plate win on the join.
 */
function candidatesFrom(data) {
  const lines = (data.lines || [])
    .map((line) => String(line.text || '').trim())
    .filter(Boolean);

  const out = [String(data.text || ''), ...lines];
  if (lines.length > 1) {
    out.push(lines.join(''));
    for (let i = 0; i + 1 < lines.length; i += 1) out.push(lines[i] + lines[i + 1]);
  }
  return out.filter(Boolean);
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('ocr_timeout')), ms)),
  ]);
}

/**
 * Attempts in the order that usually pays off on a motorcycle plate.
 *
 * PSM 6 treats the crop as one uniform block of text, which is exactly what a
 * two-row plate is. PSM 7 promises a single line and only helps on a wide
 * car-style plate. PSM 11 hunts sparse text and occasionally rescues a plate
 * that thresholding mangled.
 */
const ATTEMPTS = [
  { image: 'binary', psm: '6' },
  { image: 'grey', psm: '6' },
  { image: 'binary', psm: '7' },
  { image: 'grey', psm: '11' },
];

/** Good enough to stop early rather than spend another second per attempt. */
const CONFIDENT = 0.75;

/**
 * Read a prepared canvas.
 *
 * @returns {{reading: object|null, candidates: string[], sawText: string}}
 *   `sawText` is whatever the engine actually read, so a member who gets a bad
 *   result can see why instead of staring at a blank box.
 */
export async function scanPlate(canvas, { onProgress, onStage } = {}) {
  const { canvas: greyCanvas, grey } = toGrayscale(canvas);
  const images = { grey: greyCanvas, binary: toBinary(greyCanvas, grey) };

  const candidates = [];
  let best = null;

  if (onStage) onStage('looking at the plate');
  candidates.push(...await nativeRead(images.binary));
  best = bestReading(candidates);

  if (!best || best.confidence < CONFIDENT) {
    let worker;
    try {
      if (onStage) onStage('starting the reader');
      worker = await getWorker(onProgress);
    } catch {
      return { reading: best, candidates, sawText: candidates.join(' ').trim() };
    }

    for (const [index, attempt] of ATTEMPTS.entries()) {
      if (best && best.confidence >= CONFIDENT) break;
      try {
        if (onStage) onStage(`reading the characters (try ${index + 1})`);
        await worker.setParameters({ tessedit_pageseg_mode: attempt.psm });
        const { data } = await withTimeout(worker.recognize(images[attempt.image]), OCR_TIMEOUT_MS);
        candidates.push(...candidatesFrom(data));
        best = bestReading(candidates);
      } catch {
        // A failed attempt is not fatal; the next one may still land.
      }
    }
  }

  const sawText = candidates
    .map((line) => String(line).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' / ')
    .slice(0, 120);

  return { reading: best, candidates, sawText };
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
