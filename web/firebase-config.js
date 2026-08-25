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

export const firebaseConfig = {
  apiKey: 'AIzaSyCqxC7ynlXS684ynRDVv9vIhOmlHysqj3k',
  authDomain: 'tagcheck-adc9c.firebaseapp.com',
  projectId: 'tagcheck-adc9c',
  storageBucket: 'tagcheck-adc9c.firebasestorage.app',
  messagingSenderId: '862349987743',
  appId: '1:862349987743:web:33bbd2e323b0b9ca3737aa',
};

/* To go back to running against a TagCheck server instead, set this to null:

export const firebaseConfig = null;

*/

/** Pinned so an SDK release cannot change behaviour under a live drive. */
export const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/12.18.0';

/** Set by the emulator harness during local testing; ignored in production. */
export const emulator = globalThis.__TAGCHECK_EMULATOR__ || null;
