/**
 * The self-hosted backend: a TagCheck server holds the club records.
 *
 * This wraps the HTTP client and the on-device mirror behind the same
 * interface the Firestore backend offers, so app.js never has to know which
 * one it is talking to.
 */

import {
  ApiError, OfflineError, api, apiUrl, session,
} from './api.js';
import {
  applyPlates, clearPlates, forgetLocalTag, getMeta, localPlate, localSimilar,
  queueAdd, queueAll, queueCount, queueRemove, rememberLocalTag, setMeta,
} from './store.js';

export class BackendError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

let onChange = () => {};
let onLost = () => {};

const uuid = () => (crypto.randomUUID && crypto.randomUUID())
  || `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function translate(error) {
  if (error instanceof OfflineError) return new BackendError('offline');
  if (error instanceof ApiError) {
    if (error.status === 401) return new BackendError('signed_out');
    if (error.code === 'bad_code') return new BackendError('bad_code');
    if (error.code === 'not_allowed') return new BackendError('not_allowed');
  }
  return new BackendError('failed', error.message);
}

export const restBackend = {
  mode: 'server',

  onChange(handler) { onChange = handler; },
  onLostRace(handler) { onLost = handler; },

  member() { return session.member; },
  isSignedIn() { return Boolean(session.token && session.member); },

  async club() {
    try {
      return await api.club();
    } catch {
      return { name: 'TagCheck', joinUrl: '' };
    }
  },

  async resume() {
    if (!this.isSignedIn()) return false;
    await this.sync().catch(() => {});
    return true;
  },

  async signIn({ code, name, server }) {
    session.base = server || '';
    try {
      const result = await api.signIn(code, name, deviceId());
      session.save(result);
      await clearPlates();
      await setMeta('lastSync', '');
      await this.sync();
      return result.member;
    } catch (error) {
      throw translate(error);
    }
  },

  async signOut() {
    session.clear();
    await clearPlates();
    await setMeta('lastSync', '');
  },

  async lookup(reading) {
    if (navigator.onLine) {
      try {
        const result = await api.lookup(reading.plate);
        return { ...result, offline: false };
      } catch (error) {
        if (!(error instanceof OfflineError)) throw translate(error);
      }
    }

    const hit = await localPlate(reading.plate);
    if (hit) {
      return {
        status: 'tagged',
        offline: true,
        tag: {
          plate: hit.plate, taggedBy: hit.taggedBy, createdAt: hit.createdAt, note: '',
        },
        similar: [],
      };
    }

    const similar = await localSimilar(reading.fuzzy, reading.plate);
    return {
      status: similar.length ? 'similar' : 'free',
      offline: true,
      tag: null,
      similar: similar.map((row) => ({
        plate: row.plate, taggedBy: row.taggedBy, createdAt: row.createdAt,
      })),
    };
  },

  async tag({ reading, note, lat, lon }) {
    const payload = {
      plate: reading.plate,
      note: note || '',
      clientTagId: uuid(),
      ...(Number.isFinite(lat) ? { lat } : {}),
      ...(Number.isFinite(lon) ? { lon } : {}),
    };

    try {
      const result = await api.tag(payload);
      const tag = result.tag;
      await rememberLocalTag({ plate: tag.plate, fuzzy: reading.fuzzy, taggedBy: tag.taggedBy });
      onChange();
      return { status: result.conflict ? 'conflict' : 'tagged', tag };
    } catch (error) {
      if (!(error instanceof OfflineError)) throw translate(error);

      // Keep the member moving: queue it and let the server settle duplicates.
      await queueAdd({ ...payload, fuzzy: reading.fuzzy, queuedAt: new Date().toISOString() });
      await rememberLocalTag({
        plate: reading.plate,
        fuzzy: reading.fuzzy,
        taggedBy: session.member?.name || 'you',
      });
      onChange();
      return { status: 'queued', tag: null };
    }
  },

  async untag(tag) {
    try {
      await api.untag(tag.id);
      await forgetLocalTag(tag.plate);
      onChange();
    } catch (error) {
      throw translate(error);
    }
  },

  canUntag(tag) {
    const me = session.member;
    if (!me || !tag || !tag.id) return false;
    if (me.admin) return true;
    return tag.taggedById === me.id
      && Date.now() - Date.parse(tag.createdAt) < 24 * 60 * 60 * 1000;
  },

  async feed(options) {
    try {
      return await api.feed(options);
    } catch (error) {
      throw translate(error);
    }
  },

  async stats() {
    try {
      return await api.stats();
    } catch (error) {
      throw translate(error);
    }
  },

  /** Flush anything queued, then pull the delta into the mirror. */
  async sync() {
    if (!navigator.onLine || !session.token) return { changes: 0, ready: false };

    const pending = await queueAll();
    let sent = 0;
    for (const item of pending) {
      try {
        const result = await api.tag(item);
        await queueRemove(item.clientTagId);
        if (result.conflict) {
          await rememberLocalTag({
            plate: result.tag.plate, fuzzy: item.fuzzy, taggedBy: result.tag.taggedBy,
          });
          onLost(item.plate, result.tag.taggedBy);
        } else {
          sent += 1;
        }
      } catch (error) {
        // A payload the server will never accept must not block the queue.
        if (error instanceof ApiError && error.status === 400) {
          await queueRemove(item.clientTagId);
          continue;
        }
        break;
      }
    }

    const since = await getMeta('lastSync');
    const result = await api.sync(since);
    if (result.full) await clearPlates();
    await applyPlates(result.plates);
    await setMeta('lastSync', result.now);
    onChange();

    return { changes: result.plates.length, sent, ready: true };
  },

  pendingCount() { return queueCount(); },

  async exportCsv() {
    const response = await fetch(apiUrl('/api/export.csv'), {
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (!response.ok) throw new BackendError('not_allowed');
    return response.text();
  },
};

function deviceId() {
  let id = localStorage.getItem('tagcheck.device');
  if (!id) {
    id = uuid();
    localStorage.setItem('tagcheck.device', id);
  }
  return id;
}
