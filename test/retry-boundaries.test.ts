// Concurrent identical retries at quota, rate, close, and deadline
// boundaries (PR #3 review). Both requests pass the early receipt lookup
// before either batch runs; the loser must get the winner's result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOKENS, setup } from './helpers.ts';

/** Hook that holds callers until `n` have arrived, then releases them together. */
function barrier(n: number) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return async () => {
    if (++arrived >= n) release();
    await gate;
  };
}

/**
 * Hook for two callers: waits until both have passed their early receipt
 * lookup and reached admission, lets the first through, and holds the
 * second until `go()`. The test changes state in between.
 */
function sequencer() {
  let arrived = 0;
  let bothIn!: () => void;
  const both = new Promise<void>((r) => (bothIn = r));
  let go!: () => void;
  const gate = new Promise<void>((r) => (go = r));
  return {
    hook: async () => {
      const me = ++arrived;
      if (arrived === 2) bothIn();
      await both;
      if (me === 2) await gate;
    },
    go,
    arrived: () => arrived,
  };
}

/**
 * Either request may reach admission first, whatever order they were sent
 * in. Returns the result of the one that finished (the one the sequencer let
 * through) and the one still held.
 */
async function firstThenHeld<T>(a: Promise<T>, b: Promise<T>): Promise<[T, Promise<T>]> {
  const done = await Promise.race([a.then((v) => ({ v, held: b })), b.then((v) => ({ v, held: a }))]);
  return [done.v, done.held];
}

const limits = (over: Record<string, number>) => ({ maxPosts: 20, maxPostsPerParticipant: 10, maxThreads: 5, maxBodyChars: 500, ...over });

async function twoIdenticalPosts(opts: { limits?: Record<string, number>; writesPerMinute?: number }) {
  const ctx = setup({ writesPerMinute: opts.writesPerMinute });
  const s = await ctx.openSession({ limits: limits(opts.limits ?? {}) });
  const { thread } = await ctx.startThread(s.id, s.generation, TOKENS.owner);
  ctx.hooks.beforeAdmission = barrier(2);
  const [a, b] = await Promise.all([
    ctx.post(thread.id, s, TOKENS.birch, 'Sent twice at once.', {}, 'dup-key-0001'),
    ctx.post(thread.id, s, TOKENS.birch, 'Sent twice at once.', {}, 'dup-key-0001'),
  ]);
  ctx.hooks.beforeAdmission = undefined;
  return { ctx, s, a, b };
}

function assertOneWriteTwoAnswers(r: Awaited<ReturnType<typeof twoIdenticalPosts>>) {
  assert.deepEqual([r.a.status, r.b.status].sort(), [200, 201], JSON.stringify([r.a.body, r.b.body]));
  assert.equal(r.a.body.post.id, r.b.body.post.id);
  assert.equal(Number(r.ctx.raw.prepare(`SELECT COUNT(*) AS n FROM posts WHERE body = 'Sent twice at once.'`).get()!.n), 1);
  assert.equal(Number(r.ctx.raw.prepare(`SELECT COUNT(*) AS n FROM write_receipts WHERE idempotency_key = 'dup-key-0001'`).get()!.n), 1);
}

test('identical retries at the last session post unit: 201 and 200, same post', async () => {
  const r = await twoIdenticalPosts({ limits: { maxPosts: 2 } });
  assertOneWriteTwoAnswers(r);
  assert.equal(Number(r.ctx.raw.prepare('SELECT posts_used AS n FROM sessions').get()!.n), 2);
});

test('identical retries at the last participant post unit', async () => {
  assertOneWriteTwoAnswers(await twoIdenticalPosts({ limits: { maxPostsPerParticipant: 1 } }));
});

test('identical retries at the write-rate boundary', async () => {
  assertOneWriteTwoAnswers(await twoIdenticalPosts({ writesPerMinute: 1 }));
});

test('identical thread creation at the last thread unit', async () => {
  const ctx = setup();
  const s = await ctx.openSession({ limits: limits({ maxThreads: 1 }) });
  ctx.hooks.beforeAdmission = barrier(2);
  const body = { title: 'Only one', tags: [], body: 'Opening.', generation: s.generation };
  const [a, b] = await Promise.all([1, 2].map(() => ctx.call('POST', `/api/v1/sessions/${s.id}/threads`, { token: TOKENS.aster, key: 'dup-thread-01', body })));
  assert.deepEqual([a!.status, b!.status].sort(), [200, 201]);
  assert.equal(a!.body.thread.id, b!.body.thread.id);
  assert.equal(Number(ctx.raw.prepare('SELECT COUNT(*) AS n FROM threads').get()!.n), 1);
  assert.equal(Number(ctx.raw.prepare('SELECT threads_used AS n FROM sessions').get()!.n), 1);
});

test('a retry that reaches admission after a close or the deadline replays the committed post', async () => {
  for (const boundary of ['close', 'deadline'] as const) {
    const ctx = setup();
    const s = await ctx.openSession({ duration_minutes: 30 });
    const { thread } = await ctx.startThread(s.id, s.generation, TOKENS.owner);
    const seq = sequencer();
    ctx.hooks.beforeAdmission = seq.hook;
    const [a, second] = await firstThenHeld(
      ctx.post(thread.id, s, TOKENS.birch, 'Before the boundary.', {}, `boundary-${boundary}-1`),
      ctx.post(thread.id, s, TOKENS.birch, 'Before the boundary.', {}, `boundary-${boundary}-1`),
    );
    assert.equal(seq.arrived(), 2, 'both requests reached admission');
    if (boundary === 'close') await ctx.call('POST', `/api/v1/admin/sessions/${s.id}/close`, { token: TOKENS.owner, body: { expected_revision: 1 } });
    else ctx.clock.advance(31 * 60_000);
    seq.go();
    const b = await second;
    assert.equal(a.status, 201, boundary);
    assert.equal(b.status, 200, boundary);
    assert.equal(b.body.post.id, a.body.post.id);
    // A different key still sees the boundary.
    ctx.hooks.beforeAdmission = undefined;
    const fresh = await ctx.post(thread.id, s, TOKENS.birch, 'After the boundary.', {}, `boundary-${boundary}-2`);
    assert.equal(fresh.body.error.code, 'SESSION_CLOSED');
  }
});

test('a concurrent retry never replays past revocation, and never returns removed text', async () => {
  const ctx = setup();
  const s = await ctx.openSession();
  const { thread } = await ctx.startThread(s.id, s.generation, TOKENS.owner);

  const seq = sequencer();
  ctx.hooks.beforeAdmission = seq.hook;
  const [first, second] = await firstThenHeld(
    ctx.post(thread.id, s, TOKENS.cedar, 'Cedar speaks.', {}, 'revoke-race-1'),
    ctx.post(thread.id, s, TOKENS.cedar, 'Cedar speaks.', {}, 'revoke-race-1'),
  );
  assert.equal(first.status, 201);
  assert.equal(seq.arrived(), 2);
  await ctx.call('POST', '/api/v1/admin/participants/p_cedar/revoke', { token: TOKENS.owner, body: { reason: 'test' } });
  seq.go();
  const revoked = await second;
  assert.equal(revoked.status, 403);
  assert.equal(revoked.body.error.code, 'REVOKED');

  const seq2 = sequencer();
  ctx.hooks.beforeAdmission = seq2.hook;
  const [a, p2] = await firstThenHeld(
    ctx.post(thread.id, s, TOKENS.birch, 'Soon removed.', {}, 'redact-race-1'),
    ctx.post(thread.id, s, TOKENS.birch, 'Soon removed.', {}, 'redact-race-1'),
  );
  assert.equal(seq2.arrived(), 2);
  await ctx.call('POST', `/api/v1/admin/posts/${a.body.post.id}/moderate`, { token: TOKENS.owner, body: { action: 'redact', reason: 'x', expected_revision: 1 } });
  seq2.go();
  const b = await p2;
  assert.equal(b.status, 200);
  assert.equal(b.body.post.id, a.body.post.id);
  assert.equal(b.body.post.body, null);
  assert.ok(!JSON.stringify(b.body).includes('Soon removed'));
});

test('a concurrent request reusing the key with a different payload gets a conflict, not a quota error', async () => {
  const ctx = setup();
  const s = await ctx.openSession({ limits: limits({ maxPosts: 2 }) });
  const { thread } = await ctx.startThread(s.id, s.generation, TOKENS.owner);
  ctx.hooks.beforeAdmission = barrier(2);
  const [a, b] = await Promise.all([
    ctx.post(thread.id, s, TOKENS.birch, 'Version one.', {}, 'conflict-key-1'),
    ctx.post(thread.id, s, TOKENS.birch, 'Version two.', {}, 'conflict-key-1'),
  ]);
  const codes = [a, b].map((r) => (r.status === 201 ? 'created' : r.body.error.code)).sort();
  assert.deepEqual(codes, ['IDEMPOTENCY_CONFLICT', 'created']);
});
