/** Client-side settings. Everything here is safe to publish. */

export const APP_VERSION = '1.1.0';

/**
 * Where the recognition engine is loaded from.
 *
 * The app tries the self-hosted copy first, so a club that runs
 * `npm run vendor:ocr` gets plate reading with no third-party requests and it
 * keeps working offline. Otherwise it falls back to the public CDN. Either way
 * a member can always type the plate by hand.
 */
export const OCR_SOURCES = {
  local: {
    script: '/vendor/tesseract.min.js',
    workerPath: '/vendor/worker.min.js',
    corePath: '/vendor/',
    langPath: '/vendor/',
  },
  cdn: {
    script: 'https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js',
    workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/worker.min.js',
    corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6',
    langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
  },
};

/** Longest a single recognition attempt may run before we offer manual entry. */
export const OCR_TIMEOUT_MS = 20000;

/** How often the plate mirror refreshes while the app is open. */
export const SYNC_INTERVAL_MS = 3 * 60 * 1000;
