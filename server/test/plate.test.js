import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bestReading, formatPlate, fuzzyKey, normalizePlate, rankReadings,
  scrub, usefulAlternatives,
} from '../../shared/plate.js';

test('scrub removes spacing, punctuation and plate furniture', () => {
  assert.equal(scrub('MH 12 AB 1234'), 'MH12AB1234');
  assert.equal(scrub('mh-12-ab-1234'), 'MH12AB1234');
  assert.equal(scrub('IND MH12AB1234'), 'MH12AB1234');
  assert.equal(scrub('  KA.01.HA.9999  '), 'KA01HA9999');
});

test('standard plates normalise and keep their canonical form', () => {
  for (const raw of ['MH12AB1234', 'mh 12 ab 1234', 'MH-12-AB-1234']) {
    const result = normalizePlate(raw);
    assert.equal(result.ok, true);
    assert.equal(result.plate, 'MH12AB1234');
    assert.equal(result.format, 'standard');
    assert.equal(result.corrected, false);
  }
});

test('every scan of one bike produces the same canonical plate', () => {
  const variants = ['KA 01 HA 9999', 'ka01ha9999', 'KA-01-HA-9999', ' KA01HA9999 '];
  const plates = new Set(variants.map((v) => normalizePlate(v).plate));
  assert.equal(plates.size, 1, 'variants must collapse to one plate');
});

test('shorter and older layouts are still accepted', () => {
  assert.equal(normalizePlate('KA01A1234').plate, 'KA01A1234');
  assert.equal(normalizePlate('MH12A123').plate, 'MH12A123');
  assert.equal(normalizePlate('DL8CAF1234').plate, 'DL8CAF1234');
});

test('Bharat series plates are recognised', () => {
  const result = normalizePlate('23 BH 1234 AB');
  assert.equal(result.ok, true);
  assert.equal(result.plate, '23BH1234AB');
  assert.equal(result.format, 'bh');
});

test('look-alike misreads are corrected towards a valid layout', () => {
  const result = normalizePlate('MHI2A8I234');
  assert.equal(result.ok, true);
  assert.equal(result.plate, 'MH12AB1234');
  assert.equal(result.corrected, true);
  assert.ok(result.confidence < 0.95, 'a corrected reading must not claim full confidence');
});

test('a valid plate is never rewritten by the corrector', () => {
  const result = normalizePlate('MH12AB1234');
  assert.equal(result.plate, 'MH12AB1234');
  assert.equal(result.corrected, false);
});

test('unknown state codes are accepted but flagged as lower confidence', () => {
  const known = normalizePlate('MH12AB1234');
  const unknown = normalizePlate('XX12AB1234');
  assert.equal(unknown.ok, true);
  assert.ok(unknown.confidence < known.confidence);
});

test('noise and too-short strings are rejected', () => {
  for (const raw of ['', '   ', 'AB', 'X1', '...']) {
    assert.equal(normalizePlate(raw).ok, false);
  }
});

test('fuzzy keys collapse camera confusions so near-misses can be caught', () => {
  assert.equal(fuzzyKey('MH12AB1234'), fuzzyKey('MHI2A8I234'));
  assert.equal(fuzzyKey('KA01HA9999'), fuzzyKey('KAO1HA9999'));
});

test('fuzzy keys keep genuinely different plates apart', () => {
  assert.notEqual(fuzzyKey('MH12AB1234'), fuzzyKey('MH12AB1235'));
  assert.notEqual(fuzzyKey('MH12AB1234'), fuzzyKey('KA12AB1234'));
});

test('formatting groups a plate the way it is painted', () => {
  assert.equal(formatPlate('MH12AB1234'), 'MH 12 AB 1234');
  assert.equal(formatPlate('23BH1234AB'), '23 BH 1234 AB');
});

test('bestReading picks the plate out of surrounding OCR noise', () => {
  const lines = ['IND', 'MH 12 AB 1234', 'HERO SPLENDOR'];
  const best = bestReading(lines);
  assert.equal(best.plate, 'MH12AB1234');
});

test('bestReading returns null when nothing looks like a plate', () => {
  assert.equal(bestReading(['...', 'no']), null);
});

test('a two-row motorcycle plate is read as one plate, not two halves', () => {
  // How a two-row plate actually arrives from the camera: one block, one newline.
  const best = bestReading(['MH 12\nAB 1234']);
  assert.equal(best.plate, 'MH12AB1234');
});

test('a fragment never beats the whole plate it came from', () => {
  const best = bestReading(['MH 12', 'AB 1234', 'MH 12\nAB 1234']);
  assert.equal(best.plate, 'MH12AB1234');
});

test('separate rows offered as separate lines still resolve when joined', () => {
  const best = bestReading(['KA 01', 'HA 9999', 'KA 01HA 9999']);
  assert.equal(best.plate, 'KA01HA9999');
});

test('runner-up readings are offered, best first, without duplicates', () => {
  const ranked = rankReadings([
    'MH 12 AB 1234',
    'MH 12 AB 1284',
    'MH 12 AB 1234',
    'rubbish',
  ]);
  assert.ok(ranked.length >= 2, 'the alternatives are what make a wrong read cheap to fix');
  assert.equal(ranked[0].plate, 'MH12AB1234');
  assert.equal(new Set(ranked.map((r) => r.plate)).size, ranked.length, 'no repeats');
  for (let i = 1; i < ranked.length; i += 1) {
    assert.ok(ranked[i - 1].confidence >= ranked[i].confidence, 'best first');
  }
});

test('ranking never returns more than asked for', () => {
  const ranked = rankReadings(['MH12AB1234', 'KA01HA9999', 'TN09BC4455', 'UP16DK7702'], 2);
  assert.equal(ranked.length, 2);
});

test('bestReading still agrees with the top of the ranking', () => {
  const lines = ['MH 12\nAB 1234', 'MH 12'];
  assert.equal(bestReading(lines).plate, rankReadings(lines)[0].plate);
});

test('fragments of the chosen plate are not offered as alternatives', () => {
  // What recognition actually returns beside a winner: pieces of the same plate.
  const ranked = rankReadings(['MH 12 AB 1234', 'MH 12', 'AB 1234']);
  const offered = usefulAlternatives(ranked, 'MH12AB1234');
  assert.equal(offered.length, 0, 'a piece of the plate is not a different guess');
});

test('a genuine disagreement IS offered', () => {
  const ranked = rankReadings(['MH 12 AB 1234', 'MH 12 AB 1284']);
  const offered = usefulAlternatives(ranked, 'MH12AB1234');
  assert.equal(offered.length, 1);
  assert.equal(offered[0].plate, 'MH12AB1284');
});

test('alternatives never include the plate already on screen', () => {
  const ranked = rankReadings(['KA 01 HA 9999', 'KA 01 HA 9998']);
  const offered = usefulAlternatives(ranked, 'KA01HA9999');
  assert.ok(offered.every((r) => r.plate !== 'KA01HA9999'));
});
