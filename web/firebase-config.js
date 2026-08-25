/**
 * Firebase project settings.
 *
 * Leave this as null to run against a TagCheck server instead (see api.js).
 * Fill it in and the app talks straight to Firestore with no server at all --
 * that is the free, nothing-to-host setup described in docs/FIREBASE.md.
 *
 * These values are not secrets. A Firebase web config is meant to be public;
 * what protects your data is firestore.rules, not this file.
 *
 * Copy yours from the Firebase console:
 *   Project settings -> General -> Your apps -> Web app -> SDK setup
 */

export const firebaseConfig = null;

/* Replace the line above with your own, for example:

export const firebaseConfig = {
  apiKey: 'AIzaSy...',
  authDomain: 'night-owls-mc.firebaseapp.com',
  projectId: 'night-owls-mc',
  storageBucket: 'night-owls-mc.firebasestorage.app',
  messagingSenderId: '123456789012',
  appId: '1:123456789012:web:abc123def456',
};

*/

/** Pinned so an SDK release cannot change behaviour under a live drive. */
export const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/12.18.0';

/** Set by the emulator harness during local testing; ignored in production. */
export const emulator = globalThis.__TAGCHECK_EMULATOR__ || null;
