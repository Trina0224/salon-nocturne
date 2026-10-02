// Write admission on D1 (local workerd), exercising the guarded batch design:
// ordering, concurrent last-quota writers, concurrent identical retries,
// rollback without partial writes, deadline at final admission, replays.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, systemClock } from '../../src/infra/clock.ts';
import { ApiError } from '../../src/domain/errors.ts';
import type { Actor } from '../../src/domain/model.ts';
import { d1Salon, OWNER_TOKEN, cleanupTemplate, wrangler } from './harness.ts';

after(cleanupTemplate);

const T0 = '2026-10-01T12:00:00.000Z';
const LIMITS = { maxPosts: 50, maxPostsPerParticipant: 50, maxThreads: 5, maxBodyChars: 500 };

async function world(opts: { clock?: FakeClock | typeof systemClock; writesPerMinute?: number; agents?: number; limits?: typeof LIMITS } = {}) {
  const hooks: { beforeAdmission?: () => void | Promise<void> } = {};
  const s = await d1Salon({ clock: opts.clock ?? new FakeClock(T0), hooks, writesPerMinute: opts.writesPerMinute });
  const ownerRes = await s.auth.resolve(OWNER_TOKEN);
  if (ownerRes.kind !== 'ok') throw new Error('owner did not resolve');
  const owner = ownerRes.actor;
  const agents: { actor: Actor; token: string; id: string }[] = [];
  for (let i = 0; i < (opts.agents ?? 3); i++) {
    const issued = await s.ledger.createParticipant(owner, { display_name: `Agent ${i}` });
    const r = await s.auth.resolve(issued.credential.token);
    if (r.kind !== 'ok') throw new Error('agent did not resolve');
    agents.push({ actor: r.actor, token: issued.credential.token, id: issued.participant.id });
  }
  const session = await s.ledger.openSession(owner, { title: 'D1 session', duration_minutes: 60, limits: opts.limits ?? LIMITS });
  const opener = await s.ledger.createThread(owner, session.id, { title: 'Thread', tags: ['建築'], body: 'Opening.', generation: session.generation }, 'opener-key-1');
  const count = async (sql: string, ...p: (string | number)[]) => Number((await s.db.first(sql, ...p))!.n);
  const post = (who: number | Actor, body: string, key: string, extra: Record<string, unknown> = {}) =>
    s.ledger.createPost(typeof who === 'number' ? agents[who]!.actor : who, opener.value.thread.id,
      { body, session_id: session.id, generation: session.generation, ...extra }, key);
  return { s, hooks, owner, agents, session, threadId: opener.value.thread.id, openerId: opener.value.post.id, count, post };
}

const settle = async <T>(p: Promise<T>) => {
  try {
    return { ok: true as const, value: await p };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false as const, code: err.code, status: err.status };
    throw err;
  }
};

test('D1: migrations apply with the Wrangler CLI and are idempotent', async () => {
  const { s, count } = await world();
  try {
    for (const table of ['sessions', 'posts', 'changes', 'write_receipts', 'admissions', 'credentials', 'post_search']) {
      assert.equal(await count(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?`, table), 1, table);
    }
    assert.equal(await count('SELECT COUNT(*) AS n FROM d1_migrations'), 2);
    assert.equal(await count('SELECT COUNT(*) AS n FROM admissions'), 0, 'guard rows never persist');
  } finally {
    await s.dispose();
  }
  const out = wrangler(['d1', 'migrations', 'list', 'DB', '--local', '--persist-to', (await import('./harness.ts')).migratedState()]);
  assert.match(out, /No migrations to apply/);
});

test('D1: close and post have one committed order', async () => {
  const { s, owner, session, post, count } = await world();
  try {
    assert.equal((await post(0, 'Before the close.', 'order-key-1')).status, 201);
    await s.ledger.closeSession(owner, session.id, { expected_revision: 1 });
    const late = await settle(post(1, 'After the close.', 'order-key-2'));
    assert.deepEqual(late, { ok: false, code: 'SESSION_CLOSED', status: 409 });
    const closeSeq = await count(`SELECT MAX(seq) AS n FROM changes WHERE resource_type = 'session'`);
    assert.ok((await count('SELECT MAX(seq) AS n FROM posts')) < closeSeq);
  } finally {
    await s.dispose();
  }
});

test('D1: concurrent writers spend the last quota unit exactly once, and a racing close wins cleanly', async () => {
  const { s, session, post, count, owner } = await world({ limits: { ...LIMITS, maxPosts: 2 } });
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => settle(post(i % 3, `Contender ${i}`, `last-unit-${i}-key`))));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok && r.code === 'QUOTA_EXHAUSTED').length, 7);
    assert.equal(await count('SELECT posts_used AS n FROM sessions WHERE id = ?', session.id), 2);
    assert.equal(await count('SELECT COUNT(*) AS n FROM posts'), 2);
    assert.equal(await count('SELECT COUNT(*) AS n FROM write_receipts'), 2);
    assert.equal(await count(`SELECT COUNT(*) AS n FROM changes WHERE resource_type = 'post'`), 2);
    // Concurrent closes: one commits, the other is an idempotent no-op.
    const closes = await Promise.all([1, 2].map(() => s.ledger.closeSession(owner, session.id, { expected_revision: 1 })));
    assert.deepEqual(closes.map((c) => c.value.state), ['closed', 'closed']);
    assert.equal(await count(`SELECT COUNT(*) AS n FROM changes WHERE resource_type = 'session' AND revision = 2`), 1);
  } finally {
    await s.dispose();
  }
});

test('D1: concurrent identical retries write and charge once', async () => {
  const { s, session, post, count } = await world();
  try {
    const before = await count('SELECT posts_used AS n FROM sessions WHERE id = ?', session.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => post(1, 'Sent six times at once.', 'same-key-0001')));
    assert.equal(new Set(results.map((r) => r.value.id)).size, 1);
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(await count('SELECT posts_used AS n FROM sessions WHERE id = ?', session.id), before + 1);
    assert.equal(await count(`SELECT COUNT(*) AS n FROM posts WHERE body = 'Sent six times at once.'`), 1);
    assert.equal(await count(`SELECT COUNT(*) AS n FROM write_receipts WHERE idempotency_key = 'same-key-0001'`), 1);
    const conflict = await settle(post(1, 'Different payload.', 'same-key-0001'));
    assert.deepEqual(conflict, { ok: false, code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  } finally {
    await s.dispose();
  }
});

test('D1: a failing statement after the guard rolls back every write', async () => {
  const { s, session, post, count } = await world();
  try {
    const snapshot = async () => [
      await count('SELECT posts_used AS n FROM sessions WHERE id = ?', session.id),
      await count('SELECT COALESCE(SUM(posts_used), 0) AS n FROM participant_usage'),
      await count('SELECT COUNT(*) AS n FROM changes'),
      await count('SELECT COUNT(*) AS n FROM posts'),
      await count('SELECT COUNT(*) AS n FROM write_receipts'),
      await count('SELECT COUNT(*) AS n FROM admissions'),
    ];
    const before = await snapshot();
    // Occupy the search rowid the next post will need, so the batch fails late.
    const nextSeq = (await count('SELECT MAX(seq) AS n FROM changes')) + 1;
    await s.db.run(`INSERT INTO post_search (rowid, post_id, thread_title, body, tags) VALUES (?, 'x', 'x', 'x', '')`, nextSeq);
    await assert.rejects(post(0, 'Doomed by a late failure.', 'rollback-key-1'), /UNIQUE|constraint/i);
    assert.deepEqual(await snapshot(), before, 'counters, events, content, receipts, and guard rows unchanged');
    // A guard rejection is equally clean.
    const tooBig = await settle(post(0, 'x'.repeat(501), 'rollback-key-2'));
    assert.equal(tooBig.ok, false);
    assert.deepEqual(await snapshot(), before);
  } finally {
    await s.dispose();
  }
});

test('D1: the deadline is checked when the batch executes, not when the request arrived', async () => {
  const { s, hooks, owner, agents, count } = await world({ clock: systemClock });
  try {
    // A session whose deadline is ~1.5 s away (seeded directly; the API requires ≥ 5 min).
    const open = (await s.db.first(`SELECT id FROM sessions WHERE state = 'open'`))!;
    await s.ledger.closeSession(owner, String(open.id), { expected_revision: 1 });
    const endsAt = new Date(Date.now() + 1500).toISOString();
    await s.db.run(
      `INSERT INTO sessions (id, generation, title, description, state, opened_at, hard_ends_at, revision, max_posts,
         max_posts_per_participant, max_threads, max_body_chars, opened_by)
       VALUES ('ses_short', 99, 'Short', '', 'open', ?, ?, 1, 10, 10, 5, 500, 'p_host')`,
      new Date().toISOString(), endsAt,
    );
    const thread = async (key: string) =>
      s.ledger.createThread(agents[0]!.actor, 'ses_short', { title: 'T', tags: [], body: 'B', generation: 99 }, key);
    assert.equal((await thread('deadline-key-1')).status, 201, 'admitted before the deadline');
    hooks.beforeAdmission = () => new Promise((r) => setTimeout(r, 2000));
    const delayed = await settle(thread('deadline-key-2'));
    hooks.beforeAdmission = undefined;
    assert.deepEqual(delayed, { ok: false, code: 'SESSION_CLOSED', status: 409 });
    assert.equal(await count(`SELECT COUNT(*) AS n FROM threads WHERE session_id = 'ses_short'`), 1);
  } finally {
    await s.dispose();
  }
});

test('D1: replays recheck access, survive close and redaction, and never move sessions', async () => {
  const { s, owner, agents, session, post, count, threadId } = await world();
  try {
    const first = await post(1, 'Replay me.', 'replay-key-01');
    await s.ledger.moderatePost(owner, first.value.id, { action: 'redact', reason: 'test', expected_revision: 1 });
    await s.ledger.closeSession(owner, session.id, { expected_revision: 1 });
    const b = await s.ledger.openSession(owner, { title: 'Session B', duration_minutes: 60, limits: LIMITS });
    const replay = await post(1, 'Replay me.', 'replay-key-01');
    assert.equal(replay.status, 200);
    assert.equal(replay.value.id, first.value.id);
    assert.equal(replay.value.session_id, session.id);
    assert.equal(replay.value.body, null, 'removed text is never replayed');
    assert.equal(await count('SELECT COUNT(*) AS n FROM posts WHERE session_id = ?', b.id), 0);
    // A different key into the old thread is refused: closed, and not session B.
    const stale = await settle(s.ledger.createPost(agents[1]!.actor, threadId, { body: 'x', session_id: b.id, generation: b.generation }, 'replay-key-02'));
    assert.equal(stale.ok, false);
    await s.ledger.revokeParticipant(owner, agents[1]!.id, { reason: 'test' });
    assert.deepEqual(await settle(post(1, 'Replay me.', 'replay-key-01')), { ok: false, code: 'REVOKED', status: 403 });
  } finally {
    await s.dispose();
  }
});

test('D1: revocation is rechecked inside the admission batch', async () => {
  const { s, owner, agents, post } = await world();
  try {
    // The actor was resolved before revocation; the guard still refuses it.
    const actor = agents[2]!.actor;
    await s.ledger.revokeParticipant(owner, agents[2]!.id, { reason: 'test' });
    const r = await settle(s.ledger.createPost(actor, (await s.db.first('SELECT id FROM threads'))!.id as string,
      { body: 'x', session_id: (await s.db.first(`SELECT id FROM sessions`))!.id as string, generation: 1 }, 'revoked-key-1'));
    assert.deepEqual(r, { ok: false, code: 'REVOKED', status: 403 });
    void post;
  } finally {
    await s.dispose();
  }
});

test('D1: write rate is enforced at admission', async () => {
  const { s, post } = await world({ writesPerMinute: 3 });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await post(0, `Post ${i}`, `rate-key-${i}-xx`)).status, 201);
    assert.deepEqual(await settle(post(0, 'One too many.', 'rate-key-3-xx')), { ok: false, code: 'RATE_LIMITED', status: 429 });
    assert.equal((await post(1, 'Another participant.', 'rate-key-4-xx')).status, 201);
  } finally {
    await s.dispose();
  }
});

test('D1: English and CJK search, including two-character queries', async () => {
  const { s, agents, session } = await world();
  try {
    const zh = await s.ledger.createThread(agents[0]!.actor, session.id,
      { title: '光與空間', tags: ['physics'], body: '光線讓建築與物理在同一個房間裡對話。', generation: session.generation }, 'search-key-1');
    const en = await s.ledger.createThread(agents[1]!.actor, session.id,
      { title: 'A better room', tags: ['architecture'], body: 'Could a better world begin with a better room?', generation: session.generation }, 'search-key-2');
    const ids = async (q: string) => (await s.reads.search(q, undefined, 50)).items.map((h) => h.post_id);
    assert.deepEqual(await ids('better room'), [en.value.post.id]);
    assert.deepEqual(await ids('建築與物理'), [zh.value.post.id]);
    assert.ok((await ids('建築')).includes(zh.value.post.id));
    assert.deepEqual(await ids('物理'), [zh.value.post.id]);
    assert.deepEqual(await ids('ARCHITECTURE'), [en.value.post.id]);
  } finally {
    await s.dispose();
  }
});

test('D1: UTF-8 byte cap holds with maximal CJK posts and pagination stays gap-free', async () => {
  const { s, owner, session, threadId, openerId } = await world({ limits: { maxPosts: 200, maxPostsPerParticipant: 200, maxThreads: 5, maxBodyChars: 4000 } });
  try {
    const ids = [openerId];
    for (let i = 0; i < 40; i++) {
      const r = await s.ledger.createPost(owner, threadId, { body: `${i} ${'建'.repeat(3990)}`, session_id: session.id, generation: session.generation }, `big-key-${i}-xx`);
      ids.push(r.value.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = await s.reads.threadPosts(threadId, { cursor, limit: 100 });
      const bytes = new TextEncoder().encode(JSON.stringify({ schema_version: 1, ...page })).length;
      assert.ok(bytes <= 262_144, `page ${pages} is ${bytes} bytes`);
      seen.push(...page.items.map((p) => p.id));
      pages++;
      if (!page.has_more) break;
      cursor = page.next_cursor!;
    }
    assert.ok(pages > 1);
    assert.deepEqual(seen, ids);
  } finally {
    await s.dispose();
  }
});
