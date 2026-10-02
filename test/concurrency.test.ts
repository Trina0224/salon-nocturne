// Real concurrent writers: separate worker threads, each with its own SQLite
// connection to one database file. These prove the local adapter's
// serialization only; they say nothing about D1 or Durable Objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemClock } from '../src/infra/clock.ts';
import { createSalon } from '../src/context.ts';
import { seedIdentities, resolveToken } from '../src/store/identities.ts';
import { FIXTURES, TOKENS } from './helpers.ts';
import type { Job, Outcome } from './workers/admit-worker.ts';

function fileSalon(limits: { maxPosts: number; maxPostsPerParticipant: number; maxThreads: number; maxBodyChars: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'salon-race-'));
  const dbPath = join(dir, 'race.db');
  const salon = createSalon({ dbPath, clock: systemClock });
  seedIdentities(salon.db, FIXTURES, new Date().toISOString());
  const owner = resolveToken(salon.db, TOKENS.owner);
  if (owner.kind !== 'ok') throw new Error('owner fixture missing');
  const session = salon.ledger.openSession(owner.actor, { title: 'Race', duration_minutes: 60, limits });
  const opener = salon.ledger.createThread(owner.actor, session.id,
    { title: 'Race thread', tags: [], body: 'Opening.', generation: session.generation }, 'race-opener-1');
  return { dir, dbPath, salon, session, threadId: opener.value.thread.id };
}

async function race(dbPath: string, jobLists: Job[][]): Promise<Outcome[]> {
  const gate = new SharedArrayBuffer(4);
  const workers = jobLists.map((jobs) => new Worker(new URL('./workers/admit-worker.ts', import.meta.url), { workerData: { dbPath, gate, jobs } }));
  const done = workers.map((w) => new Promise<Outcome[]>((resolve, reject) => {
    w.once('message', resolve);
    w.once('error', reject);
  }));
  await new Promise((r) => setTimeout(r, 300)); // let every worker reach the gate
  const flag = new Int32Array(gate);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
  return (await Promise.all(done)).flat();
}

const agents = [TOKENS.aster, TOKENS.birch, TOKENS.cedar];

test('concurrent writers spend the last quota unit exactly once', async () => {
  // The opener used 1 of 2 posts, leaving exactly one unit.
  const { dir, dbPath, salon, session, threadId } = fileSalon({ maxPosts: 2, maxPostsPerParticipant: 5, maxThreads: 2, maxBodyChars: 200 });
  try {
    const jobs: Job[][] = Array.from({ length: 8 }, (_, i) => [{
      kind: 'post', token: agents[i % 3]!, threadId, sessionId: session.id, generation: session.generation,
      key: `last-unit-${i}-key`, body: `Contender ${i}`,
    }]);
    const outcomes = await race(dbPath, jobs);
    assert.equal(outcomes.filter((o) => o.status === 201).length, 1);
    assert.equal(outcomes.filter((o) => o.code === 'QUOTA_EXHAUSTED').length, 7);
    const row = salon.db.prepare('SELECT posts_used, (SELECT COUNT(*) FROM posts) AS n FROM sessions').get()!;
    assert.equal(Number(row.posts_used), 2);
    assert.equal(Number(row.n), 2);
  } finally {
    salon.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a close racing many posts has one committed order', async () => {
  const { dir, dbPath, salon, session, threadId } = fileSalon({ maxPosts: 2000, maxPostsPerParticipant: 500, maxThreads: 2, maxBodyChars: 200 });
  try {
    // Each poster keeps posting until it is refused, pausing 1 ms between
    // posts so the closer can take the write lock (SQLite locking is not
    // fair). The close therefore always lands mid-race.
    const posters: Job[][] = Array.from({ length: 5 }, (_, w) => [{
      kind: 'post-until-refused' as const, token: agents[w % 3]!, threadId, sessionId: session.id, generation: session.generation,
      keyPrefix: `race-${w}`, max: 390, pauseMs: 1,
    }]);
    const closer: Job[] = [{ kind: 'close', token: TOKENS.owner, sessionId: session.id, afterPosts: 30 }];
    const outcomes = await race(dbPath, [...posters, closer]);

    const posts = outcomes.filter((o) => o.kind === 'post');
    const admitted = posts.filter((o) => o.status === 201).length;
    const refused = posts.filter((o) => o.code === 'SESSION_CLOSED').length;
    assert.equal(admitted + refused, posts.length, 'every post was either admitted or refused as closed');
    assert.equal(refused, 5, 'every poster was stopped by the close, none ran out of attempts');
    assert.ok(admitted >= 29, `the close waited for the race to start (admitted ${admitted})`);
    assert.deepEqual(outcomes.filter((o) => o.kind === 'close').map((o) => o.status), [200]);

    const closeSeq = Number(salon.db.prepare("SELECT MAX(seq) AS s FROM changes WHERE resource_type = 'session'").get()!.s);
    const lastPostSeq = Number(salon.db.prepare('SELECT MAX(seq) AS s FROM posts').get()!.s);
    const closedAt = String(salon.db.prepare('SELECT closed_at FROM sessions').get()!.closed_at);
    const lastPostAt = String(salon.db.prepare('SELECT MAX(created_at) AS t FROM posts').get()!.t);
    assert.ok(lastPostSeq < closeSeq, 'no post committed after the close');
    assert.ok(lastPostAt <= closedAt, 'no admitted post is timestamped after the close');
    assert.equal(Number(salon.db.prepare('SELECT COUNT(*) AS n FROM posts').get()!.n), admitted + 1);
  } finally {
    salon.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
