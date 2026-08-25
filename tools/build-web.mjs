/**
 * Assemble the deployable site into public/.
 *
 * There is no bundler and nothing is compiled: this only gathers web/ and the
 * shared plate normaliser into the single directory Firebase Hosting (or any
 * static host) expects to upload.
 *
 *   npm run build:web
 */

import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public');

/**
 * Inject the Firebase project settings at build time.
 *
 * A Firebase web config is not a secret -- it ships inside every deployed page
 * and Google documents it as public. It is still kept out of the repository,
 * because leaving it in source triggers a secret-scanning alert on every push,
 * and an alert everyone has learned to ignore is worse than no alert at all.
 *
 * Read from firebase.config.json (git-ignored) or the FIREBASE_CONFIG
 * environment variable, so a deploy from CI works the same way.
 */
function injectFirebaseConfig() {
  const file = join(root, 'firebase.config.json');
  let raw = process.env.FIREBASE_CONFIG;
  if (!raw && existsSync(file)) raw = readFileSync(file, 'utf8');

  const target = join(out, 'firebase-config.js');
  if (!raw) {
    console.log('No Firebase config found; the built app will expect a TagCheck server.');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`Firebase config is not valid JSON: ${error.message}`);
    process.exit(1);
  }

  for (const key of ['apiKey', 'authDomain', 'projectId', 'appId']) {
    if (!parsed[key]) {
      console.error(`Firebase config is missing "${key}".`);
      process.exit(1);
    }
  }

  const source = readFileSync(target, 'utf8');
  const replaced = source.replace(
    /export const firebaseConfig = null;/,
    `export const firebaseConfig = ${JSON.stringify(parsed, null, 2)};`,
  );
  if (replaced === source) {
    console.error('Could not inject the Firebase config: the placeholder was not found.');
    process.exit(1);
  }

  writeFileSync(target, replaced);
  console.log(`Injected Firebase config for project ${parsed.projectId}`);
}

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

injectFirebaseConfig();

console.log('Built public/ from web/ + shared/plate.js');
