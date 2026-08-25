import { Router } from 'express';
import rateLimit from 'express-rate-limit';

import { normalizePlate } from '../../../shared/plate.js';
import { config } from '../config.js';
import { checkCode, issueToken, requireMember } from '../auth.js';
import {
  allTagsForExport, findActiveTag, findByClientTagId, findSimilarTags, findTagById,
  insertTag, listTags, removeTag, stats, tagsChangedSince, upsertMember,
} from '../db.js';

export const api = Router();

const signInLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_attempts' },
});

const writeLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'slow_down' },
});

/** Shape a database row into the JSON the app renders. */
function publicTag(row) {
  if (!row) return null;
  return {
    id: row.id,
    plate: row.plate,
    format: row.format,
    taggedBy: row.member_name,
    taggedById: row.member_id,
    note: row.note || '',
    lat: row.lat,
    lon: row.lon,
    createdAt: row.created_at,
    removedAt: row.removed_at || null,
  };
}

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message));
}

api.post('/session', signInLimit, (req, res) => {
  const { code, name, deviceId } = req.body ?? {};

  if (!checkCode(code)) return res.status(401).json({ error: 'bad_code' });

  const cleanName = String(name ?? '').trim().slice(0, 40);
  if (cleanName.length < 2) return res.status(400).json({ error: 'name_required' });

  const cleanDevice = String(deviceId ?? '').trim().slice(0, 64);
  if (cleanDevice.length < 8) return res.status(400).json({ error: 'device_id_required' });

  const member = upsertMember({ name: cleanName, deviceId: cleanDevice });

  return res.json({
    token: issueToken(member),
    member: { id: member.id, name: member.name },
    club: { name: config.clubName, joinUrl: config.joinUrl },
  });
});

/** Club-wide settings the app shows before anyone signs in. */
api.get('/club', (_req, res) => {
  res.json({ name: config.clubName, joinUrl: config.joinUrl });
});

/**
 * The core question: has anyone tagged this bike?
 *
 * `status` is one of:
 *   free    - nothing on record, go ahead and tag it
 *   tagged  - an active tag exists, leave the bike alone
 *   similar - no exact match, but a plate one look-alike character away exists,
 *             so a human should confirm before adding a second sign
 */
api.get('/plates/:plate', requireMember, (req, res) => {
  const reading = normalizePlate(req.params.plate);
  if (!reading.ok) return res.status(400).json({ error: 'unreadable_plate' });

  const existing = findActiveTag(reading.plate);
  if (existing) {
    return res.json({ reading, status: 'tagged', tag: publicTag(existing), similar: [] });
  }

  const similar = findSimilarTags(reading.fuzzy, reading.plate).map(publicTag);
  return res.json({
    reading,
    status: similar.length ? 'similar' : 'free',
    tag: null,
    similar,
  });
});

api.post('/tags', requireMember, writeLimit, (req, res) => {
  const {
    plate, note, lat, lon, clientTagId,
  } = req.body ?? {};

  const reading = normalizePlate(plate);
  if (!reading.ok) return res.status(400).json({ error: 'unreadable_plate' });

  // A retried offline tag must land on the row it already created, not a new one.
  const replayed = findByClientTagId(clientTagId);
  if (replayed) {
    return res.status(200).json({ status: 'tagged', tag: publicTag(replayed), replayed: true });
  }

  const existing = findActiveTag(reading.plate);
  if (existing) {
    return res.status(409).json({ status: 'tagged', tag: publicTag(existing) });
  }

  try {
    const created = insertTag({
      plate: reading.plate,
      fuzzy: reading.fuzzy,
      format: reading.format,
      memberId: req.member.id,
      note: String(note ?? '').trim().slice(0, 280) || null,
      lat: Number.isFinite(Number(lat)) ? Number(lat) : null,
      lon: Number.isFinite(Number(lon)) ? Number(lon) : null,
      clientTagId: clientTagId ? String(clientTagId).slice(0, 64) : null,
    });
    return res.status(201).json({ status: 'tagged', tag: publicTag(created) });
  } catch (error) {
    // Two phones hit the same plate in the same instant: the database decides.
    if (isUniqueViolation(error)) {
      const winner = findActiveTag(reading.plate) || findByClientTagId(clientTagId);
      return res.status(409).json({ status: 'tagged', tag: publicTag(winner) });
    }
    throw error;
  }
});

api.get('/tags', requireMember, (req, res) => {
  const rows = listTags({
    limit: req.query.limit,
    before: req.query.before,
    memberId: req.query.mine === '1' ? req.member.id : undefined,
  });
  res.json({
    tags: rows.map(publicTag),
    nextBefore: rows.length ? rows[rows.length - 1].created_at : null,
  });
});

/**
 * Untag a bike: the sign fell off, or it was a mistake. Any member may do this.
 * The club is a group of friends, and the common case is fixing someone else's
 * mistake while they are not around.
 */
api.delete('/tags/:id', requireMember, (req, res) => {
  const tag = findTagById(Number(req.params.id));
  if (!tag || tag.removed_at) return res.status(404).json({ error: 'not_found' });

  return res.json({ tag: publicTag(removeTag(tag.id, req.member.id)) });
});

/** Delta feed so a phone can answer lookups in a basement car park. */
api.get('/sync', requireMember, (req, res) => {
  const since = typeof req.query.since === 'string' ? req.query.since : '';
  const rows = tagsChangedSince(since);
  res.json({
    now: new Date().toISOString(),
    full: !since,
    plates: rows.map((r) => ({
      plate: r.plate,
      fuzzy: r.fuzzy_key,
      taggedBy: r.member_name,
      createdAt: r.created_at,
      removedAt: r.removed_at || null,
    })),
  });
});

api.get('/stats', requireMember, (req, res) => {
  res.json(stats(req.member.id));
});

api.get('/export.csv', requireMember, (_req, res) => {
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = 'id,plate,format,tagged_by,note,lat,lon,created_at,removed_at';
  const lines = allTagsForExport().map((row) => [
    row.id, row.plate, row.format, row.member_name, row.note,
    row.lat, row.lon, row.created_at, row.removed_at,
  ].map(escape).join(','));

  res.type('text/csv').attachment('tagcheck-export.csv').send([header, ...lines].join('\n'));
});
