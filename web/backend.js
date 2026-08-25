/**
 * Picks where the club records live.
 *
 * Fill in web/firebase-config.js and the app runs serverless against Firestore.
 * Leave it null and the app talks to a TagCheck server over HTTP. Both expose
 * the same interface, so nothing else in the app changes.
 */

import { emulator, firebaseConfig } from './firebase-config.js';

let chosen;

export async function getBackend() {
  if (chosen) return chosen;

  if (firebaseConfig || emulator) {
    ({ firebaseBackend: chosen } = await import('./backend-firebase.js'));
  } else {
    ({ restBackend: chosen } = await import('./backend-rest.js'));
  }
  return chosen;
}

/** Rendered by whichever backend can produce a full export. */
export function toCsv(rows) {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = 'plate,format,tagged_by,note,lat,lon,created_at';
  const lines = rows.map((row) => [
    row.plate, row.format, row.taggedBy, row.note, row.lat, row.lon, row.createdAt,
  ].map(escape).join(','));
  return [header, ...lines].join('\n');
}
