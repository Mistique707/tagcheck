/**
 * Reading a plate with Google Cloud Vision.
 *
 * Tesseract is a document scanner. It reads a clean page well and a dirty metal
 * plate at an angle in daylight badly, and no amount of preprocessing changes
 * that -- measured, on a realistic benchmark, the fixes bought nothing. Cloud
 * Vision is trained on photographs of the world, which is the actual problem.
 *
 * Three things keep this honest:
 *
 * - It is optional. With no key configured the app behaves exactly as before.
 * - It never blocks a scan. Any failure -- no signal, quota spent, a bad
 *   response -- falls straight back to on-device recognition, and typing the
 *   plate always works.
 * - It sends only the guide-box crop, downscaled and compressed, never the full
 *   camera frame. That is the smallest thing that can answer the question.
 *
 * The key this uses is billable, unlike the Firebase config key. Restricting it
 * to the club domain AND capping the daily quota is part of the setup, not an
 * optional extra: see docs/FIREBASE.md.
 */

import { VISION_API_KEY } from './firebase-config.js';

const ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';

/** Plenty for a plate, and small enough to send over a phone connection. */
const SEND_WIDTH = 1024;
const JPEG_QUALITY = 0.72;
const TIMEOUT_MS = 12000;

export const visionAvailable = () => Boolean(VISION_API_KEY);

function toJpegBase64(canvas) {
  let source = canvas;
  if (canvas.width > SEND_WIDTH) {
    const scaled = document.createElement('canvas');
    scaled.width = SEND_WIDTH;
    scaled.height = Math.round(canvas.height * (SEND_WIDTH / canvas.width));
    const ctx = scaled.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
    source = scaled;
  }
  return source.toDataURL('image/jpeg', JPEG_QUALITY).split(',')[1];
}

/**
 * Every string worth scoring out of one response.
 *
 * Vision returns the whole block, then each detected word. A two-row plate
 * arrives as a block containing a newline, and the words are the individual
 * groups -- so the block, the lines, and the lines joined are all offered, and
 * the plate scorer picks between them.
 */
function candidatesFrom(response) {
  const out = [];
  const full = response?.fullTextAnnotation?.text
    || response?.textAnnotations?.[0]?.description
    || '';

  if (full) {
    out.push(full);
    const lines = full.split('\n').map((line) => line.trim()).filter(Boolean);
    out.push(...lines);
    if (lines.length > 1) {
      out.push(lines.join(''));
      for (let i = 0; i + 1 < lines.length; i += 1) out.push(lines[i] + lines[i + 1]);
    }
  }

  // Word-level boxes, and adjacent words glued together.
  const words = (response?.textAnnotations || []).slice(1)
    .map((item) => String(item.description || '').trim())
    .filter(Boolean);
  out.push(...words);
  for (let i = 0; i + 1 < words.length; i += 1) out.push(words[i] + words[i + 1]);
  for (let i = 0; i + 2 < words.length; i += 1) {
    out.push(words[i] + words[i + 1] + words[i + 2]);
  }

  return out;
}

/**
 * @returns {{candidates: string[], raw: string}|null} null when unavailable or
 *   anything at all goes wrong, so the caller can fall back without branching.
 */
export async function readWithVision(canvas) {
  if (!VISION_API_KEY || !navigator.onLine) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(VISION_API_KEY)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        requests: [{
          image: { content: toJpegBase64(canvas) },
          features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
          // A plate is Latin characters; saying so avoids the engine guessing
          // at a script and returning something unusable.
          imageContext: { languageHints: ['en'] },
        }],
      }),
    });

    if (!response.ok) {
      console.warn('[tagcheck] vision unavailable:', response.status);
      return null;
    }

    const payload = await response.json();
    const first = payload?.responses?.[0];
    if (!first || first.error) {
      if (first?.error) console.warn('[tagcheck] vision error:', first.error.message);
      return null;
    }

    const candidates = candidatesFrom(first);
    if (!candidates.length) return null;

    return {
      candidates,
      raw: (first.fullTextAnnotation?.text || '').replace(/\s+/g, ' ').trim(),
    };
  } catch {
    // Offline, aborted, blocked, malformed -- all the same to the caller.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
