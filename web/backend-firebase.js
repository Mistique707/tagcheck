/**
 * The serverless backend: Firestore holds the club records directly.
 *
 * Two things make this work without a server.
 *
 * First, a tag document is keyed by the plate itself, and the rules allow
 * `create` but never `update`. A second person tagging the same bike is
 * therefore attempting an update, and Firestore refuses it -- the same
 * guarantee the self-hosted version gets from a unique index.
 *
 * Second, the whole tag collection is mirrored into the phone by one snapshot
 * listener with persistence turned on. Lookups are answered from that mirror,
 * so they are instant, they work with no signal, and they cost no reads.
 */

import { FIREBASE_SDK, emulator, firebaseConfig } from './firebase-config.js';
import { fuzzyKey } from './shared/plate.js';

export class BackendError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const PENDING_KEY = 'tagcheck.fb.pending';
const MEMBER_KEY = 'tagcheck.fb.member';

let sdk;
let db;
let auth;
let member = null;
let unsubscribe;

/** plate -> tag, kept live by the snapshot listener. */
const mirror = new Map();
let mirrorReady = false;
let onChange = () => {};

async function loadSdk() {
  if (sdk) return sdk;
  const [appMod, authMod, storeMod] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-auth.js`),
    import(`${FIREBASE_SDK}/firebase-firestore.js`),
  ]);
  sdk = { ...appMod, ...authMod, ...storeMod };
  return sdk;
}

async function ensure() {
  if (db) return;
  const s = await loadSdk();
  const app = s.initializeApp(emulator
    ? { projectId: emulator.projectId, apiKey: 'emulator-does-not-check-this' }
    : firebaseConfig);

  db = s.initializeFirestore(app, {
    // The local cache is what makes the app usable in a basement car park.
    localCache: s.persistentLocalCache({ tabManager: s.persistentMultipleTabManager() }),
  });
  auth = s.getAuth(app);

  if (emulator) {
    s.connectAuthEmulator(auth, `http://${emulator.host}:${emulator.authPort}`,
      { disableWarnings: true });
    s.connectFirestoreEmulator(db, emulator.host, emulator.firestorePort);
  }
}

/* Shaping ----------------------------------------------------------------- */

function toIso(value, pending) {
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  // A tag written on this phone has no server time until it syncs.
  return pending ? new Date().toISOString() : null;
}

function shape(docSnap, pending) {
  const data = docSnap.data();
  if (!data) return null;
  return {
    id: docSnap.id,
    plate: data.plate,
    fuzzy: data.fuzzy,
    format: data.format || 'standard',
    taggedBy: data.memberName,
    taggedById: data.memberUid,
    note: data.note || '',
    lat: data.lat ?? null,
    lon: data.lon ?? null,
    createdAt: toIso(data.createdAt, pending) || new Date().toISOString(),
    pending: Boolean(pending),
  };
}

/* The mirror -------------------------------------------------------------- */

function startListening() {
  if (unsubscribe) return;
  const s = sdk;
  unsubscribe = s.onSnapshot(
    s.collection(db, 'tags'),
    { includeMetadataChanges: true },
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'removed') mirror.delete(change.doc.id);
        else mirror.set(change.doc.id, shape(change.doc, change.doc.metadata.hasPendingWrites));
      }
      mirrorReady = true;
      reconcilePending();
      onChange();
    },
    (error) => {
      console.warn('[tagcheck] tag stream stopped:', error.code || error.message);
    },
  );
}

/**
 * Tags made offline are written straight into the cache and sent later. If
 * someone else got that bike first, the write is refused when it reaches the
 * server, so each one is checked off against the mirror once it lands.
 */
function readPending() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
  } catch {
    return [];
  }
}

function writePending(list) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(list));
}

let onLost = () => {};

function reconcilePending() {
  const pending = readPending();
  if (!pending.length || !member) return;

  const settled = [];
  const remaining = [];
  for (const item of pending) {
    const tag = mirror.get(item.plate);
    if (!tag || tag.pending) remaining.push(item);
    else if (tag.taggedById === member.id) settled.push({ ...item, won: true });
    else settled.push({ ...item, won: false, taggedBy: tag.taggedBy });
  }

  if (settled.length !== pending.length || remaining.length !== pending.length) {
    writePending(remaining);
  }
  for (const item of settled.filter((entry) => !entry.won)) {
    onLost(item.plate, item.taggedBy);
  }
}

/* Membership -------------------------------------------------------------- */

function cacheMember(value) {
  member = value;
  if (value) localStorage.setItem(MEMBER_KEY, JSON.stringify(value));
  else localStorage.removeItem(MEMBER_KEY);
}

function restoreMember() {
  try {
    return JSON.parse(localStorage.getItem(MEMBER_KEY) || 'null');
  } catch {
    return null;
  }
}

async function joinAs(uid, name, code) {
  const s = sdk;
  try {
    await s.setDoc(s.doc(db, 'members', uid), {
      name, code, createdAt: s.serverTimestamp(),
    });
    return { id: uid, name };
  } catch (error) {
    // The rules check the code, so a refusal here means the code was wrong.
    if (error.code === 'permission-denied') throw new BackendError('bad_code');
    throw new BackendError('offline');
  }
}

/* The interface app.js talks to ------------------------------------------- */

export const firebaseBackend = {
  mode: 'firebase',

  onChange(handler) { onChange = handler; },
  onLostRace(handler) { onLost = handler; },

  member() { return member; },
  isSignedIn() { return Boolean(member); },

  async club() {
    await ensure();
    try {
      const snap = await sdk.getDoc(sdk.doc(db, 'config', 'public'));
      const data = snap.data() || {};
      return { name: data.name || 'TagCheck', joinUrl: data.joinUrl || '' };
    } catch {
      return { name: 'TagCheck', joinUrl: '' };
    }
  },

  /** Resume a member who has already joined on this phone. */
  async resume() {
    const cached = restoreMember();
    if (!cached) return false;
    await ensure();
    const user = auth.currentUser || await new Promise((resolve) => {
      const stop = sdk.onAuthStateChanged(auth, (value) => {
        stop();
        resolve(value);
      });
    });
    if (!user || user.uid !== cached.id) {
      cacheMember(null);
      return false;
    }
    cacheMember(cached);
    startListening();
    return true;
  },

  async signIn({ code, name }) {
    await ensure();
    const s = sdk;

    let user;
    try {
      ({ user } = await s.signInAnonymously(auth));
    } catch (error) {
      if (error.code === 'auth/operation-not-allowed') {
        throw new BackendError('anonymous_auth_disabled');
      }
      throw new BackendError('offline');
    }

    const ref = s.doc(db, 'members', user.uid);
    let existing;
    try {
      existing = await s.getDoc(ref);
    } catch {
      existing = null;
    }

    if (existing && existing.exists()) {
      const data = existing.data();
      if (data.name !== name) {
        await s.updateDoc(ref, { name });
      }
      cacheMember({ id: user.uid, name });
    } else {
      cacheMember(await joinAs(user.uid, name, code));
    }

    startListening();
    return member;
  },

  async signOut() {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
    mirror.clear();
    mirrorReady = false;
    writePending([]);
    cacheMember(null);
    if (auth) await sdk.signOut(auth);
  },

  /**
   * Answered entirely from the mirror, so it returns in a millisecond and works
   * with no signal.
   */
  async lookup(reading) {
    const exact = mirror.get(reading.plate);
    if (exact) {
      return {
        status: 'tagged', tag: exact, similar: [], offline: !navigator.onLine,
      };
    }

    const key = reading.fuzzy || fuzzyKey(reading.plate);
    const similar = [];
    for (const tag of mirror.values()) {
      if (tag.plate !== reading.plate && tag.fuzzy === key) similar.push(tag);
      if (similar.length >= 5) break;
    }

    return {
      status: similar.length ? 'similar' : 'free',
      tag: null,
      similar,
      offline: !navigator.onLine,
    };
  },

  async tag({ reading, note, lat, lon }) {
    const s = sdk;
    const ref = s.doc(db, 'tags', reading.plate);
    const payload = {
      plate: reading.plate,
      fuzzy: reading.fuzzy || fuzzyKey(reading.plate),
      format: reading.format,
      memberUid: member.id,
      memberName: member.name,
      note: (note || '').slice(0, 280),
      createdAt: s.serverTimestamp(),
      ...(Number.isFinite(lat) ? { lat } : {}),
      ...(Number.isFinite(lon) ? { lon } : {}),
    };

    if (!navigator.onLine) {
      // The cache already told us this bike is free. Write it locally, note it
      // for reconciliation, and let the SDK send it when signal returns.
      const known = mirror.get(reading.plate);
      if (known) return { status: 'conflict', tag: known };

      s.setDoc(ref, payload).catch(() => {});
      const pending = readPending();
      pending.push({ plate: reading.plate, at: new Date().toISOString() });
      writePending(pending);
      return { status: 'queued', tag: null };
    }

    try {
      const winner = await s.runTransaction(db, async (transaction) => {
        const snap = await transaction.get(ref);
        if (snap.exists()) return shape(snap, false);
        transaction.set(ref, payload);
        return null;
      });
      if (winner) return { status: 'conflict', tag: winner };
      return { status: 'tagged', tag: { ...payload, taggedBy: member.name, createdAt: new Date().toISOString() } };
    } catch (error) {
      if (error.code === 'permission-denied') {
        const known = mirror.get(reading.plate);
        if (known) return { status: 'conflict', tag: known };
        throw new BackendError('not_allowed');
      }
      throw new BackendError('offline');
    }
  },

  async untag(tag) {
    try {
      await sdk.deleteDoc(sdk.doc(db, 'tags', tag.plate));
    } catch (error) {
      throw new BackendError(error.code === 'permission-denied' ? 'not_allowed' : 'offline');
    }
  },

  /** Friends fixing each other's mistakes: any member may remove any tag. */
  canUntag(tag) {
    return Boolean(member && tag);
  },

  async feed({ mine, before } = {}) {
    const all = [...mirror.values()]
      .filter((tag) => (mine ? tag.taggedById === member?.id : true))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const start = before ? all.findIndex((tag) => tag.createdAt < before) : 0;
    const page = start < 0 ? [] : all.slice(start, start + 50);
    return {
      tags: page,
      nextBefore: page.length ? page[page.length - 1].createdAt : null,
    };
  },

  /**
   * Counts come from the mirror. Member totals count people who have tagged
   * something, because the rules deliberately stop one member reading another
   * member record.
   */
  async stats() {
    const today = new Date().toISOString().slice(0, 10);
    const byMember = new Map();
    let todayCount = 0;
    let mine = 0;

    for (const tag of mirror.values()) {
      byMember.set(tag.taggedBy, (byMember.get(tag.taggedBy) || 0) + 1);
      if (tag.createdAt.startsWith(today)) todayCount += 1;
      if (member && tag.taggedById === member.id) mine += 1;
    }

    return {
      total: mirror.size,
      mine,
      today: todayCount,
      members: byMember.size,
      leaderboard: [...byMember.entries()]
        .map(([name, tags]) => ({ name, tags }))
        .sort((a, b) => b.tags - a.tags || a.name.localeCompare(b.name))
        .slice(0, 20),
    };
  },

  /** The listener keeps everything current; this only reports where we are. */
  async sync() {
    return { changes: mirror.size, ready: mirrorReady };
  },

  async pendingCount() {
    return readPending().length;
  },

  /** Everything is already on the phone, so the export is built here. */
  async exportCsv() {
    const { toCsv } = await import('./backend.js');
    return toCsv([...mirror.values()].sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    ));
  },
};
