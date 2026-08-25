/**
 * Indian registration-plate normalisation, validation and fuzzy matching.
 *
 * This module is the single source of truth for "are these two scans the same
 * bike?". It is imported unchanged by the server (Node ESM) and by the browser
 * (native ESM), so a plate can never be canonicalised one way on a phone and a
 * different way in the database.
 */

/** State and union-territory codes currently issued by RTOs. */
export const STATE_CODES = new Set([
  'AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'DD', 'DL', 'DN', 'GA', 'GJ',
  'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML', 'MN', 'MP',
  'MZ', 'NL', 'OD', 'OR', 'PB', 'PY', 'RJ', 'SK', 'TN', 'TR', 'TS', 'UA',
  'UK', 'UP', 'WB',
]);

/**
 * Character pairs a camera genuinely confuses, grouped by shared shape.
 * Only high-frequency confusions live here: widening these groups merges plates
 * that are actually different, which is worse than missing a near-match.
 */
const SHAPE_GROUPS = [
  ['0', 'O', 'D', 'Q'],
  ['1', 'I', 'L'],
  ['2', 'Z'],
  ['5', 'S'],
  ['8', 'B'],
];

/** Confusions used only when proposing corrections, never when merging. */
const EXTRA_DIGIT_LOOKALIKES = { A: '4', G: '6', T: '7', E: '3' };
const EXTRA_LETTER_LOOKALIKES = { 4: 'A', 6: 'G', 7: 'T', 3: 'E' };

const TO_DIGIT = {};
const TO_LETTER = {};
const TO_SHAPE = {};
for (const group of SHAPE_GROUPS) {
  const digit = group[0];
  const letter = group.find((c) => /[A-Z]/.test(c));
  for (const char of group) {
    TO_SHAPE[char] = digit;
    TO_DIGIT[char] = digit;
    if (letter) TO_LETTER[char] = letter;
  }
}
Object.assign(TO_DIGIT, EXTRA_DIGIT_LOOKALIKES);
Object.assign(TO_LETTER, EXTRA_LETTER_LOOKALIKES);

/** Words that appear on plates but carry no identity. */
const NOISE = /\b(?:IND|BHARAT|GOVT|GOVERNMENT|INDIA)\b/g;

/**
 * Standard series: two-letter state, district number, optional letter series,
 * then the running number. A trailing district letter (as in Delhi DL 8C) is
 * absorbed into the series group, which is harmless because we only need a
 * stable canonical string, not a semantic decomposition.
 */
const RE_STANDARD = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/;
/** Bharat series: 23 BH 1234 AB. */
const RE_BH = /^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/;
/** Vintage, defence, diplomatic and other short-lived layouts. */
const RE_LOOSE = /^[A-Z0-9]{5,12}$/;

/** Strip everything that is not identity: spacing, dashes, noise words, dots. */
export function scrub(raw) {
  return String(raw == null ? '' : raw)
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, '');
}

/** Classify an already-scrubbed string. Returns null when nothing matches. */
function classify(text) {
  let m = text.match(RE_BH);
  if (m) return { format: 'bh', parts: [m[1], m[2], m[3], m[4]], strong: true };

  m = text.match(RE_STANDARD);
  if (m) {
    const parts = [m[1], m[2], m[3], m[4]].filter(Boolean);
    return {
      format: 'standard',
      parts,
      strong: STATE_CODES.has(m[1]),
      seriesLen: m[3].length,
      numberLen: m[4].length,
    };
  }

  if (RE_LOOSE.test(text)) return { format: 'other', parts: [text], strong: false };
  return null;
}

/** Rebuild text so each slice satisfies the character class the layout wants. */
function coerce(text, bounds, wants) {
  let cursor = 0;
  let built = '';
  for (let i = 0; i < bounds.length; i += 1) {
    const chunk = text.slice(cursor, cursor + bounds[i]);
    cursor += bounds[i];
    for (const char of chunk) {
      const wantsLetter = wants[i] === 'letter';
      const table = wantsLetter ? TO_LETTER : TO_DIGIT;
      const fixed = table[char] === undefined ? char : table[char];
      const valid = wantsLetter ? /[A-Z]/.test(fixed) : /\d/.test(fixed);
      if (!valid) return null;
      built += fixed;
    }
  }
  return built;
}

/**
 * Generate correction candidates by swapping look-alike characters into the
 * class each position demands. Positions that are already valid are untouched,
 * so a plate that parses cleanly is never rewritten.
 */
function correctionCandidates(text) {
  const out = new Set();
  const len = text.length;

  for (let districtLen = 1; districtLen <= 2; districtLen += 1) {
    for (let seriesLen = 0; seriesLen <= 3; seriesLen += 1) {
      for (let numberLen = 1; numberLen <= 4; numberLen += 1) {
        if (2 + districtLen + seriesLen + numberLen !== len) continue;
        const built = coerce(
          text,
          [2, districtLen, seriesLen, numberLen],
          ['letter', 'digit', 'letter', 'digit'],
        );
        if (built && RE_STANDARD.test(built)) out.add(built);
      }
    }
  }

  if (len === 9 || len === 10) {
    const built = coerce(text, [2, 2, 4, len - 8], ['digit', 'letter', 'digit', 'letter']);
    if (built && RE_BH.test(built)) out.add(built);
  }

  out.delete(text);
  return [...out];
}

/** How many characters a candidate rewrites. Both strings share a length. */
function countChanges(original, candidate) {
  let changes = 0;
  for (let i = 0; i < candidate.length; i += 1) {
    if (original[i] !== candidate[i]) changes += 1;
  }
  return changes;
}

/**
 * Priors on how plates are actually issued. Almost every plate on the road ends
 * in a four-digit running number behind a one or two letter series, so when a
 * misread can be repaired several ways we lean on the common shape. Without
 * this, MHI2A8I234 repairs to MH12ABI234 (a rare three-letter series and a
 * three-digit number) purely because it rewrites one character fewer.
 */
const SERIES_LEN_PRIOR = [8, 2, 0, 6];
const NUMBER_LEN_PRIOR = [0, 18, 14, 8, 0];

/**
 * How much we dislike a reading before counting edits. A plate that parses as a
 * real series beats a freeform blob by a wide margin, and a recognised state
 * code beats an unrecognised one -- but never at the cost of many rewrites.
 */
function layoutPenalty(parsed) {
  if (parsed.format === 'other') return 200;
  const base = parsed.strong ? 0 : 60;
  if (parsed.format !== 'standard') return base;
  return base + SERIES_LEN_PRIOR[parsed.seriesLen] + NUMBER_LEN_PRIOR[parsed.numberLen];
}

/**
 * The merge key used to spot "probably the same bike, misread by one character".
 * Every look-alike collapses to one representative, so MH12AB1234 and
 * MHI2A8I234 share a key and the second scan gets flagged for a human to judge.
 */
export function fuzzyKey(plate) {
  return [...scrub(plate)].map((c) => (TO_SHAPE[c] === undefined ? c : TO_SHAPE[c])).join('');
}

/** Human-facing spacing: "MH12AB1234" becomes "MH 12 AB 1234". */
export function formatPlate(plate) {
  const cleaned = scrub(plate);
  const parsed = classify(cleaned);
  if (!parsed || parsed.format === 'other') return cleaned;
  return parsed.parts.join(' ');
}

/**
 * Normalise one raw reading into a canonical plate.
 *
 * @returns {{ok: boolean, plate: string, pretty: string, format: string,
 *   fuzzy: string, confidence: number, corrected: boolean, original: string}}
 */
export function normalizePlate(raw) {
  const original = scrub(raw);
  const rejected = {
    ok: false, plate: '', pretty: '', format: 'invalid',
    fuzzy: '', confidence: 0, corrected: false, original,
  };
  if (original.length < 4) return rejected;

  // Score every plausible reading and keep the best one. Several corrections can
  // be individually valid -- MHI2A8I234 is both MH12AB1234 and MH1ZAB1234 -- so
  // the winner is the one that changes the fewest characters the camera saw.
  let best = null;
  const consider = (candidate) => {
    const candidateParsed = classify(candidate);
    if (!candidateParsed) return;
    const changes = countChanges(original, candidate);
    const score = layoutPenalty(candidateParsed) + changes * 10;
    if (!best || score < best.score) {
      best = { text: candidate, parsed: candidateParsed, changes, score };
    }
  };

  consider(original);
  for (const candidate of correctionCandidates(original)) consider(candidate);

  if (!best) return rejected;

  const { text, parsed } = best;
  const corrected = best.changes > 0;

  let confidence = 0.5;
  if (parsed.format === 'standard' || parsed.format === 'bh') confidence = 0.75;
  if (parsed.strong) confidence = 0.95;
  if (corrected) confidence -= 0.15;
  if (text.length < 6) confidence -= 0.1;

  return {
    ok: true,
    plate: text,
    pretty: parsed.parts.join(' '),
    format: parsed.format,
    fuzzy: fuzzyKey(text),
    confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(2)))),
    corrected,
    original,
  };
}

/**
 * Pick the most plate-like reading out of everything OCR returned.
 * Candidates are scored on format strength first, then on length.
 */
export function bestReading(lines) {
  let best = null;
  for (const line of lines || []) {
    for (const token of String(line).split(/\s{2,}|\n/)) {
      const result = normalizePlate(token);
      if (!result.ok) continue;
      const better = !best
        || result.confidence > best.confidence
        || (result.confidence === best.confidence && result.plate.length > best.plate.length);
      if (better) best = result;
    }
  }
  return best;
}
