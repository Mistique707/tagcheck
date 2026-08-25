import test from 'node:test';
import assert from 'node:assert/strict';

// Configuration is read when the modules load, so the environment is set first.
process.env.DB_FILE = ':memory:';
process.env.JOIN_CODE = 'RIDE01';
process.env.JWT_SECRET = 'test-secret-not-used-anywhere-real';
process.env.CLUB_NAME = 'Test Riders';

const { createApp } = await import('../src/app.js');

const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => server.close());

async function call(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function signIn(name, deviceId, code = 'RIDE01') {
  const response = await call('/api/session', {
    method: 'POST',
    body: { code, name, deviceId },
  });
  assert.equal(response.status, 200, `sign-in failed: ${JSON.stringify(response.body)}`);
  return response.body.token;
}

let asha;
let bala;
let ravi;

test('the service reports health without a token', async () => {
  const response = await call('/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
});

test('a wrong join code is refused', async () => {
  const response = await call('/api/session', {
    method: 'POST',
    body: { code: 'NOPE', name: 'Stranger', deviceId: 'device-stranger-1' },
  });
  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'bad_code');
});

test('the join code signs a member in', async () => {
  asha = await signIn('Asha', 'device-asha-0001');
  bala = await signIn('Bala', 'device-bala-0001');
  ravi = await signIn('Ravi', 'device-ravi-0001');
  assert.ok(asha && bala && ravi);
});

test('protected routes reject anonymous callers', async () => {
  for (const path of ['/api/plates/MH12AB1234', '/api/tags', '/api/stats', '/api/sync']) {
    const response = await call(path);
    assert.equal(response.status, 401, `${path} should require a token`);
  }
});

test('an untagged bike reads as free', async () => {
  const response = await call('/api/plates/MH12AB1234', { token: asha });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'free');
  assert.equal(response.body.tag, null);
});

test('tagging a free bike records who did it', async () => {
  const response = await call('/api/tags', {
    method: 'POST',
    token: asha,
    body: { plate: 'MH 12 AB 1234', note: 'Black Classic 350, outside cafe' },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.tag.plate, 'MH12AB1234');
  assert.equal(response.body.tag.taggedBy, 'Asha');
});

test('the same bike then reads as tagged, with credit to the first member', async () => {
  const response = await call('/api/plates/MH12AB1234', { token: bala });
  assert.equal(response.body.status, 'tagged');
  assert.equal(response.body.tag.taggedBy, 'Asha');
});

test('a differently written scan of the same plate is still tagged', async () => {
  for (const variant of ['mh12ab1234', 'MH-12-AB-1234', 'MH%2012%20AB%201234']) {
    const response = await call(`/api/plates/${variant}`, { token: bala });
    assert.equal(response.body.status, 'tagged', `${variant} should resolve to the tagged bike`);
  }
});

test('a second member cannot double-tag the same bike', async () => {
  const response = await call('/api/tags', {
    method: 'POST',
    token: bala,
    body: { plate: 'MH12AB1234' },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.tag.taggedBy, 'Asha');
});

test('a misread that can only be one real plate resolves to that bike', async () => {
  // MH12AB1Z34 is not a legal layout, so it repairs to the tagged plate outright.
  const response = await call('/api/plates/MH12AB1Z34', { token: bala });
  assert.equal(response.body.status, 'tagged');
  assert.equal(response.body.tag.taggedBy, 'Asha');
});

test('a misread that is itself a legal plate is surfaced as a near match', async () => {
  // MH1ZAB1234 parses on its own (series ZAB), so it cannot simply be rewritten
  // to MH12AB1234 -- but it is one camera confusion away, so a human decides.
  const response = await call('/api/plates/MH1ZAB1234', { token: bala });
  assert.equal(response.body.status, 'similar');
  assert.equal(response.body.similar[0].plate, 'MH12AB1234');
});

test('an unrelated plate is unaffected by existing tags', async () => {
  const response = await call('/api/plates/KA01HA9999', { token: bala });
  assert.equal(response.body.status, 'free');
});

test('a retried offline tag replays onto the row it already created', async () => {
  const body = { plate: 'KA01HA9999', clientTagId: 'offline-queue-item-1' };
  const first = await call('/api/tags', { method: 'POST', token: bala, body });
  const retry = await call('/api/tags', { method: 'POST', token: bala, body });

  assert.equal(first.status, 201);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.replayed, true);
  assert.equal(retry.body.tag.id, first.body.tag.id);
});

test('an unreadable plate is refused rather than stored as junk', async () => {
  const response = await call('/api/tags', { method: 'POST', token: asha, body: { plate: '??' } });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'unreadable_plate');
});

test('the feed lists tags newest first and can be filtered to one member', async () => {
  const all = await call('/api/tags', { token: asha });
  assert.ok(all.body.tags.length >= 2);

  const mine = await call('/api/tags?mine=1', { token: asha });
  assert.ok(mine.body.tags.every((tag) => tag.taggedBy === 'Asha'));
});

test('stats count active tags, rank members, and report your own total', async () => {
  const response = await call('/api/stats', { token: asha });
  assert.equal(response.body.total, 2);
  assert.equal(response.body.members, 3);
  assert.equal(response.body.mine, 1, 'Asha has tagged one bike');
  assert.ok(response.body.leaderboard.some((row) => row.name === 'Asha'));

  const balaView = await call('/api/stats', { token: bala });
  assert.equal(balaView.body.mine, 1, 'each member sees their own total');
});

test('sync hands a phone every plate it needs to work offline', async () => {
  const response = await call('/api/sync', { token: asha });
  assert.equal(response.body.full, true);
  const plates = response.body.plates.map((p) => p.plate);
  assert.ok(plates.includes('MH12AB1234'));
  assert.ok(plates.includes('KA01HA9999'));
});

test('sync since a timestamp returns only what changed after it', async () => {
  const response = await call(`/api/sync?since=${encodeURIComponent(new Date().toISOString())}`, {
    token: asha,
  });
  assert.equal(response.body.full, false);
  assert.equal(response.body.plates.length, 0);
});

test('a member can undo their own tag, and the bike becomes taggable again', async () => {
  const feed = await call('/api/tags?mine=1', { token: asha });
  const ashasTag = feed.body.tags[0];

  const removed = await call(`/api/tags/${ashasTag.id}`, { method: 'DELETE', token: asha });
  assert.equal(removed.status, 200);
  assert.ok(removed.body.tag.removedAt);

  const lookup = await call('/api/plates/MH12AB1234', { token: bala });
  assert.equal(lookup.body.status, 'free');

  const retag = await call('/api/tags', {
    method: 'POST', token: bala, body: { plate: 'MH12AB1234' },
  });
  assert.equal(retag.status, 201, 'a removed tag must not block re-tagging');
  assert.equal(retag.body.tag.taggedBy, 'Bala');
});

test('any member may remove a tag another member made', async () => {
  // The club is a group of friends: fixing someone elses mistake while they are
  // not around is the common case, not an attack.
  const feed = await call('/api/tags', { token: ravi });
  const someoneElsesTag = feed.body.tags.find((tag) => tag.taggedBy !== 'Ravi');
  const response = await call(`/api/tags/${someoneElsesTag.id}`, {
    method: 'DELETE', token: ravi,
  });
  assert.equal(response.status, 200);
});

test('any member can download the export', async () => {
  const response = await call('/api/export.csv', { token: asha });
  assert.equal(response.status, 200);
  assert.match(String(response.body), /^id,plate,format,tagged_by/);
});

test('signing in again from the same device keeps one member record', async () => {
  await signIn('Asha K', 'device-asha-0001');
  const response = await call('/api/stats', { token: ravi });
  assert.equal(response.body.members, 3, 'a repeat sign-in must not create a second member');
});
