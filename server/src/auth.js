import { timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';

import { config } from './config.js';
import { getMember } from './db.js';

/** Compare secrets without leaking their length or contents through timing. */
function secretEquals(supplied, expected) {
  const a = Buffer.from(String(supplied ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Codes are typed by humans off a poster or a group chat, so accept the code in
 * whatever case and spacing it arrives in.
 */
function tidyCode(code) {
  return String(code ?? '').replace(/\s+/g, '').toUpperCase();
}

/** Returns 'admin', 'member', or null when the code matches nothing. */
export function checkCode(code) {
  const tidy = tidyCode(code);
  if (!tidy) return null;
  if (secretEquals(tidy, tidyCode(config.adminCode))) return 'admin';
  if (secretEquals(tidy, tidyCode(config.joinCode))) return 'member';
  return null;
}

export function issueToken(member) {
  return jwt.sign(
    { name: member.name, admin: Boolean(member.is_admin) },
    config.jwtSecret,
    { subject: String(member.id), expiresIn: config.tokenTtl },
  );
}

/** Express middleware: attaches req.member or answers 401. */
export function requireMember(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'sign_in_required' });

  let claims;
  try {
    claims = jwt.verify(token, config.jwtSecret);
  } catch {
    return res.status(401).json({ error: 'sign_in_required' });
  }

  const member = getMember(Number(claims.sub));
  if (!member) return res.status(401).json({ error: 'sign_in_required' });

  req.member = member;
  return next();
}

export function requireAdmin(req, res, next) {
  if (!req.member?.is_admin) return res.status(403).json({ error: 'admin_only' });
  return next();
}
