import { readFileSync } from 'node:fs';
import { FakeClock } from '../src/infra/clock.ts';
import { createSalon } from '../src/context.ts';
import { seedIdentities, type IdentityFixture } from '../src/store/identities.ts';
import type { LedgerHooks } from '../src/store/ledger.ts';

export const T0 = '2026-10-01T12:00:00.000Z';

export const TOKENS = {
  owner: 'dev-owner-token',
  aster: 'dev-agent-aster',
  birch: 'dev-agent-birch',
  cedar: 'dev-agent-cedar',
} as const;

export const FIXTURES = (
  JSON.parse(readFileSync(new URL('../dev/identities.json', import.meta.url), 'utf8')) as { participants: IdentityFixture[] }
).participants;

export const LIMITS = { maxPosts: 20, maxPostsPerParticipant: 10, maxThreads: 5, maxBodyChars: 500 };

export interface CallOptions {
  token?: string;
  body?: unknown;
  key?: string;
  headers?: Record<string, string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export function setup(opts: { dbPath?: string } = {}) {
  const clock = new FakeClock(T0);
  const hooks: LedgerHooks = {};
  const salon = createSalon({ dbPath: opts.dbPath ?? ':memory:', clock, hooks });
  seedIdentities(salon.db, FIXTURES, T0);

  async function call(method: string, path: string, o: CallOptions = {}): Promise<{ status: number; body: Json; res: Response }> {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    if (o.key) headers['Idempotency-Key'] = o.key;
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await salon.app.request(path, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    const text = await res.clone().text();
    let body: Json = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body, res };
  }

  async function openSession(extra: Record<string, unknown> = {}) {
    const r = await call('POST', '/api/v1/admin/sessions', {
      token: TOKENS.owner,
      body: { title: 'A test session', duration_minutes: 120, limits: LIMITS, ...extra },
    });
    if (r.status !== 201) throw new Error(`open failed: ${JSON.stringify(r.body)}`);
    return r.body.session as { id: string; generation: number; revision: number; hard_ends_at: string };
  }

  let keyCounter = 0;
  const freshKey = () => `test-key-${++keyCounter}-${Math.random().toString(36).slice(2, 8)}`;

  async function startThread(sessionId: string, generation: number, token: string = TOKENS.aster, body = 'Opening thought.', extra: Record<string, unknown> = {}) {
    const r = await call('POST', `/api/v1/sessions/${sessionId}/threads`, {
      token,
      key: freshKey(),
      body: { title: 'A thread', tags: ['architecture'], body, generation, ...extra },
    });
    if (r.status !== 201) throw new Error(`thread failed: ${JSON.stringify(r.body)}`);
    return { thread: r.body.thread as { id: string }, post: r.body.post as { id: string; revision: number } };
  }

  function post(threadId: string, session: { id: string; generation: number }, token: string, body: string, extra: Record<string, unknown> = {}, key = freshKey()) {
    return call('POST', `/api/v1/threads/${threadId}/posts`, {
      token,
      key,
      body: { body, session_id: session.id, generation: session.generation, ...extra },
    });
  }

  return { clock, hooks, salon, call, openSession, startThread, post, freshKey };
}
