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

/**
 * A SEPARATE, billable key for Google Cloud Vision, injected at build time from
 * the "visionApiKey" field of firebase.config.json. Null means the app reads
 * plates entirely on the device, as it did before.
 *
 * Unlike the Firebase config above, this key can cost money. Restrict it to the
 * club domain and cap its daily quota -- docs/FIREBASE.md walks through both.
 */
export const VISION_API_KEY = null;

/*
 * Leave the line above as null. `npm run build:web` replaces it with your real
 * project settings, read from firebase.config.json in the repository root (or
 * the FIREBASE_CONFIG environment variable, for CI).
 *
 * firebase.config.json is git-ignored. Not because the values are secret --
 * a Firebase web config ships inside every deployed page and Google documents
 * it as public -- but because committing it trips secret scanning on every
 * push, and an alert people learn to ignore is worse than no alert.
 *
 * What actually protects your data is firestore.rules, plus restricting this
 * key to your own domains in the Google Cloud console. See docs/FIREBASE.md.
 *
 * To create it, copy the config from the Firebase console:
 *
 *   {
 *     "apiKey": "AIza...",
 *     "authDomain": "your-project.firebaseapp.com",
 *     "projectId": "your-project",
 *     "storageBucket": "your-project.firebasestorage.app",
 *     "messagingSenderId": "123456789012",
 *     "appId": "1:123456789012:web:abc123"
 *   }
 */

/** Pinned so an SDK release cannot change behaviour under a live drive. */
export const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/12.18.0';

/** Set by the emulator harness during local testing; ignored in production. */
export const emulator = globalThis.__TAGCHECK_EMULATOR__ || null;
