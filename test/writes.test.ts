import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, TOKENS, setup } from './helpers.ts';

test('writes need a valid, unrevoked credential', async () => {
  const { openSession, startThread, post, call } = setup();
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation);
  const anon = await call('POST', `/api/v1/threads/${thread.id}/posts`, {
    key: 'anon-key-123', body: { body: 'hi', session_id: s.id, generation: s.generation },
  });
  assert.equal(anon.status, 401);
  assert.equal((await post(thread.id, s, 'dev-agent-nobody', 'hi')).status, 401);
  assert.equal((await post(thread.id, s, 'not a token!', 'hi')).status, 401);

  const revoke = await call('POST', '/api/v1/admin/participants/p_cedar/revoke', { token: TOKENS.owner, body: { reason: 'test' } });
  assert.equal(revoke.status, 200);
  const revoked = await post(thread.id, s, TOKENS.cedar, 'hi');
  assert.equal(revoked.status, 403);
  assert.equal(revoked.body.error.code, 'REVOKED');
  assert.equal(revoked.body.error.stop, true);
  assert.equal((await call('GET', '/api/v1/me', { token: TOKENS.cedar })).status, 403);
});

test('authors cannot be spoofed: identity comes only from the credential', async () => {
  const { openSession, startThread, post } = setup();
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation);
  for (const field of ['author_id', 'author', 'created_by', 'participant_id']) {
    const r = await post(thread.id, s, TOKENS.birch, 'I am Aster', { [field]: 'p_aster' });
    assert.equal(r.status, 400, field);
  }
  const ok = await post(thread.id, s, TOKENS.birch, 'I am Birch');
  assert.equal(ok.status, 201);
  assert.equal(ok.body.post.author.id, 'p_birch');
});

test('an Idempotency-Key is required and replays never write twice', async () => {
  const { openSession, startThread, post, call, raw } = setup();
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation);
  const missing = await call('POST', `/api/v1/threads/${thread.id}/posts`, {
    token: TOKENS.birch, body: { body: 'x', session_id: s.id, generation: s.generation },
  });
  assert.equal(missing.body.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const first = await post(thread.id, s, TOKENS.birch, 'Only once.', {}, 'birch-key-0001');
  const again = await post(thread.id, s, TOKENS.birch, 'Only once.', {}, 'birch-key-0001');
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.post.id, first.body.post.id);
  const usage = raw.prepare('SELECT posts_used FROM sessions WHERE id = ?').get(s.id)!;
  assert.equal(Number(usage.posts_used), 2, 'thread opener + one post; the replay is not charged');

  const conflict = await post(thread.id, s, TOKENS.birch, 'Different text.', {}, 'birch-key-0001');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');

  // The same key from another participant is a different scope.
  const other = await post(thread.id, s, TOKENS.cedar, 'Only once.', {}, 'birch-key-0001');
  assert.equal(other.status, 201);
});

test('replay after close returns the receipt; replay after revocation is refused', async () => {
  const { openSession, startThread, post, call } = setup();
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation);
  const first = await post(thread.id, s, TOKENS.birch, 'Before closing.', {}, 'replay-key-01');
  const firstCedar = await post(thread.id, s, TOKENS.cedar, 'Cedar speaks.', {}, 'replay-key-02');
  await call('POST', `/api/v1/admin/sessions/${s.id}/close`, { token: TOKENS.owner, body: { expected_revision: s.revision } });

  const replay = await post(thread.id, s, TOKENS.birch, 'Before closing.', {}, 'replay-key-01');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.post.id, first.body.post.id);
  const fresh = await post(thread.id, s, TOKENS.birch, 'After closing.', {}, 'replay-key-03');
  assert.equal(fresh.body.error.code, 'SESSION_CLOSED');

  await call('POST', '/api/v1/admin/participants/p_cedar/revoke', { token: TOKENS.owner, body: { reason: 'test' } });
  assert.ok(firstCedar.body.post.id);
  const revokedReplay = await post(thread.id, s, TOKENS.cedar, 'Cedar speaks.', {}, 'replay-key-02');
  assert.equal(revokedReplay.status, 403);
});

test('replay after redaction does not return the removed text', async () => {
  const { openSession, startThread, post, call } = setup();
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation);
  const first = await post(thread.id, s, TOKENS.birch, 'Something to remove.', {}, 'redact-key-01');
  const mod = await call('POST', `/api/v1/admin/posts/${first.body.post.id}/moderate`, {
    token: TOKENS.owner, body: { action: 'redact', reason: 'test', expected_revision: 1 },
  });
  assert.equal(mod.status, 200);
  const replay = await post(thread.id, s, TOKENS.birch, 'Something to remove.', {}, 'redact-key-01');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.post.state, 'redacted');
  assert.equal(replay.body.post.body, null);
  assert.ok(!JSON.stringify(replay.body).includes('Something to remove'));
});

test('replies must target a visible post in the same thread, without leaking why', async () => {
  const { openSession, startThread, post, call } = setup();
  const s = await openSession();
  const a = await startThread(s.id, s.generation);
  const b = await startThread(s.id, s.generation, TOKENS.birch, 'Another thread.');
  const removed = await post(a.thread.id, s, TOKENS.birch, 'To be removed.');
  await call('POST', `/api/v1/admin/posts/${removed.body.post.id}/moderate`, {
    token: TOKENS.owner, body: { action: 'redact', reason: 'test', expected_revision: 1 },
  });
  const messages = new Set<string>();
  for (const target of ['post_doesnotexist', b.post.id, removed.body.post.id]) {
    const r = await post(a.thread.id, s, TOKENS.cedar, 'A reply.', { reply_to_post_id: target });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'INVALID_REPLY_TARGET');
    messages.add(r.body.error.message);
  }
  assert.equal(messages.size, 1, 'same message for every invalid target');
  const ok = await post(a.thread.id, s, TOKENS.cedar, 'A real reply.', { reply_to_post_id: a.post.id });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.post.reply_to_post_id, a.post.id);
});

test('stale session IDs and generations are refused', async () => {
  const { openSession, startThread, post, call } = setup();
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation);
  const wrongGen = await post(thread.id, { id: s.id, generation: s.generation + 1 }, TOKENS.birch, 'x');
  assert.equal(wrongGen.body.error.code, 'STALE_SESSION');
  const wrongSession = await post(thread.id, { id: 'ses_other', generation: s.generation }, TOKENS.birch, 'x');
  assert.equal(wrongSession.body.error.code, 'STALE_SESSION');

  // Old authority never carries into a new session.
  await call('POST', `/api/v1/admin/sessions/${s.id}/close`, { token: TOKENS.owner, body: { expected_revision: 1 } });
  const s2 = await openSession();
  const intoOld = await post(thread.id, s2, TOKENS.birch, 'x');
  assert.equal(intoOld.status, 409);
  assert.equal(intoOld.body.error.code, 'STALE_SESSION');
});

test('the deadline boundary is exact and uses server time, not client claims', async () => {
  const { openSession, startThread, post, clock, call } = setup();
  const s = await openSession({ duration_minutes: 60 });
  const { thread } = await startThread(s.id, s.generation);
  clock.set(Date.parse(s.hard_ends_at) - 1);
  assert.equal((await post(thread.id, s, TOKENS.birch, 'Just in time.')).status, 201);
  clock.set(s.hard_ends_at);
  const late = await post(thread.id, s, TOKENS.birch, 'Too late.', {}, undefined);
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'SESSION_CLOSED');
  assert.equal(late.body.error.stop, true);
  // A client-supplied clock has no effect.
  const skewed = await call('POST', `/api/v1/threads/${thread.id}/posts`, {
    token: TOKENS.birch, key: 'skewed-key-01', headers: { Date: 'Thu, 01 Oct 2026 12:00:00 GMT' },
    body: { body: 'My clock says it is early.', session_id: s.id, generation: s.generation, created_at: '2026-10-01T12:00:00Z' },
  });
  assert.equal(skewed.status, 409);
});

test('trusted time is read at final admission, not at request arrival', async () => {
  const { openSession, startThread, post, clock, hooks } = setup();
  const s = await openSession({ duration_minutes: 60 });
  const { thread } = await startThread(s.id, s.generation);
  clock.set(Date.parse(s.hard_ends_at) - 50);
  // The request arrives before the deadline, but the deadline passes while
  // it waits for the write lock.
  hooks.beforeAdmission = () => clock.advance(100);
  const r = await post(thread.id, s, TOKENS.birch, 'Started in time.');
  hooks.beforeAdmission = undefined;
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'SESSION_CLOSED');
});

test('close and post have one order: close-first rejects, post-first is kept', async () => {
  const { openSession, startThread, post, call, raw } = setup();
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation);
  const kept = await post(thread.id, s, TOKENS.birch, 'Admitted before the close.');
  assert.equal(kept.status, 201);
  await call('POST', `/api/v1/admin/sessions/${s.id}/close`, { token: TOKENS.owner, body: { expected_revision: 1 } });
  const rejected = await post(thread.id, s, TOKENS.birch, 'Arrived after the close.');
  assert.equal(rejected.body.error.code, 'SESSION_CLOSED');
  const page = await call('GET', `/api/v1/threads/${thread.id}/posts`);
  assert.deepEqual(page.body.items.map((p: { body: string }) => p.body), ['Opening thought.', 'Admitted before the close.']);
  const closeSeq = Number(raw.prepare("SELECT MAX(seq) AS s FROM changes WHERE resource_type = 'session'").get()!.s);
  const maxPostSeq = Number(raw.prepare('SELECT MAX(seq) AS s FROM posts').get()!.s);
  assert.ok(maxPostSeq < closeSeq, 'every admitted post precedes the close in committed order');
});

test('quotas: per participant, per session, threads, and body size', async () => {
  const { openSession, startThread, post } = setup();
  const s = await openSession({ limits: { maxPosts: 5, maxPostsPerParticipant: 2, maxThreads: 1, maxBodyChars: 20 } });
  const { thread } = await startThread(s.id, s.generation, TOKENS.aster, 'Hi.');
  assert.equal((await post(thread.id, s, TOKENS.birch, 'x'.repeat(21))).status, 413);
  assert.equal((await post(thread.id, s, TOKENS.birch, '建'.repeat(20))).status, 201, 'counts code points');
  assert.equal((await post(thread.id, s, TOKENS.birch, 'two')).status, 201);
  const third = await post(thread.id, s, TOKENS.birch, 'three');
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'QUOTA_EXHAUSTED');
  assert.equal(third.body.error.stop, true);
  assert.equal((await post(thread.id, s, TOKENS.cedar, 'one')).status, 201);
  assert.equal((await post(thread.id, s, TOKENS.aster, 'two')).status, 201);
  // Session budget (5) now spent: aster 2, birch 2, cedar 1.
  const over = await post(thread.id, s, TOKENS.cedar, 'two');
  assert.equal(over.status, 429);
  await assert.rejects(startThread(s.id, s.generation, TOKENS.owner, 'Another thread'), /QUOTA_EXHAUSTED/);
});

test('owner moderation still works after close and after budget exhaustion', async () => {
  const { openSession, startThread, call } = setup();
  const s = await openSession({ limits: { ...LIMITS, maxPosts: 1 } });
  const { post } = await startThread(s.id, s.generation);
  await call('POST', `/api/v1/admin/sessions/${s.id}/close`, { token: TOKENS.owner, body: { expected_revision: 1 } });
  const r = await call('POST', `/api/v1/admin/posts/${post.id}/moderate`, {
    token: TOKENS.owner, body: { action: 'redact', reason: 'after close', expected_revision: post.revision },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.post.state, 'redacted');
  const agent = await call('POST', `/api/v1/admin/posts/${post.id}/moderate`, {
    token: TOKENS.aster, body: { action: 'redact', reason: 'x', expected_revision: 2 },
  });
  assert.equal(agent.status, 403);
});

test('agents cannot edit or delete posts: there is no such route', async () => {
  const { openSession, startThread, call } = setup();
  const s = await openSession();
  const { post } = await startThread(s.id, s.generation);
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const r = await call(method, `/api/v1/posts/${post.id}`, { token: TOKENS.aster, body: { body: 'edited' } });
    assert.equal(r.status, 404, method);
  }
});

test('oversized requests and non-JSON bodies are rejected', async () => {
  const { openSession, startThread, call } = setup();
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation);
  const huge = await call('POST', `/api/v1/threads/${thread.id}/posts`, {
    token: TOKENS.birch, key: 'huge-key-0001', body: { body: 'x'.repeat(70 * 1024), session_id: s.id, generation: 1 },
  });
  assert.equal(huge.status, 413);
  const res = await call('POST', `/api/v1/threads/${thread.id}/posts`, {
    token: TOKENS.birch, key: 'text-key-0001', headers: { 'Content-Type': 'text/plain' },
  });
  assert.equal(res.status, 400);
});
