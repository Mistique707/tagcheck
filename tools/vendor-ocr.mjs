/**
 * Copy the recognition engine into web/vendor so the app reads plates without
 * touching a third-party CDN, and keeps reading them with no signal at all.
 *
 *   npm run vendor:ocr
 *
 * The files are large (roughly 15 MB, mostly the trained language data) and are
 * intentionally not committed. Run this on the machine that hosts the server.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'vendor');

const CDN = 'https://cdn.jsdelivr.net/npm';
const FILES = [
  [`${CDN}/tesseract.js@6/dist/tesseract.min.js`, 'tesseract.min.js', true],
  [`${CDN}/tesseract.js@6/dist/worker.min.js`, 'worker.min.js', true],
  [`${CDN}/tesseract.js-core@6/tesseract-core.wasm.js`, 'tesseract-core.wasm.js', true],
  [`${CDN}/tesseract.js-core@6/tesseract-core-simd.wasm.js`, 'tesseract-core-simd.wasm.js', true],
  [`${CDN}/tesseract.js-core@6/tesseract-core-lstm.wasm.js`, 'tesseract-core-lstm.wasm.js', false],
  [`${CDN}/tesseract.js-core@6/tesseract-core-simd-lstm.wasm.js`, 'tesseract-core-simd-lstm.wasm.js', false],
  [`${CDN}/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz`, 'eng.traineddata.gz', true],
];

mkdirSync(OUT_DIR, { recursive: true });

let failed = 0;
for (const [url, name, required] of FILES) {
  process.stdout.write(`fetching ${name} ... `);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    writeFileSync(join(OUT_DIR, name), bytes);
    console.log(`${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
  } catch (error) {
    console.log(`failed (${error.message})`);
    if (required) failed += 1;
  }
}

if (failed) {
  console.error(`\n${failed} required file(s) missing. The app will fall back to the CDN.`);
  process.exitCode = 1;
} else {
  console.log('\nDone. Restart the server and the app will use the local engine.');
}
