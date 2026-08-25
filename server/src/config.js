import { randomBytes } from 'node:crypto';

/**
 * Configuration comes from the environment so the same build runs locally and
 * on a host. Nothing here is secret by default: if a secret is missing we
 * generate one and say so loudly rather than shipping a well-known fallback
 * that every deployment of this repo would share.
 */

const generated = [];

function fromEnv(key, fallbackFactory) {
  const value = process.env[key];
  if (value && value.trim()) return value.trim();
  const made = fallbackFactory();
  generated.push(key);
  return made;
}

/** Short, unambiguous code a member can type from a WhatsApp message. */
function memorableCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  clubName: process.env.CLUB_NAME || 'TagCheck',
  joinUrl: process.env.JOIN_URL || '',
  dbFile: process.env.DB_FILE || 'data/tagcheck.db',
  jwtSecret: fromEnv('JWT_SECRET', () => randomBytes(32).toString('hex')),
  joinCode: fromEnv('JOIN_CODE', memorableCode),
  tokenTtl: process.env.TOKEN_TTL || '180d',
  corsOrigin: process.env.CORS_ORIGIN || '',
  trustProxy: process.env.TRUST_PROXY || '',
};

/** Print the codes an operator needs on first boot, once, at startup. */
export function reportGeneratedSecrets(log = console) {
  if (!generated.length) return;
  log.warn('');
  log.warn('  TagCheck generated values that were not set in the environment:');
  for (const key of generated) {
    const value = key === 'JWT_SECRET' ? '(random, tokens reset on restart)' : config[keyToField(key)];
    log.warn(`    ${key} = ${value}`);
  }
  log.warn('  Set these in your environment to keep them stable across restarts.');
  log.warn('');
}

function keyToField(key) {
  return {
    JWT_SECRET: 'jwtSecret',
    JOIN_CODE: 'joinCode',
  }[key];
}
