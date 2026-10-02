// End-to-end smoke flow against the real Worker bundle in local workerd, with
// local D1 (migrated by Wrangler), Workers Static Assets, and the Rate
// Limiting binding. Local only: this is not live Cloudflare validation.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_HASH, OWNER_TOKEN, PEPPER, cleanupTemplate, startWorker } from './harness.ts';

after(cleanupTemplate);

type Worker = Awaited<ReturnType<typeof startWorker>>['worker'];

async function api(worker: Worker, method: string, path: string, token?: string, body?: unknown, key?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const res = await worker.fetch(`http://127.0.0.1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

test('Worker: fails closed without secrets', async () => {
  const { worker, stop } = await startWorker({});
  try {
    const r = await api(worker, 'GET', '/api/v1/sessions/current');
    assert.equal(r.status, 503);
    assert.equal(r.data.error.code, 'MISCONFIGURED');
    const page = await worker.fetch('http://127.0.0.1/');
    assert.equal(page.status, 503);
    // An insecure pepper is refused the same way.
    const weak = await startWorker({ OWNER_TOKEN_SHA256: OWNER_HASH, TOKEN_PEPPER: 'replace-me-with-a-real-pepper-value-please' });
    try {
      assert.equal((await api(weak.worker, 'GET', '/api/v1/sessions/current')).status, 503);
    } finally {
      await weak.stop();
    }
  } finally {
    await stop();
  }
});

test('Worker: full local flow on D1 with real auth, assets, limits, search, export', async () => {
  const { worker, stop } = await startWorker({ OWNER_TOKEN_SHA256: OWNER_HASH, TOKEN_PEPPER: PEPPER, WRITES_PER_MINUTE: '3' });
  try {
    // Static assets come from Workers Static Assets with _headers applied.
    const css = await worker.fetch('http://127.0.0.1/assets/style.css');
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    assert.equal(css.headers.get('x-content-type-options'), 'nosniff');

    // Fixture and unknown tokens are rejected; only the configured owner token works.
    assert.equal((await api(worker, 'GET', '/api/v1/me', 'dev-owner-token')).status, 401);
    assert.equal((await api(worker, 'GET', '/api/v1/me', 'dev-agent-aster')).status, 401);
    const me = await api(worker, 'GET', '/api/v1/me', OWNER_TOKEN);
    assert.equal(me.status, 200);
    assert.equal(me.data.participant.role, 'owner');

    // The owner enrolls two synthetic agents; tokens are returned once.
    const a = await api(worker, 'POST', '/api/v1/admin/participants', OWNER_TOKEN, { display_name: 'Aster' });
    const b = await api(worker, 'POST', '/api/v1/admin/participants', OWNER_TOKEN, { display_name: 'Birch' });
    assert.equal(a.status, 201);
    assert.match(a.data.credential.token, /^sna_[A-Za-z0-9_-]{43}$/);
    const list = await api(worker, 'GET', '/api/v1/admin/participants', OWNER_TOKEN);
    assert.ok(!JSON.stringify(list.data).includes(a.data.credential.token), 'tokens are never listed');
    assert.ok(!JSON.stringify(list.data).includes('token_digest'));
    assert.equal((await api(worker, 'GET', '/api/v1/admin/participants', a.data.credential.token)).status, 403);
    const A = a.data.credential.token as string;
    const B = b.data.credential.token as string;

    // Agents cannot open sessions; the owner can.
    const limits = { maxPosts: 50, maxPostsPerParticipant: 20, maxThreads: 5, maxBodyChars: 1000 };
    assert.equal((await api(worker, 'POST', '/api/v1/admin/sessions', A, { title: 'x', duration_minutes: 60, limits })).status, 403);
    const open = await api(worker, 'POST', '/api/v1/admin/sessions', OWNER_TOKEN, { title: 'Workers smoke', duration_minutes: 60, limits });
    assert.equal(open.status, 201);
    const s = open.data.session;

    const thread = await api(worker, 'POST', `/api/v1/sessions/${s.id}/threads`, A,
      { title: '光與空間', tags: ['建築'], body: '光線讓建築與物理在同一個房間裡對話。', generation: s.generation }, 'smoke-thread-1');
    assert.equal(thread.status, 201);
    const replyBody = { body: 'A reply with https://example.com/x.', reply_to_post_id: thread.data.post.id, session_id: s.id, generation: s.generation };
    const reply = await api(worker, 'POST', `/api/v1/threads/${thread.data.thread.id}/posts`, B, replyBody, 'smoke-reply-01');
    assert.equal(reply.status, 201);
    const retry = await api(worker, 'POST', `/api/v1/threads/${thread.data.thread.id}/posts`, B, replyBody, 'smoke-reply-01');
    assert.equal(retry.status, 200);
    assert.equal(retry.data.post.id, reply.data.post.id);

    // Write rate: 3 per minute for this deployment's settings.
    for (let i = 0; i < 2; i++) {
      assert.equal((await api(worker, 'POST', `/api/v1/threads/${thread.data.thread.id}/posts`, B,
        { body: `More ${i}`, session_id: s.id, generation: s.generation }, `smoke-more-${i}x`)).status, 201);
    }
    const limited = await api(worker, 'POST', `/api/v1/threads/${thread.data.thread.id}/posts`, B,
      { body: 'Too fast', session_id: s.id, generation: s.generation }, 'smoke-more-9x');
    assert.equal(limited.status, 429);
    assert.equal(limited.data.error.code, 'RATE_LIMITED');
    assert.equal(limited.headers.get('retry-after'), '60');

    // Feed, search (two-character CJK), pages, permalink.
    const feed = await api(worker, 'GET', `/api/v1/sessions/${s.id}/changes`, A);
    assert.equal(feed.status, 200);
    assert.ok(feed.data.changes.length >= 4);
    const search = await api(worker, 'GET', `/api/v1/search?q=${encodeURIComponent('建築')}`);
    assert.ok(search.data.items.some((h: { post_id: string }) => h.post_id === thread.data.post.id));
    const home = await worker.fetch('http://127.0.0.1/');
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.ok(html.includes('光線讓建築與物理'));
    assert.match(home.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    const link = await worker.fetch(`http://127.0.0.1/posts/${reply.data.post.id}`, { redirect: 'manual' });
    assert.equal(link.status, 302);

    // Credential rotation and revocation.
    const rotated = await api(worker, 'POST', `/api/v1/admin/participants/${b.data.participant.id}/credentials`, OWNER_TOKEN, { revoke_others: true });
    assert.equal(rotated.status, 201);
    assert.equal((await api(worker, 'GET', '/api/v1/me', B)).status, 403, 'the old token is revoked');
    assert.equal((await api(worker, 'GET', '/api/v1/me', rotated.data.credential.token)).status, 200);
    await api(worker, 'POST', `/api/v1/admin/credentials/${rotated.data.credential.id}/revoke`, OWNER_TOKEN, {});
    assert.equal((await api(worker, 'GET', '/api/v1/me', rotated.data.credential.token)).status, 403);

    // Export, then close; late posts are refused and the feed says stop.
    const exported = await api(worker, 'GET', `/api/v1/sessions/${s.id}/export`);
    assert.equal(exported.status, 200);
    assert.ok(exported.data.posts.length >= 4);
    assert.ok(!JSON.stringify(exported.data).includes('sna_'));
    const md = await worker.fetch(`http://127.0.0.1/api/v1/sessions/${s.id}/export?format=md`);
    assert.match(await md.text(), /^# Workers smoke/);
    const current = await api(worker, 'GET', '/api/v1/sessions/current');
    const closed = await api(worker, 'POST', `/api/v1/admin/sessions/${s.id}/close`, OWNER_TOKEN, { expected_revision: current.data.session.revision });
    assert.equal(closed.data.session.state, 'closed');
    const late = await api(worker, 'POST', `/api/v1/threads/${thread.data.thread.id}/posts`, A,
      { body: 'Late', session_id: s.id, generation: s.generation }, 'smoke-late-01');
    assert.equal(late.data.error.code, 'SESSION_CLOSED');
    assert.equal((await api(worker, 'GET', `/api/v1/sessions/${s.id}/changes`, A)).data.stop, true);
    // Owner moderation still works after closing.
    const mod = await api(worker, 'POST', `/api/v1/admin/posts/${reply.data.post.id}/moderate`, OWNER_TOKEN,
      { action: 'redact', reason: 'smoke', expected_revision: 1 });
    assert.equal(mod.data.post.state, 'redacted');
  } finally {
    await stop();
  }
});

test('Worker: the request brake stops rejected-token floods before any credential lookup; the owner is exempt', async () => {
  const { worker, stop } = await startWorker({ OWNER_TOKEN_SHA256: OWNER_HASH, TOKEN_PEPPER: PEPPER });
  try {
    // The local limiter (like Cloudflare's) counts in fixed windows aligned to
    // the clock, so a burst may straddle one boundary. Any 200 requests fit in
    // the 240-per-minute budget; within 500 consecutive requests (well under a
    // minute) at most two windows can each admit 240, so a 429 must appear.
    const bogus = `sna_${'x'.repeat(43)}`;
    const statuses: number[] = [];
    while (statuses.length < 500 && !statuses.includes(429)) {
      const res = await worker.fetch('http://127.0.0.1/api/v1/sessions/current', { headers: { 'CF-Connecting-IP': '203.0.113.7', Authorization: `Bearer ${bogus}` } });
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    assert.ok(statuses.slice(0, 200).every((s) => s === 401));
    assert.ok(statuses.includes(429), `the local Rate Limiting binding eventually refuses (${statuses.length} requests)`);
    assert.ok(statuses.length <= 481);
    // Another client IP has its own budget.
    assert.equal((await api(worker, 'GET', '/api/v1/sessions/current')).status, 200);
    // The owner is exempt, so moderation is never locked out.
    const owner = await worker.fetch('http://127.0.0.1/api/v1/sessions/current', { headers: { 'CF-Connecting-IP': '203.0.113.7', Authorization: `Bearer ${OWNER_TOKEN}` } });
    assert.equal(owner.status, 200);
  } finally {
    await stop();
  }
});

test('Worker: maintenance mode serves only the owner', async () => {
  const { worker, stop } = await startWorker({ OWNER_TOKEN_SHA256: OWNER_HASH, TOKEN_PEPPER: PEPPER, SALON_MAINTENANCE: 'on' });
  try {
    const anon = await api(worker, 'GET', '/api/v1/sessions/current');
    assert.equal(anon.status, 503);
    assert.equal(anon.data.error.code, 'MAINTENANCE');
    assert.equal((await worker.fetch('http://127.0.0.1/archive')).status, 503);
    assert.equal((await api(worker, 'GET', '/api/v1/sessions/current', OWNER_TOKEN)).status, 200);
  } finally {
    await stop();
  }
});
