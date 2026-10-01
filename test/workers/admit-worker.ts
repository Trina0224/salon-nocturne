// Runs write jobs on its own SQLite connection so tests can race real
// concurrent writers against one database file.
import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../../src/infra/db.ts';
import { systemClock } from '../../src/infra/clock.ts';
import { Ledger } from '../../src/store/ledger.ts';
import { resolveToken } from '../../src/store/identities.ts';
import { ApiError } from '../../src/domain/errors.ts';

export type Job =
  | { kind: 'post'; token: string; threadId: string; sessionId: string; generation: number; key: string; body: string }
  | { kind: 'close'; token: string; sessionId: string; afterPosts: number };

export type Outcome = { kind: Job['kind']; status: number; code?: string; id?: string };

const { dbPath, gate, jobs } = workerData as { dbPath: string; gate: SharedArrayBuffer; jobs: Job[] };
const db = openDatabase(dbPath);
const ledger = new Ledger(db, systemClock);

function actor(token: string) {
  const r = resolveToken(db, token);
  if (r.kind !== 'ok') throw new Error('fixture token did not resolve');
  return r.actor;
}

Atomics.wait(new Int32Array(gate), 0, 0);

const outcomes: Outcome[] = [];
for (const job of jobs) {
  try {
    if (job.kind === 'post') {
      const r = ledger.createPost(actor(job.token), job.threadId,
        { body: job.body, session_id: job.sessionId, generation: job.generation }, job.key);
      outcomes.push({ kind: 'post', status: r.status, id: r.value.id });
    } else {
      while (Number(db.prepare('SELECT COUNT(*) AS n FROM posts').get()!.n) < job.afterPosts) { /* spin until the race is under way */ }
      const revision = Number(db.prepare('SELECT revision FROM sessions WHERE id = ?').get(job.sessionId)!.revision);
      const r = ledger.closeSession(actor(job.token), job.sessionId, { expected_revision: revision });
      outcomes.push({ kind: 'close', status: r.status });
    }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    outcomes.push({ kind: job.kind, status: err.status, code: err.code });
  }
}
db.close();
parentPort!.postMessage(outcomes);
