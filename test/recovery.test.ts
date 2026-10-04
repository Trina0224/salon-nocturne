// A local rehearsal of the D1 Time Travel runbook in docs/deployment.md. A
// restore overwrites the database in place with an older state; here the
// SQLite file is overwritten with an earlier snapshot the same way. Local
// only: no remote restore is performed or simulated against Cloudflare.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPTURE_SQL, parseCapture, reapplySql, verifySql } from '../src/ops/recovery.ts';
import { TOKENS, setup } from './helpers.ts';

function rehearsal() {
  const dir = mkdtempSync(join(tmpdir(), 'salon-restore-'));
  const dbPath = join(dir, 'salon.db');
  const snapshot = join(dir, 'restore-point.db');
  return {
    dbPath,
    /** The state Time Travel will return to. */
    takeRestorePoint(raw: { exec(sql: string): void }) {
      raw.exec(`VACUUM INTO '${snapshot}'`);
    },
    /** In-place restore: the live database file is overwritten. */
    restoreInPlace(raw: { close(): void }) {
      raw.close();
      for (const suffix of ['-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
      copyFileSync(snapshot, dbPath);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const SECRET = 'Nebulously-personal remark';

test('restore runbook: reapplied redactions, revocations, and closes hold before reads reopen', async () => {
  const r = rehearsal();
  try {
    const live = setup({ dbPath: r.dbPath });
    const s = await live.openSession();
    const { thread } = await live.startThread(s.id, s.generation);
    const leaked = await live.post(thread.id, s, TOKENS.birch, `${SECRET}, later redacted.`);
    const x = await live.call('POST', '/api/v1/admin/participants', { token: TOKENS.owner, body: { display_name: 'Xenon' } });
    const xToken = x.body.credential.token as string;
    assert.equal((await live.call('GET', '/api/v1/me', { token: xToken })).status, 200);
    r.takeRestorePoint(live.raw);

    // After the restore point: the moderation and access decisions a restore would undo.
    const leakedPost = leaked.body.post as { id: string; revision: number };
    assert.equal((await live.call('POST', `/api/v1/admin/posts/${leakedPost.id}/moderate`, {
      token: TOKENS.owner, body: { action: 'redact', reason: 'privacy', expected_revision: leakedPost.revision } })).status, 200);
    assert.equal((await live.call('POST', `/api/v1/admin/credentials/${x.body.credential.id}/revoke`, { token: TOKENS.owner, body: {} })).status, 200);
    assert.equal((await live.call('POST', '/api/v1/admin/participants/p_cedar/revoke', { token: TOKENS.owner, body: { reason: 'left' } })).status, 200);
    const y = await live.call('POST', '/api/v1/admin/participants', { token: TOKENS.owner, body: { display_name: 'Yarrow' } });
    const lost = await live.post(thread.id, s, TOKENS.aster, 'Written after the restore point.');
    const current = await live.call('GET', '/api/v1/sessions/current');
    assert.equal((await live.call('POST', `/api/v1/admin/sessions/${s.id}/close`, {
      token: TOKENS.owner, body: { expected_revision: current.body.session.revision } })).status, 200);

    // Runbook step: capture the live state, exactly as `wrangler d1 execute --json` would return it.
    const row = live.raw.prepare(CAPTURE_SQL).get() as { capture: string };
    const capture = parseCapture(JSON.stringify([{ results: [row], success: true }]));
    assert.deepEqual(capture.redacted_posts, [leakedPost.id]);
    assert.equal(capture.closed_sessions.length, 1);

    // Runbook steps: maintenance on, then the in-place restore.
    r.restoreInPlace(live.raw);
    const restored = setup({ dbPath: r.dbPath, maintenance: true });
    // The hazard the runbook guards against: the restored database has the text again...
    const owner = await restored.call('GET', `/api/v1/posts/${leakedPost.id}`, { token: TOKENS.owner });
    assert.match(owner.body.post.body, new RegExp(SECRET));
    // ...but maintenance mode keeps every non-owner request out, credentials included.
    for (const token of [undefined, TOKENS.aster, xToken]) {
      const res = await restored.call('GET', `/api/v1/posts/${leakedPost.id}`, { token });
      assert.equal(res.status, 503);
      assert.equal(res.body.error.code, 'MAINTENANCE');
    }
    assert.equal((await restored.call('GET', `/threads/${thread.id}`)).status, 503);

    // Runbook steps: reapply, verify, and reapply again (idempotent).
    const before = verifyRow(restored.raw, capture);
    assert.ok(before.unredacted_posts === 1 && before.reopened_sessions === 1 && (before.live_revoked_credentials ?? 0) >= 2);
    restored.raw.exec(reapplySql(capture));
    assert.deepEqual(Object.values(verifyRow(restored.raw, capture)), [0, 0, 0, 0, 0, 0, 0]);
    const changes = () => (restored.raw.prepare('SELECT COUNT(*) AS n FROM changes').get() as { n: number }).n;
    const n = changes();
    restored.raw.exec(reapplySql(capture));
    assert.equal(changes(), n, 'a second run changes nothing');
    restored.raw.close();

    // Runbook step: maintenance off. Public reads no longer have the text anywhere.
    const open = setup({ dbPath: r.dbPath });
    const post = await open.call('GET', `/api/v1/posts/${leakedPost.id}`);
    assert.equal(post.body.post.state, 'redacted');
    assert.equal(post.body.post.body, null);
    for (const path of [`/api/v1/threads/${thread.id}/posts`, `/threads/${thread.id}`, `/api/v1/search?q=Nebulously`,
      `/api/v1/sessions/${s.id}/export`, `/api/v1/sessions/${s.id}/export?format=md`]) {
      const res = await open.call('GET', path);
      assert.equal(res.status, 200, path);
      assert.ok(!(await res.res.text()).includes('personal remark'), `${path} must not contain redacted text`);
    }
    assert.deepEqual((await open.call('GET', '/api/v1/search?q=Nebulously')).body.items, []);
    // Access: revocations hold; credentials issued after the restore point are gone (fail closed).
    assert.equal((await open.call('GET', '/api/v1/me', { token: xToken })).status, 403);
    assert.equal((await open.call('GET', '/api/v1/me', { token: TOKENS.cedar })).status, 403);
    assert.equal((await open.call('GET', '/api/v1/me', { token: y.body.credential.token })).status, 401);
    // The post written after the restore point is lost; the session stays closed.
    assert.equal((await open.call('GET', `/api/v1/posts/${lost.body.post.id}`)).status, 404);
    const late = await open.post(thread.id, s, TOKENS.aster, 'Too late.');
    assert.equal(late.body.error.code, 'SESSION_CLOSED');
    open.raw.close();
  } finally {
    r.cleanup();
  }
});

test('restore runbook: change cursors handed out after the restore point do not skip new writes', async () => {
  const r = rehearsal();
  try {
    const live = setup({ dbPath: r.dbPath });
    const s = await live.openSession();
    const { thread } = await live.startThread(s.id, s.generation);
    r.takeRestorePoint(live.raw);
    for (let i = 0; i < 3; i++) await live.post(thread.id, s, TOKENS.birch, `Lost ${i}`);
    // A reader catches up after the restore point and keeps its cursor.
    const feed = await live.call('GET', `/api/v1/sessions/${s.id}/changes?limit=100`, { token: TOKENS.cedar });
    const cursor = feed.body.next_cursor as string;
    const capture = parseCapture({ capture: (live.raw.prepare(CAPTURE_SQL).get() as { capture: string }).capture });

    r.restoreInPlace(live.raw);
    const restored = setup({ dbPath: r.dbPath, maintenance: true });
    await restored.salon.ready;
    restored.raw.exec(reapplySql(capture));
    assert.deepEqual(Object.values(verifyRow(restored.raw, capture)), [0, 0, 0, 0, 0, 0, 0]);
    restored.raw.close();

    const open = setup({ dbPath: r.dbPath });
    const fresh = await open.post(thread.id, s, TOKENS.aster, 'Written after recovery.');
    assert.equal(fresh.status, 201);
    const next = await open.call('GET', `/api/v1/sessions/${s.id}/changes?limit=100&cursor=${encodeURIComponent(cursor)}`, { token: TOKENS.cedar });
    assert.equal(next.status, 200);
    assert.ok(next.body.changes.some((c: { resource_id: string }) => c.resource_id === fresh.body.post.id),
      'the old cursor still sees the new post');
    open.raw.close();
  } finally {
    r.cleanup();
  }
});

test('recovery capture parsing rejects malformed or hostile input', () => {
  const ok = { captured_at: '2026-10-02T00:00:00.000Z', max_seq: 3, redacted_posts: '["post_a"]', revoked_participants: '[]', revoked_credentials: '[]', closed_sessions: '[]' };
  assert.deepEqual(parseCapture(ok).redacted_posts, ['post_a']);
  assert.throws(() => parseCapture({ ...ok, redacted_posts: `["x'); DROP TABLE posts; --"]` }), /malformed id/);
  assert.throws(() => parseCapture({ ...ok, max_seq: -1 }), /max_seq/);
  assert.throws(() => parseCapture({ ...ok, closed_sessions: '[{"id":"s1","closed_at":"2026-10-02T00:00:00Z","close_reason":"x"}]' }), /close_reason/);
  assert.throws(() => parseCapture({ ...ok, revoked_credentials: `[{"id":"c1","revoked_at":"now'"}]` }), /timestamp/);
});

function verifyRow(raw: { prepare(sql: string): { get(): unknown } }, capture: ReturnType<typeof parseCapture>) {
  return raw.prepare(verifySql(capture)).get() as Record<string, number>;
}
