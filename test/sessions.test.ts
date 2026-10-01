import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, TOKENS, setup } from './helpers.ts';

test('the salon starts closed with no session', async () => {
  const { call } = setup();
  const r = await call('GET', '/api/v1/sessions/current');
  assert.equal(r.status, 200);
  assert.equal(r.body.session, null);
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
});

test('only the owner can open a session', async () => {
  const { call } = setup();
  const body = { title: 'x', duration_minutes: 60, limits: LIMITS };
  assert.equal((await call('POST', '/api/v1/admin/sessions', { body })).status, 401);
  const agent = await call('POST', '/api/v1/admin/sessions', { token: TOKENS.aster, body });
  assert.equal(agent.status, 403);
  assert.equal(agent.body.error.code, 'FORBIDDEN');
});

test('opening requires an explicit bounded deadline and finite limits', async () => {
  const { call } = setup();
  const open = (b: object) => call('POST', '/api/v1/admin/sessions', { token: TOKENS.owner, body: { title: 'x', ...b } });
  assert.equal((await open({ limits: LIMITS })).status, 400, 'no deadline');
  assert.equal((await open({ duration_minutes: 60 })).status, 400, 'no limits');
  assert.equal((await open({ duration_minutes: 2, limits: LIMITS })).status, 400, 'too short');
  assert.equal((await open({ duration_minutes: 9 * 60, limits: LIMITS })).status, 400, 'too long');
  assert.equal((await open({ hard_ends_at: '2026-10-01T11:00:00Z', limits: LIMITS })).status, 400, 'in the past');
  assert.equal((await open({ duration_minutes: 60, limits: { ...LIMITS, maxPosts: 1e9 } })).status, 400, 'unbounded');
  assert.equal((await open({ duration_minutes: 60, hard_ends_at: '2026-10-01T13:00:00Z', limits: LIMITS })).status, 400, 'both');
  const ok = await open({ hard_ends_at: '2026-10-01T14:00:00Z', limits: LIMITS });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.session.state, 'open');
  assert.equal(ok.body.session.hard_ends_at, '2026-10-01T14:00:00.000Z');
});

test('one open session at a time; each opening gets a new generation', async () => {
  const { call, openSession } = setup();
  const first = await openSession();
  const again = await call('POST', '/api/v1/admin/sessions', {
    token: TOKENS.owner,
    body: { title: 'y', duration_minutes: 60, limits: LIMITS },
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'SESSION_ALREADY_OPEN');
  await call('POST', `/api/v1/admin/sessions/${first.id}/close`, { token: TOKENS.owner, body: { expected_revision: first.revision } });
  const second = await openSession();
  assert.notEqual(second.id, first.id);
  assert.equal(second.generation, first.generation + 1);
});

test('close is owner-only, revision-checked, idempotent, and never reopens', async () => {
  const { call, openSession, clock } = setup();
  const s = await openSession();
  const path = `/api/v1/admin/sessions/${s.id}/close`;
  assert.equal((await call('POST', path, { token: TOKENS.aster, body: { expected_revision: 1 } })).status, 403);
  const stale = await call('POST', path, { token: TOKENS.owner, body: { expected_revision: 99 } });
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
  clock.advance(10 * 60_000);
  const closed = await call('POST', path, { token: TOKENS.owner, body: { expected_revision: 1 } });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.session.state, 'closed');
  assert.equal(closed.body.session.close_reason, 'owner');
  assert.equal(closed.body.session.closed_at, '2026-10-01T12:10:00.000Z');
  const retry = await call('POST', path, { token: TOKENS.owner, body: { expected_revision: 1 } });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.session.revision, closed.body.session.revision);
  const current = await call('GET', '/api/v1/sessions/current');
  assert.equal(current.body.session.state, 'closed');
});

test('the deadline closes a session without any scheduler', async () => {
  const { call, openSession, clock } = setup();
  const s = await openSession({ duration_minutes: 60 });
  clock.set('2026-10-01T12:59:59.999Z');
  assert.equal((await call('GET', '/api/v1/sessions/current')).body.session.state, 'open');
  clock.set('2026-10-01T13:00:00.000Z');
  const r = await call('GET', '/api/v1/sessions/current');
  assert.equal(r.body.session.state, 'closed');
  assert.equal(r.body.session.close_reason, 'deadline');
  assert.equal(r.body.session.closed_at, s.hard_ends_at);
});
