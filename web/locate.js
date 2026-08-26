/**
 * Finding the plate inside the picture.
 *
 * This is the step that separates a scanner that works in a car park from one
 * that only works on a clean photo. A member points the phone roughly at a
 * bike, so the guide box also catches mudguard, road, shadow and whatever is
 * parked behind. Handing all of that to a text engine is what made readings
 * come back as junk: it has no idea which marks are the plate.
 *
 * No machine-learning model is involved. Plate characters have a property that
 * almost nothing else in the frame shares -- a dense run of strong vertical
 * strokes packed along a horizontal line -- and that is enough to find them.
 *
 *   1. shrink the frame, because none of this needs full resolution
 *   2. measure horizontal gradient, which vertical strokes light up
 *   3. close the gaps so the characters merge into one blob per line of text
 *   4. take the blobs apart and score them on plate-like shape and density
 *   5. cut the winner out of the ORIGINAL frame, at full resolution
 *
 * Step five matters: detection runs on a small copy, but the crop is taken from
 * the original, so nothing is thrown away before the engine sees it.
 */

/** Width the detection pass runs at. Small is fine and much faster. */
const DETECT_WIDTH = 440;

function greyscaleOf(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const grey = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0, g = 0; i < data.length; i += 4, g += 1) {
    grey[g] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }
  return grey;
}

/**
 * Horizontal gradient only. A vertical stroke -- which is what most plate
 * characters are made of -- produces a strong left-to-right change, while road
 * surface, sky and panel gaps mostly do not.
 */
function horizontalEdges(grey, width, height) {
  const out = new Uint8ClampedArray(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const gx = -grey[i - width - 1] - 2 * grey[i - 1] - grey[i + width - 1]
        + grey[i - width + 1] + 2 * grey[i + 1] + grey[i + width + 1];
      out[i] = Math.min(255, Math.abs(gx) >> 2);
    }
  }
  return out;
}

/** Keep only edges that stand out from this particular picture. */
function binarise(edges) {
  let sum = 0;
  for (const value of edges) sum += value;
  const mean = sum / edges.length;

  let variance = 0;
  for (const value of edges) variance += (value - mean) ** 2;
  const stdDev = Math.sqrt(variance / edges.length);

  const cutoff = mean + stdDev * 0.9;
  const out = new Uint8Array(edges.length);
  for (let i = 0; i < edges.length; i += 1) out[i] = edges[i] > cutoff ? 1 : 0;
  return out;
}

/** Dilate along one axis using a running count, so the radius costs nothing. */
function dilate(mask, width, height, radius, horizontal) {
  const out = new Uint8Array(mask.length);
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  const step = horizontal ? 1 : width;

  for (let o = 0; o < outer; o += 1) {
    const base = horizontal ? o * width : o;
    let count = 0;
    for (let i = 0; i < Math.min(radius + 1, inner); i += 1) count += mask[base + i * step];
    for (let i = 0; i < inner; i += 1) {
      out[base + i * step] = count > 0 ? 1 : 0;
      const add = i + radius + 1;
      const drop = i - radius;
      if (add < inner) count += mask[base + add * step];
      if (drop >= 0) count -= mask[base + drop * step];
    }
  }
  return out;
}

/** Label connected blobs and return their bounding boxes. */
function blobs(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const found = [];
  const queue = new Int32Array(mask.length);

  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;

    let head = 0;
    let tail = 0;
    queue[tail += 1] = start;
    seen[start] = 1;

    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let area = 0;

    while (head < tail) {
      const index = queue[head += 1];
      const x = index % width;
      const y = (index / width) | 0;
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (mask[n] && !seen[n]) {
            seen[n] = 1;
            queue[tail += 1] = n;
          }
        }
      }
    }

    found.push({
      x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area,
    });
  }
  return found;
}

/**
 * Join blobs that are two rows of the same plate.
 *
 * Dilation alone cannot be trusted to bridge the gap between the two lines of a
 * motorcycle plate: the gap scales with how far away the bike is, and a radius
 * large enough for a distant plate smears a close one into the background. So
 * the rows are merged explicitly instead -- two boxes that sit above one another
 * with real horizontal overlap and only a small vertical gap are one plate.
 *
 * Getting this wrong is not a near miss. Cropping to a single row hands the
 * engine half a plate, and half a plate reads perfectly as a shorter plate, so
 * the mistake arrives looking like a confident answer.
 */
function mergeRows(boxes) {
  const merged = boxes.slice();
  let changed = true;

  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < merged.length; i += 1) {
      for (let j = i + 1; j < merged.length; j += 1) {
        const a = merged[i];
        const b = merged[j];

        const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        if (overlap < Math.min(a.w, b.w) * 0.5) continue;

        const gap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
        if (gap > Math.min(a.h, b.h) * 1.1) continue;

        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        merged[i] = {
          x,
          y,
          w: Math.max(a.x + a.w, b.x + b.w) - x,
          h: Math.max(a.y + a.h, b.y + b.h) - y,
          area: a.area + b.area,
        };
        merged.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return merged;
}

/**
 * How plate-like is this blob?
 *
 * Both plate shapes are allowed: a two-row motorcycle plate sits near 2:1, a
 * single-row car plate near 4:1. Anything long and thin (a panel gap, a shadow
 * line) or nearly square (a badge, a reflector) scores badly. A blob the member
 * pointed at tends to be near the middle of the guide box, so the centre gets a
 * modest nudge -- modest, because a plate slightly off-centre is still a plate.
 */
function scoreBlob(box, edgeMask, width, height) {
  const aspect = box.w / box.h;
  if (aspect < 0.9 || aspect > 6) return 0;
  if (box.w < width * 0.12 || box.h < height * 0.06) return 0;

  const frameArea = width * height;
  const boxArea = box.w * box.h;
  if (boxArea > frameArea * 0.85) return 0;

  let edges = 0;
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      edges += edgeMask[y * width + x];
    }
  }
  const density = edges / boxArea;
  // A plate is busy but not solid. Both extremes are something else.
  if (density < 0.12) return 0;

  const aspectFit = aspect >= 1.6 && aspect <= 4.8
    ? 1
    : 1 / (1 + Math.min(Math.abs(aspect - 1.6), Math.abs(aspect - 4.8)));

  const centreX = box.x + box.w / 2;
  const centreY = box.y + box.h / 2;
  const offset = Math.hypot((centreX - width / 2) / width, (centreY - height / 2) / height);
  const centreFit = 1 / (1 + offset * 1.6);

  const sizeFit = Math.min(1, boxArea / (frameArea * 0.30));

  return density * aspectFit * centreFit * sizeFit;
}

/**
 * Find the plate and cut it out of the original frame.
 *
 * @returns {{canvas: HTMLCanvasElement, box: object, score: number}|null}
 */
export function locatePlate(source, { targetWidth = 1000 } = {}) {
  const scale = DETECT_WIDTH / source.width;
  if (scale >= 1) return null;

  const width = DETECT_WIDTH;
  const height = Math.max(1, Math.round(source.height * scale));

  const small = document.createElement('canvas');
  small.width = width;
  small.height = height;
  small.getContext('2d', { willReadFrequently: true })
    .drawImage(source, 0, 0, width, height);

  const grey = greyscaleOf(small);
  const edges = binarise(horizontalEdges(grey, width, height));

  // Close along the row to glue characters together, then a little vertically
  // so the two rows of a motorcycle plate become a single blob.
  const joined = dilate(
    dilate(edges, width, height, Math.max(3, Math.round(width * 0.022)), true),
    width, height, Math.max(2, Math.round(height * 0.035)), false,
  );

  let best = null;
  for (const box of mergeRows(blobs(joined, width, height))) {
    const score = scoreBlob(box, edges, width, height);
    if (score > 0 && (!best || score > best.score)) best = { box, score };
  }
  if (!best) return null;

  // Map back to the original frame and take a slightly generous crop, because
  // the edge blob stops at the characters and the plate border helps the engine.
  const padX = best.box.w * 0.10;
  const padY = best.box.h * 0.22;
  const sx = Math.max(0, (best.box.x - padX) / scale);
  const sy = Math.max(0, (best.box.y - padY) / scale);
  const sw = Math.min(source.width - sx, (best.box.w + padX * 2) / scale);
  const sh = Math.min(source.height - sy, (best.box.h + padY * 2) / scale);
  if (sw < 40 || sh < 20) return null;

  const out = document.createElement('canvas');
  const outScale = Math.min(3, Math.max(1, targetWidth / sw));
  out.width = Math.round(sw * outScale);
  out.height = Math.round(sh * outScale);
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height);

  return { canvas: out, box: { x: sx, y: sy, w: sw, h: sh }, score: best.score };
}
