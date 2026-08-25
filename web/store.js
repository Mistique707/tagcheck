/**
 * On-device storage.
 *
 * Two jobs, both about working where the signal does not: a mirror of every
 * tagged plate so a lookup can be answered in a basement car park, and a queue
 * of tags made offline that get replayed when the phone reconnects.
 */

const DB_NAME = 'tagcheck';
const DB_VERSION = 1;

let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('plates')) {
        const plates = db.createObjectStore('plates', { keyPath: 'plate' });
        plates.createIndex('fuzzy', 'fuzzy', { unique: false });
      }
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'clientTagId' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, run) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    try {
      result = run(store);
    } catch (error) {
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(isBox(result) ? result.value : result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/**
 * A request result is only available once the transaction completes, so it is
 * parked in a box until then. The marker matters: a lookup that finds nothing
 * leaves `value` undefined, and without it an empty box reads as a hit.
 */
const BOX = Symbol('idb-result');
const isBox = (candidate) => Boolean(candidate) && candidate[BOX] === true;

const wrap = (request) => {
  const box = { [BOX]: true, value: undefined };
  request.onsuccess = () => { box.value = request.result; };
  return box;
};

/** Apply a delta from the server: removals drop out of the mirror entirely. */
export async function applyPlates(rows) {
  return tx('plates', 'readwrite', (store) => {
    for (const row of rows) {
      if (row.removedAt) store.delete(row.plate);
      else {
        store.put({
          plate: row.plate,
          fuzzy: row.fuzzy,
          taggedBy: row.taggedBy,
          createdAt: row.createdAt,
        });
      }
    }
  });
}

export async function localPlate(plate) {
  return tx('plates', 'readonly', (store) => wrap(store.get(plate)));
}

export async function localSimilar(fuzzy, excludePlate) {
  const rows = await tx('plates', 'readonly', (store) => wrap(store.index('fuzzy').getAll(fuzzy)));
  return (rows || []).filter((row) => row.plate !== excludePlate);
}

/** Record a tag locally the moment it is made, online or not. */
export async function rememberLocalTag({ plate, fuzzy, taggedBy }) {
  return tx('plates', 'readwrite', (store) => {
    store.put({ plate, fuzzy, taggedBy, createdAt: new Date().toISOString() });
  });
}

export async function forgetLocalTag(plate) {
  return tx('plates', 'readwrite', (store) => store.delete(plate));
}

export async function clearPlates() {
  return tx('plates', 'readwrite', (store) => store.clear());
}

export async function queueAdd(item) {
  return tx('queue', 'readwrite', (store) => store.put(item));
}

export async function queueAll() {
  return (await tx('queue', 'readonly', (store) => wrap(store.getAll()))) || [];
}

export async function queueRemove(clientTagId) {
  return tx('queue', 'readwrite', (store) => store.delete(clientTagId));
}

export async function queueCount() {
  return (await tx('queue', 'readonly', (store) => wrap(store.count()))) || 0;
}

export async function getMeta(key) {
  const row = await tx('meta', 'readonly', (store) => wrap(store.get(key)));
  return row ? row.value : undefined;
}

export async function setMeta(key, value) {
  return tx('meta', 'readwrite', (store) => store.put({ key, value }));
}
