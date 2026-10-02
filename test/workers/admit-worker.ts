// Runs write jobs on its own SQLite connection so tests can race real
// concurrent writers against one database file.
import { parentPort, workerData } from 'node:worker_threads';
import { systemClock } from '../../src/infra/clock.ts';
import { createLocalSalon } from '../../src/node/local.ts';
import { ApiError } from '../../src/domain/errors.ts';

export type Job =
  | { kind: 'post'; token: string; threadId: string; sessionId: string; generation: number; key: string; body: string }
  // Keeps posting (pausing briefly so other writers get the lock) until refused.
  | { kind: 'post-until-refused'; token: string; threadId: string; sessionId: string; generation: number; keyPrefix: string; max: number; pauseMs: number }
  | { kind: 'close'; token: string; sessionId: string; afterPosts: number };

export type Outcome = { kind: 'post' | 'close'; status: number; code?: string; id?: string };

const { dbPath, gate, jobs } = workerData as { dbPath: string; gate: SharedArrayBuffer; jobs: Job[] };
const salon = await createLocalSalon({ dbPath, clock: systemClock, writesPerMinute: 1_000_000 });
const ledger = salon.ledger;
const db = salon.sql.raw;

async function actor(token: string) {
  const r = await salon.auth.resolve(token);
  if (r.kind !== 'ok') throw new Error('fixture token did not resolve');
  return r.actor;
}

Atomics.wait(new Int32Array(gate), 0, 0);
const pause = new Int32Array(new SharedArrayBuffer(4));

const outcomes: Outcome[] = [];
for (const job of jobs) {
  try {
    if (job.kind === 'post-until-refused') {
      for (let i = 0; i < job.max; i++) {
        try {
          const r = await ledger.createPost(await actor(job.token), job.threadId,
            { body: `${job.keyPrefix} post ${i}`, session_id: job.sessionId, generation: job.generation }, `${job.keyPrefix}-${i}`);
          outcomes.push({ kind: 'post', status: r.status, id: r.value.id });
        } catch (err) {
          if (!(err instanceof ApiError)) throw err;
          outcomes.push({ kind: 'post', status: err.status, code: err.code });
          break;
        }
        Atomics.wait(pause, 0, 0, job.pauseMs);
      }
    } else if (job.kind === 'post') {
      const r = await ledger.createPost(await actor(job.token), job.threadId,
        { body: job.body, session_id: job.sessionId, generation: job.generation }, job.key);
      outcomes.push({ kind: 'post', status: r.status, id: r.value.id });
    } else {
      while (Number(db.prepare('SELECT COUNT(*) AS n FROM posts').get()!.n) < job.afterPosts) { /* spin until the race is under way */ }
      const revision = Number(db.prepare('SELECT revision FROM sessions WHERE id = ?').get(job.sessionId)!.revision);
      const r = await ledger.closeSession(await actor(job.token), job.sessionId, { expected_revision: revision });
      outcomes.push({ kind: 'close', status: r.status });
    }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    outcomes.push({ kind: job.kind === 'close' ? 'close' : 'post', status: err.status, code: err.code });
  }
}
salon.sql.close();
parentPort!.postMessage(outcomes);
