import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOKENS, setup } from './helpers.ts';

test('the change feed is incremental, gap-free, and needs a reader credential', async () => {
  const { openSession, startThread, post, call } = setup();
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation);
  for (let i = 0; i < 7; i++) await post(thread.id, s, i % 2 ? TOKENS.birch : TOKENS.cedar, `Post ${i}`);

  assert.equal((await call('GET', `/api/v1/sessions/${s.id}/changes`)).status, 401);

  const seen: number[] = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const r = await call('GET', `/api/v1/sessions/${s.id}/changes?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { token: TOKENS.aster });
    assert.equal(r.status, 200);
    assert.equal(r.body.stop, false);
    seen.push(...r.body.changes.map((c: { seq: number }) => c.seq));
    cursor = r.body.next_cursor;
    if (!r.body.has_more) break;
  }
  // session open + thread + opener + 7 posts
  assert.equal(seen.length, 10);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  assert.equal(new Set(seen).size, seen.length);

  // New activity after the reader caught up arrives on the next poll only.
  await post(thread.id, s, TOKENS.birch, 'Later.');
  const next = await call('GET', `/api/v1/sessions/${s.id}/changes?cursor=${encodeURIComponent(cursor)}`, { token: TOKENS.aster });
  assert.equal(next.body.changes.length, 1);
  assert.equal(next.body.changes[0].data.body, 'Later.');
  assert.equal(typeof next.body.budgets.your_posts_remaining, 'number');
});

test('redaction reaches the feed as a tombstone and old cursors cannot see the text', async () => {
  const { openSession, startThread, post, call } = setup();
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation);
  const p = await post(thread.id, s, TOKENS.birch, 'Secret-ish words.');
  const first = await call('GET', `/api/v1/sessions/${s.id}/changes`, { token: TOKENS.aster });
  await call('POST', `/api/v1/admin/posts/${p.body.post.id}/moderate`, {
    token: TOKENS.owner, body: { action: 'redact', reason: 'test', expected_revision: 1 },
  });
  const fromStart = await call('GET', `/api/v1/sessions/${s.id}/changes`, { token: TOKENS.aster });
  const all = fromStart.body.changes.filter((c: { resource_id: string }) => c.resource_id === p.body.post.id);
  assert.ok(all.length >= 2);
  for (const c of all) {
    assert.equal(c.op, 'tombstone');
    assert.equal(c.data.body, null);
  }
  const after = await call('GET', `/api/v1/sessions/${s.id}/changes?cursor=${encodeURIComponent(first.body.next_cursor)}`, { token: TOKENS.aster });
  assert.deepEqual(after.body.changes.map((c: { op: string }) => c.op), ['tombstone']);
  assert.ok(!JSON.stringify(fromStart.body).includes('Secret-ish'));
});

test('a closed session tells participants to stop, while the archive stays public', async () => {
  const { openSession, startThread, call, clock } = setup();
  const s = await openSession({ duration_minutes: 30 });
  const { thread } = await startThread(s.id, s.generation);
  clock.advance(31 * 60_000);
  const feed = await call('GET', `/api/v1/sessions/${s.id}/changes`, { token: TOKENS.birch });
  assert.equal(feed.status, 200);
  assert.equal(feed.body.stop, true);
  assert.equal(feed.body.changes.length, 0);
  assert.equal((await call('GET', `/api/v1/threads/${thread.id}/posts`)).body.items.length, 1);
  assert.equal((await call('GET', '/api/v1/search?q=Opening')).body.items.length, 1);
});

test('cursors are validated, scoped, and stable while new posts arrive', async () => {
  const { openSession, startThread, post, call } = setup();
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation);
  for (let i = 0; i < 5; i++) await post(thread.id, s, TOKENS.birch, `Item ${i}`);
  const p1 = await call('GET', `/api/v1/threads/${thread.id}/posts?limit=3`);
  assert.equal(p1.body.items.length, 3);
  // Posts arriving mid-pagination do not shift or duplicate the snapshot.
  await post(thread.id, s, TOKENS.cedar, 'Arrived mid-pagination');
  const p2 = await call('GET', `/api/v1/threads/${thread.id}/posts?limit=3&cursor=${encodeURIComponent(p1.body.next_cursor)}`);
  const bodies = [...p1.body.items, ...p2.body.items].map((p: { body: string }) => p.body);
  assert.deepEqual(bodies, ['Opening thought.', 'Item 0', 'Item 1', 'Item 2', 'Item 3', 'Item 4']);
  // The snapshot is exhausted, but a newer post exists: the listing continues
  // into a fresh snapshot instead of ending, with no gap or duplicate.
  assert.equal(p2.body.has_more, true);
  const p3 = await call('GET', `/api/v1/threads/${thread.id}/posts?limit=3&cursor=${encodeURIComponent(p2.body.next_cursor)}`);
  assert.deepEqual(p3.body.items.map((p: { body: string }) => p.body), ['Arrived mid-pagination']);
  assert.equal(p3.body.has_more, false);
  assert.equal(p3.body.next_cursor, null);

  const bad = await call('GET', `/api/v1/threads/${thread.id}/posts?cursor=garbage`);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'INVALID_CURSOR');
  const tampered = p1.body.next_cursor.replace(/^./, (c: string) => (c === 'e' ? 'f' : 'e'));
  assert.equal((await call('GET', `/api/v1/threads/${thread.id}/posts?cursor=${encodeURIComponent(tampered)}`)).status, 400);
  const otherScope = await call('GET', `/api/v1/search?q=Item&cursor=${encodeURIComponent(p1.body.next_cursor)}`);
  assert.equal(otherScope.body.error.code, 'INVALID_CURSOR');
  assert.equal((await call('GET', `/api/v1/threads/${thread.id}/posts?limit=101`)).status, 400);
  assert.equal((await call('GET', `/api/v1/threads/${thread.id}/posts?limit=0`)).status, 400);
});

test('expired cursors ask the reader to restart', async () => {
  const { openSession, startThread, post, call, clock } = setup();
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation);
  for (let i = 0; i < 3; i++) await post(thread.id, s, TOKENS.birch, `Item ${i}`);
  const p1 = await call('GET', `/api/v1/threads/${thread.id}/posts?limit=2`);
  clock.advance(8 * 24 * 3600_000);
  const r = await call('GET', `/api/v1/threads/${thread.id}/posts?limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`);
  assert.equal(r.body.error.code, 'CURSOR_EXPIRED');
});

test('search finds English and CJK text in titles, bodies, and tags', async () => {
  const { openSession, startThread, post, call } = setup();
  const s = await openSession();
  const en = await startThread(s.id, s.generation, TOKENS.aster, 'Could a better world begin with a better room?', {
    title: 'The shape of a room', tags: ['architecture'],
  });
  const zh = await startThread(s.id, s.generation, TOKENS.birch, '光線讓建築與物理在同一個房間裡對話。', {
    title: '光與空間', tags: ['建築', 'physics'],
  });
  const ja = await post(zh.thread.id, s, TOKENS.cedar, '静かな部屋は、考えるための楽器です。');

  const ids = async (q: string) =>
    (await call('GET', `/api/v1/search?q=${encodeURIComponent(q)}`)).body.items.map((h: { post_id: string }) => h.post_id);

  assert.deepEqual(await ids('better room'), [en.post.id], 'English body, multiple terms');
  assert.deepEqual(await ids('shape'), [en.post.id], 'English title');
  assert.deepEqual(await ids('ARCHITECTURE'), [en.post.id], 'tag, case-insensitive');
  assert.deepEqual(await ids('建築與物理'), [zh.post.id], 'CJK, 5 characters (trigram)');
  assert.deepEqual(await ids('建築'), [ja.body.post.id, zh.post.id], 'CJK, 2 characters (fallback); the thread tag matches both posts');
  assert.deepEqual(await ids('物理'), [zh.post.id], 'CJK, 2 characters in body');
  assert.deepEqual(await ids('光'), [ja.body.post.id, zh.post.id], 'one character matches the thread title of both posts');
  assert.deepEqual(await ids('部屋'), [ja.body.post.id], 'Japanese, 2 characters');
  assert.deepEqual(await ids('物理 光線'), [zh.post.id], 'mixed short and long CJK terms');
  assert.deepEqual(await ids('nothing-here'), []);

  const hit = (await call('GET', `/api/v1/search?q=${encodeURIComponent('物理')}`)).body.items[0];
  assert.equal(hit.url, `/posts/${zh.post.id}`);
  assert.ok(hit.snippet.includes('物理'));

  assert.equal((await call('GET', '/api/v1/search?q=')).status, 400);
  assert.equal((await call('GET', `/api/v1/search?q=${'x'.repeat(101)}`)).status, 413);
  // Query syntax is data, not FTS operators or SQL.
  assert.equal((await call('GET', `/api/v1/search?q=${encodeURIComponent('"room" OR body:* %_\\')}`)).status, 200);
});

test('search paginates stably and drops redacted posts', async () => {
  const { openSession, startThread, post, call } = setup();
  const s = await openSession();
  const { thread } = await startThread(s.id, s.generation, TOKENS.aster, 'lantern 0');
  const made: string[] = [];
  for (let i = 1; i < 5; i++) made.push((await post(thread.id, s, TOKENS.birch, `lantern ${i}`)).body.post.id);
  const p1 = await call('GET', '/api/v1/search?q=lantern&limit=2');
  await post(thread.id, s, TOKENS.cedar, 'lantern new');
  const p2 = await call('GET', `/api/v1/search?q=lantern&limit=2&cursor=${encodeURIComponent(p1.body.next_cursor)}`);
  const p3 = await call('GET', `/api/v1/search?q=lantern&limit=2&cursor=${encodeURIComponent(p2.body.next_cursor)}`);
  const all = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((h: { snippet: string }) => h.snippet);
  assert.deepEqual(all, ['lantern 4', 'lantern 3', 'lantern 2', 'lantern 1', 'lantern 0']);

  await call('POST', `/api/v1/admin/posts/${made[0]}/moderate`, {
    token: TOKENS.owner, body: { action: 'redact', reason: 'test', expected_revision: 1 },
  });
  const after = await call('GET', '/api/v1/search?q=lantern&limit=100');
  assert.ok(!after.body.items.some((h: { post_id: string }) => h.post_id === made[0]));
});

test('export preserves order and replies, and omits secrets and removed text', async () => {
  const { openSession, startThread, post, call } = setup();
  const s = await openSession({ title: 'Export me' });
  const { thread, post: opener } = await startThread(s.id, s.generation);
  const reply = await post(thread.id, s, TOKENS.birch, 'A reply.', { reply_to_post_id: opener.id });
  const gone = await post(thread.id, s, TOKENS.cedar, 'Words to be removed.');
  await post(thread.id, s, TOKENS.aster, 'Answering Birch.', { reply_to_post_id: reply.body.post.id });
  await call('POST', `/api/v1/admin/posts/${gone.body.post.id}/moderate`, {
    token: TOKENS.owner, body: { action: 'redact', reason: 'private reason', expected_revision: 1 },
  });

  const r = await call('GET', `/api/v1/sessions/${s.id}/export`);
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get('content-disposition')!, /attachment/);
  const data = r.body;
  assert.equal(data.schema, 'salon-nocturne.conversation.v1');
  assert.deepEqual(data.media_manifest.items, []);
  const seqs = data.posts.map((p: { seq: number }) => p.seq);
  assert.deepEqual(seqs, [...seqs].sort((a: number, b: number) => a - b));
  assert.equal(data.posts[1].reply_to_post_id, opener.id);
  assert.equal(data.posts[3].reply_to_post_id, reply.body.post.id);
  const removed = data.posts.find((p: { id: string }) => p.id === gone.body.post.id);
  assert.equal(removed.redacted, true);
  assert.equal(removed.body, null);

  const text = JSON.stringify(data);
  for (const forbidden of ['Words to be removed', 'private reason', 'dev-owner-token', 'dev-agent', 'token_digest', 'audit', 'cred_']) {
    assert.ok(!text.includes(forbidden), `export must not contain ${forbidden}`);
  }

  const md = await call('GET', `/api/v1/sessions/${s.id}/export?format=md`);
  assert.equal(md.status, 200);
  assert.match(md.body, /^# Export me/);
  assert.match(md.body, /Replying to Birch/);
  assert.match(md.body, /\[Removed by the host\.\]/);
  assert.ok(!md.body.includes('Words to be removed'));
});

test('state survives a restart and the deadline is still enforced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'salon-restart-'));
  try {
    const dbPath = join(dir, 'salon.db');
    const a = setup({ dbPath });
    const s = await a.openSession({ duration_minutes: 30 });
    const { thread } = await a.startThread(s.id, s.generation);
    const kept = await a.post(thread.id, s, TOKENS.birch, 'Survives restarts.', {}, 'restart-key-01');
    a.salon.db.close();

    const b = setup({ dbPath });
    const page = await b.call('GET', `/api/v1/threads/${thread.id}/posts`);
    assert.deepEqual(page.body.items.map((p: { id: string }) => p.id).at(-1), kept.body.post.id);
    const replay = await b.post(thread.id, s, TOKENS.birch, 'Survives restarts.', {}, 'restart-key-01');
    assert.equal(replay.status, 200, 'receipts persist');
    b.clock.advance(31 * 60_000);
    assert.equal((await b.post(thread.id, s, TOKENS.birch, 'After deadline.')).body.error.code, 'SESSION_CLOSED');
    b.salon.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/me reports identity and budgets without credential material', async () => {
  const { openSession, call } = setup();
  await openSession();
  const r = await call('GET', '/api/v1/me', { token: TOKENS.aster });
  assert.equal(r.body.participant.id, 'p_aster');
  assert.deepEqual(r.body.scopes, ['read', 'post']);
  assert.equal(r.body.current_session.state, 'open');
  assert.ok(!JSON.stringify(r.body).includes('dev-agent'));
});
