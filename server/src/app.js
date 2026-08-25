import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';

import { config } from './config.js';
import { api } from './routes/api.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

export function createApp() {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        // The OCR engine ships as a wasm module that spawns a blob worker.
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net', 'blob:', "'wasm-unsafe-eval'"],
        workerSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", 'https://cdn.jsdelivr.net', 'blob:', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        mediaSrc: ["'self'", 'blob:'],
        // Deliberately no upgrade-insecure-requests: a club server often runs
        // on plain http over the local network during a drive, and upgrading
        // those requests breaks both the app shell and the service worker.
        upgradeInsecureRequests: null,
      },
    },
    // The camera preview needs to be readable by our own canvas code.
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  app.use(cors(config.corsOrigin
    ? { origin: config.corsOrigin.split(',').map((o) => o.trim()) }
    : {}));

  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'tagcheck', time: new Date().toISOString() });
  });

  app.use('/api', api);

  // The browser imports the same normaliser the server uses.
  app.use('/shared', express.static(join(root, 'shared'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  app.use(express.static(join(root, 'web'), {
    setHeaders: (res, path) => {
      // The service worker must never be served from a stale cache entry.
      if (path.endsWith('sw.js') || path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  // Everything else is the single-page app.
  app.get('*', (_req, res) => res.sendFile(join(root, 'web', 'index.html')));

  // eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity.
  app.use((error, _req, res, _next) => {
    console.error('[tagcheck]', error);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}
