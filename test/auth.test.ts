// Authentication, configuration, credential lifecycle, and resource limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TOKENS, setup } from './helpers.ts';
import { workerConfig, LOCAL_PEPPER } from '../src/config.ts';

const limiter = { limit: async () => ({ success: true }) };
const goodHash = createHash('sha256').update('an-owner-token-for-config-tests').digest('hex');
const goodPepper = createHash('sha256').update('a-pepper-for-config-tests').digest('hex');

test('Worker config fails closed on missing or insecure settings, without echoing secrets', () => {
  const missing = workerConfig({});
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.problems.length, 4);

  const cases: [string, Record<string, unknown>][] = [
    ['no limiter', { DB: {}, OWNER_TOKEN_SHA256: goodHash, TOKEN_PEPPER: goodPepper }],
    ['bad hash', { DB: {}, READ_LIMITER: limiter, OWNER_TOKEN_SHA256: 'not-a-hash', TOKEN_PEPPER: goodPepper }],
    ['short pepper', { DB: {}, READ_LIMITER: limiter, OWNER_TOKEN_SHA256: goodHash, TOKEN_PEPPER: 'short' }],
    ['local pepper', { DB: {}, READ_LIMITER: limiter, OWNER_TOKEN_SHA256: goodHash, TOKEN_PEPPER: LOCAL_PEPPER }],
    ['placeholder', { DB: {}, READ_LIMITER: limiter, OWNER_TOKEN_SHA256: goodHash, TOKEN_PEPPER: '<at least 32 random characters, placeholder>' }],
    ['bad limit', { DB: {}, READ_LIMITER: limiter, OWNER_TOKEN_SHA256: goodHash, TOKEN_PEPPER: goodPepper, WRITES_PER_MINUTE: '100000' }],
  ];
  for (const [name, env] of cases) {
    const r = workerConfig(env);
    assert.equal(r.ok, false, name);
    if (!r.ok) for (const p of r.problems) assert.ok(!p.includes(goodPepper) && !p.includes(goodHash), `${name} leaks a value`);
  }

  const ok = workerConfig({ DB: {}, READ_LIMITER: limiter, OWNER_TOKEN_SHA256: `${goodHash}, ${goodHash.toUpperCase()}`, TOKEN_PEPPER: goodPepper });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.config.ownerTokenHashes, [goodHash, goodHash]);
    assert.equal(ok.config.writesPerMinute, 10);
  }
});

test('the owner enrolls, rotates, and revokes agent credentials; tokens are shown once', async () => {
  const { call, openSession, startThread } = setup();
  const created = await call('POST', '/api/v1/admin/participants', { token: TOKENS.owner, body: { display_name: 'Dahlia' } });
  assert.equal(created.status, 201);
  const token = created.body.credential.token as string;
  assert.match(token, /^sna_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(created.body.credential.scopes, ['read', 'post']);
  const pid = created.body.participant.id as string;

  const me = await call('GET', '/api/v1/me', { token });
  assert.equal(me.body.participant.id, pid);
  assert.equal(me.body.participant.role, 'agent');

  const listed = JSON.stringify((await call('GET', '/api/v1/admin/participants', { token: TOKENS.owner })).body);
  assert.ok(listed.includes(pid));
  assert.ok(!listed.includes(token) && !listed.includes('token_digest'));

  // Least privilege: agents have no admin routes.
  for (const [method, path, body] of [
    ['GET', '/api/v1/admin/participants', undefined],
    ['POST', '/api/v1/admin/participants', { display_name: 'x' }],
    ['POST', `/api/v1/admin/participants/${pid}/credentials`, {}],
    ['POST', '/api/v1/admin/sessions', { title: 'x', duration_minutes: 60 }],
  ] as const) {
    assert.equal((await call(method, path, { token, body })).status, 403, path);
  }

  // The agent writes as itself.
  const s = await openSession();
  const r = await call('POST', `/api/v1/sessions/${s.id}/threads`, { token, key: 'dahlia-key-01', body: { title: 'T', body: 'Hello.', generation: s.generation } });
  assert.equal(r.body.post.author.id, pid);

  // Rotation without revocation keeps both; with revoke_others only the new one works.
  const second = await call('POST', `/api/v1/admin/participants/${pid}/credentials`, { token: TOKENS.owner, body: {} });
  assert.equal((await call('GET', '/api/v1/me', { token })).status, 200);
  assert.equal((await call('GET', '/api/v1/me', { token: second.body.credential.token })).status, 200);
  const third = await call('POST', `/api/v1/admin/participants/${pid}/credentials`, { token: TOKENS.owner, body: { revoke_others: true } });
  assert.equal((await call('GET', '/api/v1/me', { token })).status, 403);
  assert.equal((await call('GET', '/api/v1/me', { token: second.body.credential.token })).status, 403);
  assert.equal((await call('GET', '/api/v1/me', { token: third.body.credential.token })).status, 200);

  // Revoking a single credential, idempotently.
  const rev = await call('POST', `/api/v1/admin/credentials/${third.body.credential.id}/revoke`, { token: TOKENS.owner, body: {} });
  assert.equal(rev.status, 200);
  assert.equal((await call('POST', `/api/v1/admin/credentials/${third.body.credential.id}/revoke`, { token: TOKENS.owner, body: {} })).status, 200);
  assert.equal((await call('GET', '/api/v1/me', { token: third.body.credential.token })).status, 403);

  // A revoked participant cannot be given new credentials, and the owner cannot be targeted.
  await call('POST', `/api/v1/admin/participants/${pid}/revoke`, { token: TOKENS.owner, body: { reason: 'test' } });
  assert.equal((await call('POST', `/api/v1/admin/participants/${pid}/credentials`, { token: TOKENS.owner, body: {} })).status, 409);
  assert.equal((await call('POST', '/api/v1/admin/participants/p_host/credentials', { token: TOKENS.owner, body: {} })).status, 400);
  assert.equal((await call('POST', '/api/v1/admin/participants/p_host/revoke', { token: TOKENS.owner, body: { reason: 'x' } })).status, 400);
  void startThread;
});

test('stored credentials can never carry the owner role', async () => {
  const { call, raw, salon } = setup();
  await salon.ready;
  const digest = await salon.auth.credentialDigest('sna_stored-owner-token-attempt-000000000000000');
  raw.prepare(`INSERT INTO credentials (id, participant_id, token_digest, scopes, label, created_at)
               VALUES ('cred_evil', 'p_host', ?, '["read","post","admin"]', 'x', '2026-10-01T00:00:00.000Z')`).run(digest);
  const r = await call('GET', '/api/v1/admin/participants', { token: 'sna_stored-owner-token-attempt-000000000000000' });
  assert.equal(r.status, 401);
});

test('exports are bounded by bytes', async () => {
  const { openSession, startThread, post, call } = setup({ exportByteCap: 64 * 1024 });
  const s = await openSession({ limits: { maxPosts: 100, maxPostsPerParticipant: 100, maxThreads: 5, maxBodyChars: 4000 } });
  const { thread } = await startThread(s.id, s.generation, TOKENS.aster, '建'.repeat(4000));
  for (let i = 0; i < 5; i++) await post(thread.id, s, TOKENS.birch, '築'.repeat(4000));
  const r = await call('GET', `/api/v1/sessions/${s.id}/export`);
  assert.equal(r.status, 413);
  assert.equal(r.body.error.code, 'TOO_LARGE');
  assert.equal((await call('GET', `/api/v1/sessions/${s.id}/export?format=md`)).status, 413);
});

test('read rate limit applies per participant and per client, never to the owner', async () => {
  const { call } = setup({ readsPerMinute: 5 });
  for (let i = 0; i < 5; i++) assert.equal((await call('GET', '/api/v1/sessions/current')).status, 200);
  const limited = await call('GET', '/api/v1/sessions/current');
  assert.equal(limited.status, 429);
  assert.equal(limited.res.headers.get('retry-after'), '60');
  assert.equal((await call('GET', '/api/v1/me', { token: TOKENS.aster })).status, 200, 'a participant has its own budget');
  for (let i = 0; i < 10; i++) assert.equal((await call('GET', '/api/v1/sessions/current', { token: TOKENS.owner })).status, 200);
});

test('write rate limit applies at admission', async () => {
  const { openSession, startThread, post } = setup({ writesPerMinute: 2 });
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation, TOKENS.owner);
  assert.equal((await post(thread.id, s, TOKENS.birch, 'one')).status, 201);
  assert.equal((await post(thread.id, s, TOKENS.birch, 'two')).status, 201);
  const third = await post(thread.id, s, TOKENS.birch, 'three');
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'RATE_LIMITED');
  assert.equal(third.body.error.stop, false);
});
