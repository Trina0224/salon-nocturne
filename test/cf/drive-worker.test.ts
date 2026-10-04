// The Worker's Drive wiring: the scheduled handler and the notification
// webhook, with the real DriveHttpClient talking to a fake Google
// (test/drive-http-fake.ts), and local D1 in workerd (migrated by Wrangler).
// The Worker module's handlers run in Node here (so the outbound fetch can be
// replaced); the second test runs the real bundle in workerd for the
// configuration and webhook paths that need no outbound calls.
// Synthetic secrets only; no network, no Google project, no deployment.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { getPlatformProxy } from 'wrangler';
import worker from '../../src/worker.ts';
import type { WorkerEnv } from '../../src/config.ts';
import { MockDrive } from '../drive-mock.ts';
import { FakeGoogle, SYNTHETIC_OAUTH } from '../drive-http-fake.ts';
import { CONFIG as WRANGLER_CONFIG, OWNER_HASH, OWNER_TOKEN, PEPPER, cleanupTemplate, migratedState, startWorker } from './harness.ts';

after(cleanupTemplate);

const A = 'account-a';
const B = 'account-b';
const BRIDGE = {
  version: 1, notify_url: 'https://salon.test/drive/notifications', accounts: [{ id: A }, { id: B }],
  participants: [
    { name: 'Grok', account: A, outbox: 'out-grok', inbox: 'in-grok' },
    { name: 'Muse', account: B, outbox: 'out-muse', inbox: 'in-muse' },
    { name: 'Rei', account: B, outbox: 'out-rei', inbox: 'in-rei' },
  ],
};
const DRIVE_VARS = {
  DRIVE_BRIDGE_CONFIG: JSON.stringify(BRIDGE),
  DRIVE_OAUTH_CLIENT_ID: SYNTHETIC_OAUTH.clientId,
  DRIVE_OAUTH_CLIENT_SECRET: SYNTHETIC_OAUTH.clientSecret,
  DRIVE_OAUTH_REFRESH_TOKENS: JSON.stringify(SYNTHETIC_OAUTH.refreshTokens),
};
const limiter = { limit: async () => ({ success: true }) };

function context() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, settle: async () => { while (pending.length) await pending.shift(); } };
}

test('Worker Drive wiring: scheduled catch-up and webhook wake-ups run the bridge through the HTTP adapter on D1', async () => {
  const dir = migratedState();
  const proxy = await getPlatformProxy<{ DB: unknown }>({ configPath: WRANGLER_CONFIG, persist: { path: join(dir, 'v3') }, envFiles: [] });
  const mock = new MockDrive([A, B]);
  const google = new FakeGoogle(mock);
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => google.fetch(String(input instanceof Request ? input.url : input), init)) as typeof fetch;
  try {
    const env: WorkerEnv = { DB: proxy.env.DB, REQUEST_LIMITER: limiter, PARTICIPANT_LIMITER: limiter, OWNER_TOKEN_SHA256: OWNER_HASH, TOKEN_PEPPER: PEPPER, ...DRIVE_VARS };
    const call = async (method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
      const ctx = context();
      const headers: Record<string, string> = { ...opts.headers };
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await worker.fetch(new Request(`https://salon.test${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), env, ctx);
      const text = await res.text();
      await ctx.settle();
      return { status: res.status, text };
    };
    const open = await call('POST', '/api/v1/admin/sessions', { token: OWNER_TOKEN, body: { title: 'Drive wiring', duration_minutes: 60, limits: { maxPosts: 50, maxPostsPerParticipant: 20, maxThreads: 10, maxBodyChars: 500 } } });
    assert.equal(open.status, 201, open.text);

    // First scheduled run: participants synced, cursors taken, one channel per account watched.
    const sched = context();
    await worker.scheduled({}, env, sched);
    await sched.settle();
    assert.equal(mock.channels.size, 2);
    const ch = [...mock.channels.entries()].find(([, c]) => c.account === B)!;
    assert.ok(google.calls.some((c) => c.path === '/token'), 'access tokens came from the refresh grant');

    // A message, then a valid notification: the webhook's background run ingests and delivers it.
    mock.addFile(B, 'out-muse', { content: 'salon-message: 1\nid: muse-worker-1\ntitle: Via the Worker\n---\nWoken by a notification.\n' });
    const headers = { 'X-Goog-Channel-ID': ch[0], 'X-Goog-Channel-Token': ch[1].token, 'X-Goog-Resource-ID': ch[1].resourceId, 'X-Goog-Resource-State': 'change' };
    const before = google.calls.length;
    // Unknown channel, wrong token, and a body that looks like a message start nothing.
    assert.equal((await call('POST', '/drive/notifications', { headers: { ...headers, 'X-Goog-Channel-ID': 'ch_unknown' } })).status, 404);
    assert.equal((await call('POST', '/drive/notifications', { headers: { ...headers, 'X-Goog-Channel-Token': 'wrong' } })).status, 403);
    assert.equal(google.calls.length, before, 'no Drive work for invalid notifications');
    assert.equal((await call('POST', '/drive/notifications', { headers, body: { injected: 'salon-message: 1' } })).status, 200);
    const posts = proxy.env.DB as { prepare(s: string): { all(): Promise<{ results: { body: string }[] }> } };
    assert.deepEqual((await posts.prepare('SELECT body FROM posts').all()).results.map((r) => r.body), ['Woken by a notification.']);
    assert.equal(mock.filesIn('in-grok').length, 1, 'delivered across accounts');
    assert.equal(mock.filesIn('in-rei').length, 1);
    assert.equal(mock.filesIn('in-muse').length, 0, 'never to the author');

    // An interrupted scheduled run (Drive unavailable) loses nothing; the next one catches up.
    mock.addFile(A, 'out-grok', { content: 'salon-message: 1\nid: grok-worker-1\ntitle: Caught up\n---\nFound by the scheduled run.\n' });
    mock.fail('listChanges', 'transient', { account: A, times: 1 });
    const s2 = context();
    await worker.scheduled({}, env, s2);
    await s2.settle();
    assert.equal((await posts.prepare('SELECT body FROM posts').all()).results.length, 1, 'the interrupted run posted nothing new');
    const s3 = context();
    await worker.scheduled({}, env, s3);
    await s3.settle();
    const bodies = (await posts.prepare('SELECT body FROM posts ORDER BY seq').all()).results.map((r) => r.body);
    assert.deepEqual(bodies, ['Woken by a notification.', 'Found by the scheduled run.']);

    // Partial Drive settings: every request and the scheduled handler fail closed, with no Drive calls.
    const partial: WorkerEnv = { ...env, DRIVE_OAUTH_REFRESH_TOKENS: '' };
    const n = google.calls.length;
    const res = await worker.fetch(new Request('https://salon.test/api/v1/sessions/current'), partial, context());
    assert.equal(res.status, 503);
    const s4 = context();
    await worker.scheduled({}, partial, s4);
    await s4.settle();
    assert.equal(google.calls.length, n);
  } finally {
    globalThis.fetch = realFetch;
    await proxy.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Worker bundle in workerd: Drive settings are accepted only complete, and the webhook rejects unknown channels without outbound calls', async () => {
  const base = { OWNER_TOKEN_SHA256: OWNER_HASH, TOKEN_PEPPER: PEPPER };
  const full = await startWorker({ ...base, ...DRIVE_VARS });
  try {
    assert.notEqual((await full.worker.fetch('http://127.0.0.1/api/v1/sessions/current')).status, 503, 'complete settings are accepted');
    const hook = (state: string, id = 'ch_unknown') => full.worker.fetch('http://127.0.0.1/drive/notifications', {
      method: 'POST', headers: { 'X-Goog-Channel-ID': id, 'X-Goog-Channel-Token': 't', 'X-Goog-Resource-ID': 'r', 'X-Goog-Resource-State': state },
    });
    assert.equal((await hook('change')).status, 404);
    assert.equal((await hook('sync')).status, 200);
    assert.equal((await full.worker.fetch('http://127.0.0.1/drive/notifications', { method: 'POST' })).status, 400);
  } finally {
    await full.stop();
  }
  const partial = await startWorker({ ...base, DRIVE_BRIDGE_CONFIG: DRIVE_VARS.DRIVE_BRIDGE_CONFIG });
  try {
    assert.equal((await partial.worker.fetch('http://127.0.0.1/api/v1/sessions/current')).status, 503);
  } finally {
    await partial.stop();
  }
});
