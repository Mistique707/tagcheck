/**
 * Assemble the deployable site into public/.
 *
 * There is no bundler and nothing is compiled: this only gathers web/ and the
 * shared plate normaliser into the single directory Firebase Hosting (or any
 * static host) expects to upload.
 *
 *   npm run build:web
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(join(root, 'web'), out, { recursive: true });

// The browser imports the very same normaliser the server uses.
mkdirSync(join(out, 'shared'), { recursive: true });
cpSync(join(root, 'shared', 'plate.js'), join(out, 'shared', 'plate.js'));

// Static hosts should serve this as-is.
writeFileSync(join(out, '.nojekyll'), '');

if (!existsSync(join(out, 'index.html'))) {
  console.error('build failed: index.html missing from public/');
  process.exit(1);
}

console.log(`Built public/ from web/ + shared/plate.js`);
