import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { config } from './config.js';

/**
 * Schema notes:
 *
 * - `plate` is the canonical string from shared/plate.js. The partial unique
 *   index is what actually guarantees a bike cannot be tagged twice: two phones
 *   racing on the same plate means the second INSERT fails at the database, not
 *   at some check-then-write window in application code.
 * - The index is partial (WHERE removed_at IS NULL) so a tag that falls off and
 *   gets removed can be re-tagged later without tripping the constraint.
 * - `client_tag_id` is an idempotency key. A phone that tags while offline
 *   retries the same id when it reconnects, so a flaky network cannot create
 *   duplicate rows or double-count a member.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  device_id   TEXT    NOT NULL UNIQUE,
  created_at  TEXT    NOT NULL,
  last_seen   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id            INTEGER PRIMARY KEY,
  plate         TEXT    NOT NULL,
  fuzzy_key     TEXT    NOT NULL,
  format        TEXT    NOT NULL,
  member_id     INTEGER NOT NULL REFERENCES members(id),
  note          TEXT,
  lat           REAL,
  lon           REAL,
  client_tag_id TEXT    UNIQUE,
  created_at    TEXT    NOT NULL,
  removed_at    TEXT,
  removed_by    INTEGER REFERENCES members(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_tags_active_plate
  ON tags(plate) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_tags_fuzzy   ON tags(fuzzy_key);
CREATE INDEX IF NOT EXISTS ix_tags_created ON tags(created_at);
CREATE INDEX IF NOT EXISTS ix_tags_member  ON tags(member_id);
`;

let db;

export function getDb() {
  if (db) return db;

  const file = config.dbFile === ':memory:' ? ':memory:' : resolve(config.dbFile);
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });

  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/** Test helper: drop the handle so the next getDb() opens a fresh database. */
export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}

const now = () => new Date().toISOString();

export function upsertMember({ name, deviceId }) {
  const database = getDb();
  const existing = database
    .prepare('SELECT * FROM members WHERE device_id = ?')
    .get(deviceId);

  if (existing) {
    database
      .prepare('UPDATE members SET name = ?, last_seen = ? WHERE id = ?')
      .run(name, now(), existing.id);
    return database.prepare('SELECT * FROM members WHERE id = ?').get(existing.id);
  }

  const stamp = now();
  const info = database
    .prepare(`INSERT INTO members (name, device_id, created_at, last_seen)
              VALUES (?, ?, ?, ?)`)
    .run(name, deviceId, stamp, stamp);
  return database.prepare('SELECT * FROM members WHERE id = ?').get(info.lastInsertRowid);
}

export function getMember(id) {
  return getDb().prepare('SELECT * FROM members WHERE id = ?').get(id);
}

const TAG_SELECT = `
  SELECT t.id, t.plate, t.fuzzy_key, t.format, t.note, t.lat, t.lon,
         t.created_at, t.removed_at, t.member_id, m.name AS member_name
  FROM tags t JOIN members m ON m.id = t.member_id
`;

export function findActiveTag(plate) {
  return getDb()
    .prepare(`${TAG_SELECT} WHERE t.plate = ? AND t.removed_at IS NULL`)
    .get(plate);
}

export function findTagById(id) {
  return getDb().prepare(`${TAG_SELECT} WHERE t.id = ?`).get(id);
}

export function findByClientTagId(clientTagId) {
  if (!clientTagId) return undefined;
  return getDb().prepare(`${TAG_SELECT} WHERE t.client_tag_id = ?`).get(clientTagId);
}

/** Near-misses: same shape key, different canonical plate. */
export function findSimilarTags(fuzzy, plate) {
  return getDb()
    .prepare(`${TAG_SELECT} WHERE t.fuzzy_key = ? AND t.plate != ? AND t.removed_at IS NULL LIMIT 5`)
    .all(fuzzy, plate);
}

export function insertTag(tag) {
  const database = getDb();
  const info = database
    .prepare(`INSERT INTO tags
                (plate, fuzzy_key, format, member_id, note, lat, lon, client_tag_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      tag.plate,
      tag.fuzzy,
      tag.format,
      tag.memberId,
      tag.note ?? null,
      tag.lat ?? null,
      tag.lon ?? null,
      tag.clientTagId ?? null,
      now(),
    );
  return findTagById(Number(info.lastInsertRowid));
}

export function removeTag(id, memberId) {
  getDb()
    .prepare('UPDATE tags SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL')
    .run(now(), memberId, id);
  return findTagById(id);
}

export function listTags({ limit = 50, before, memberId } = {}) {
  const clauses = ['t.removed_at IS NULL'];
  const params = [];
  if (before) {
    clauses.push('t.created_at < ?');
    params.push(before);
  }
  if (memberId) {
    clauses.push('t.member_id = ?');
    params.push(memberId);
  }
  params.push(Math.min(Number(limit) || 50, 200));
  return getDb()
    .prepare(`${TAG_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY t.created_at DESC LIMIT ?`)
    .all(...params);
}

/**
 * Everything a phone needs to answer "is this tagged?" without a network.
 * Returns removed tags too, so a client that already cached a plate learns it
 * was untagged instead of holding a stale hit forever.
 */
export function tagsChangedSince(since) {
  const database = getDb();
  // Every column is qualified: members also has a created_at.
  const columns = `t.plate, t.fuzzy_key, t.created_at, t.removed_at, m.name AS member_name`;
  if (!since) {
    return database
      .prepare(`SELECT ${columns}
                FROM tags t JOIN members m ON m.id = t.member_id
                WHERE t.removed_at IS NULL ORDER BY t.created_at ASC`)
      .all();
  }
  return database
    .prepare(`SELECT ${columns}
              FROM tags t JOIN members m ON m.id = t.member_id
              WHERE t.created_at > ? OR t.removed_at > ?
              ORDER BY t.created_at ASC`)
    .all(since, since);
}

export function stats(memberId) {
  const database = getDb();
  const total = database
    .prepare('SELECT COUNT(*) AS n FROM tags WHERE removed_at IS NULL')
    .get().n;
  const mine = memberId
    ? database
      .prepare('SELECT COUNT(*) AS n FROM tags WHERE removed_at IS NULL AND member_id = ?')
      .get(memberId).n
    : 0;
  const today = database
    .prepare(`SELECT COUNT(*) AS n FROM tags
              WHERE removed_at IS NULL AND created_at >= ?`)
    .get(new Date().toISOString().slice(0, 10)).n;
  const members = database.prepare('SELECT COUNT(*) AS n FROM members').get().n;
  const leaderboard = database
    .prepare(`SELECT m.name, COUNT(*) AS tags
              FROM tags t JOIN members m ON m.id = t.member_id
              WHERE t.removed_at IS NULL
              GROUP BY m.id ORDER BY tags DESC, m.name ASC LIMIT 20`)
    .all();
  return { total, mine, today, members, leaderboard };
}

export function allTagsForExport() {
  return getDb()
    .prepare(`SELECT t.id, t.plate, t.format, m.name AS member_name, t.note,
                     t.lat, t.lon, t.created_at, t.removed_at
              FROM tags t JOIN members m ON m.id = t.member_id
              ORDER BY t.created_at ASC`)
    .all();
}
