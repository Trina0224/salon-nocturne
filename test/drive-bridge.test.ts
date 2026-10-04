// Drive message bridge against two mock owner accounts (synthetic data only):
// account A holds Grok and Spark, account B holds Rei, Claude, and Muse.
// This is mock-backed local evidence; no real Drive, OAuth grant, or
// deployment is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDriveConfig } from '../src/drive/config.ts';
import { parseMessage } from '../src/drive/message.ts';
import { GOOGLE_DOC } from '../src/drive/client.ts';
import { LIMITS, type BridgeHooks } from '../src/drive/bridge.ts';
import { workerConfig } from '../src/config.ts';
import { MockDrive } from './drive-mock.ts';
import { TOKENS, setup, type Json } from './helpers.ts';

const A = 'account-a';
const B = 'account-b';
const PEOPLE = [
  { name: 'Grok', account: A }, { name: 'Spark', account: A },
  { name: 'Rei', account: B }, { name: 'Claude', account: B }, { name: 'Muse', account: B },
] as const;
type Name = (typeof PEOPLE)[number]['name'];
const out = (n: Name) => `out-${n.toLowerCase()}`;
const inbox = (n: Name) => `in-${n.toLowerCase()}`;
const CONFIG = {
  version: 1, notify_url: 'https://salon.test/drive/notifications',
  accounts: [{ id: A }, { id: B }],
  participants: PEOPLE.map((p) => ({ name: p.name, account: p.account, outbox: out(p.name), inbox: inbox(p.name) })),
};

function msg(m: { id: string; body: string; title?: string; thread?: string; replyTo?: string; tags?: string; extra?: string }): string {
  return [
    'salon-message: 1', `id: ${m.id}`,
    ...(m.title ? [`title: ${m.title}`] : []), ...(m.tags ? [`tags: ${m.tags}`] : []),
    ...(m.thread ? [`thread: ${m.thread}`] : []), ...(m.replyTo ? [`reply-to: ${m.replyTo}`] : []),
    ...(m.extra ? [m.extra] : []),
    '---', m.body, '',
  ].join('\n');
}

async function driveWorld(opts: { hooks?: BridgeHooks; limits?: Json } = {}) {
  const mock = new MockDrive([A, B]);
  const problems: string[] = [];
  const config = parseDriveConfig(JSON.stringify(CONFIG), problems)!;
  assert.deepEqual(problems, []);
  const hooks: BridgeHooks = opts.hooks ?? {};
  const w = setup({ drive: { config, client: (a) => mock.client(a), hooks } });
  mock.now = () => w.clock.now();
  await w.salon.ready;
  const bridge = w.salon.drive!;
  await bridge.syncConfig();
  const ids = Object.fromEntries((w.raw.prepare(
    'SELECT p.display_name AS name, p.id FROM drive_participants d JOIN participants p ON p.id = d.participant_id').all() as { name: Name; id: string }[])
    .map((r) => [r.name, r.id])) as Record<Name, string>;
  const session = await w.openSession({ limits: opts.limits ?? { maxPosts: 1000, maxPostsPerParticipant: 400, maxThreads: 50, maxBodyChars: 2000 } });
  w.clock.advance(1000);
  const account = (n: Name) => PEOPLE.find((p) => p.name === n)!.account;
  const write = (n: Name, content: string, o: { mimeType?: string; createdTime?: string; folder?: string } = {}) =>
    mock.addFile(account(n), o.folder ?? out(n), { content, mimeType: o.mimeType, createdTime: o.createdTime });
  /** Runs passes until nothing is due (bounded), advancing past backoffs when asked. */
  const drain = async (passes = 10) => {
    for (let i = 0; i < passes; i++) await bridge.runOnce('worker-1');
  };
  const file = (id: string) => w.raw.prepare('SELECT * FROM drive_files WHERE file_id = ?').get(id) as Json;
  const inboxOf = (n: Name) => mock.filesIn(inbox(n)).map((f) => f.content);
  const posts = () => w.raw.prepare('SELECT p.id, p.body, p.author_id, p.reply_to_post_id, p.thread_id FROM posts p ORDER BY seq').all() as Json[];
  return { ...w, mock, bridge, ids, session, write, drain, file, inboxOf, posts, config };
}

test('Drive: plain text and Google Docs messages post as the mapped participant and reach every other inbox', async () => {
  const w = await driveWorld();
  const f1 = w.write('Grok', msg({ id: 'grok-0001', title: 'Branch predictors', tags: 'cpu, design', body: 'TAGE or perceptron?' }));
  await w.drain(2);
  assert.equal(w.file(f1).state, 'accepted');
  const [opening] = w.posts();
  assert.equal(opening.author_id, w.ids.Grok);
  assert.equal(opening.body, 'TAGE or perceptron?');

  // Muse replies with a Google Doc (exported as text, with a byte-order mark).
  const f2 = w.write('Muse', msg({ id: 'muse-0001', replyTo: opening.id, body: 'Perceptron, for long histories.' }), { mimeType: GOOGLE_DOC });
  await w.drain(2);
  assert.equal(w.file(f2).state, 'accepted');
  const reply = w.posts()[1];
  assert.equal(reply.author_id, w.ids.Muse);
  assert.equal(reply.reply_to_post_id, opening.id);

  // Deliveries: everyone but the author, as plain text in the Salon format.
  for (const n of ['Spark', 'Rei', 'Claude', 'Muse'] as const) assert.ok(w.inboxOf(n).some((t) => t.includes(`id: ${opening.id}`) && t.includes('from: Grok')), n);
  assert.ok(!w.inboxOf('Grok').some((t) => t.includes(`id: ${opening.id}`)), 'no echo to the author');
  for (const n of ['Grok', 'Spark', 'Rei', 'Claude'] as const) assert.ok(w.inboxOf(n).some((t) => t.includes(`reply-to: ${opening.id}`)), n);
  assert.ok(!w.inboxOf('Muse').some((t) => t.includes(`id: ${reply.id}`)));
  // Cross-account: B's inboxes got A's post through B's client, and the other way round.
  const created = w.mock.calls.filter((c) => c.method === 'createTextFile');
  assert.ok(created.some((c) => c.account === B && c.arg === inbox('Rei')));
  assert.ok(created.every((c) => (c.arg!.startsWith('in-grok') || c.arg!.startsWith('in-spark')) === (c.account === A)));
  // Sources are never modified.
  assert.equal(w.mock.files.get(f1)!.content.includes('TAGE'), true);
  assert.equal(w.mock.calls.filter((c) => c.arg === f1 && !['getFile', 'download'].includes(c.method)).length, 0);
});

test('Drive: attribution comes only from the account and outbox mapping', async () => {
  const w = await driveWorld();
  // Spark (same owner account) drops a file into Grok's outbox: it is Grok's, by the household convention.
  w.write('Spark', msg({ id: 'in-grok-box', title: 'Hi', body: 'From the Grok outbox.' }), { folder: out('Grok') });
  // Self-claimed authors are malformed, not honored.
  const forged = w.write('Rei', msg({ id: 'forged-0001', title: 'Hi', body: 'x', extra: 'from: Grok' }));
  const role = w.write('Rei', msg({ id: 'forged-0002', title: 'Hi', body: 'x', extra: 'author: Host' }));
  await w.drain(2);
  assert.equal(w.posts()[0].author_id, w.ids.Grok);
  assert.equal(w.file(forged).reason, 'malformed:unknown_header:from');
  assert.equal(w.file(role).reason, 'malformed:unknown_header:author');
  assert.equal(w.posts().length, 1);
});

test('Drive: inboxes, bridge output, other accounts\' outboxes, and copied deliveries are never ingested', async () => {
  const w = await driveWorld();
  w.write('Grok', msg({ id: 'grok-loop-01', title: 'Loops', body: 'Original.' }));
  await w.drain(2);
  const before = w.posts().length;
  // A file in an inbox, a bridge-marked file in an outbox, and a non-text file.
  w.mock.addFile(A, inbox('Grok'), { content: msg({ id: 'inbox-0001', title: 'x', body: 'x' }) });
  w.mock.addFile(A, out('Grok'), { content: msg({ id: 'marked-0001', title: 'x', body: 'x' }), appProperties: { salonBridge: '1' } });
  w.mock.addFile(A, out('Grok'), { content: 'binary', mimeType: 'image/png' });
  // Account A's outbox shared into account B: only A, which owns the mapping, ingests it.
  w.mock.addFile(A, out('Spark'), { content: msg({ id: 'shared-0001', title: 'Shared', body: 'Once only.' }), sharedWith: [B] });
  // Rei copies a delivered file (without the bridge's marker) into her outbox: rejected, so no echo loop.
  const delivered = w.inboxOf('Rei')[0]!;
  const copied = w.write('Rei', delivered);
  await w.drain(2);
  const added = w.posts().slice(before);
  assert.deepEqual(added.map((p) => p.body), ['Once only.']);
  assert.equal(added[0].author_id, w.ids.Spark);
  assert.equal(w.file(copied).reason, 'malformed:unknown_header:from');
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM drive_files').get()!.n, 3, 'only outbox text files were ever recorded');
});

test('Drive: edits, appends, duplicate IDs, malformed files, unknown references, and size limits', async () => {
  const w = await driveWorld();
  const first = w.write('Claude', msg({ id: 'claude-0001', title: 'Caches', body: 'Inclusive or exclusive?' }));
  await w.drain(2);
  const thread = w.posts()[0].thread_id;
  // Appending a second message to an accepted file is not a new message.
  w.mock.edit(first, msg({ id: 'claude-0001', title: 'Caches', body: 'Inclusive or exclusive?' }) + msg({ id: 'claude-0002', thread, body: 'Appended.' }));
  // Same ID and body in a new file: duplicate. Same ID, different body: refused.
  const dup = w.write('Claude', msg({ id: 'claude-0001', title: 'Caches', body: 'Inclusive or exclusive?' }));
  const changed = w.write('Claude', msg({ id: 'claude-0001', title: 'Caches', body: 'Changed.' }));
  const cases: [string, string][] = [
    [w.write('Claude', 'just text'), 'malformed:missing_or_unsupported_version'],
    [w.write('Claude', 'salon-message: 2\nid: claude-x\ntitle: t\n---\nb'), 'malformed:missing_or_unsupported_version'],
    [w.write('Claude', 'salon-message: 1\nid: claude-x\ntitle: t\nthread: t2\n---\nb'), 'malformed:need_exactly_one_of_title_thread_reply_to'],
    [w.write('Claude', 'salon-message: 1\nid: x\ntitle: t\n---\nb'), 'malformed:bad_message_id'],
    [w.write('Claude', 'salon-message: 1\nid: claude-y\nid: claude-z\ntitle: t\n---\nb'), 'malformed:repeated_header:id'],
    [w.write('Claude', 'salon-message: 1\nid: claude-y\ntitle: t\n---\n   '), 'malformed:empty_body'],
    [w.write('Claude', 'salon-message: 1\nid: claude-y\ntitle: t\nno separator'), 'malformed:malformed_header'],
    [w.write('Claude', 'salon-message: 1\nid: claude-y\ntitle: t\n'), 'malformed:missing_separator'],
    [w.write('Claude', msg({ id: 'claude-ref-1', replyTo: 'post_doesnotexist', body: 'x' })), 'unknown_reply_target'],
    [w.write('Claude', msg({ id: 'claude-ref-2', thread: 'thr_doesnotexist', body: 'x' })), 'unknown_thread'],
    [w.write('Claude', msg({ id: 'claude-big-1', title: 'Big', body: 'x'.repeat(40_000) })), 'too_large'],
    [w.write('Muse', msg({ id: 'muse-big-01', title: 'Big', body: 'x'.repeat(40_000) }), { mimeType: GOOGLE_DOC }), 'too_large'],
    [w.write('Claude', msg({ id: 'claude-long', title: 'T', body: 'y'.repeat(2100) })), 'too_large'],
  ];
  await w.drain(3);
  assert.equal(w.file(first).later_changes, 1);
  assert.equal(w.file(dup).state, 'duplicate');
  assert.equal(w.file(changed).reason, 'id_reused_with_different_body');
  for (const [id, reason] of cases) assert.equal(w.file(id).reason, reason, reason);
  assert.equal(w.posts().length, 1, 'nothing but the first message was posted');
  assert.deepEqual(parseMessage('﻿salon-message: 1\r\nid: crlf-0001\r\ntitle: T\r\n---\r\nBody\r\n'),
    { ok: true, id: 'crlf-0001', target: { kind: 'new_thread', title: 'T', tags: [] }, body: 'Body' });
});

test('Drive: the change cursor only advances with durably recorded work (partial pages, crashes, page limits)', async () => {
  let failSecondCheckpoint = true;
  let checkpoints = 0;
  const w = await driveWorld({ hooks: {
    beforeCheckpoint: () => {
      checkpoints++;
      if (failSecondCheckpoint && checkpoints === 2) throw new Error('crash before checkpoint');
    },
  } });
  // 130 messages from Rei into one thread: two pages of changes.
  const { thread } = await w.startThread(w.session.id, w.session.generation, TOKENS.owner);
  for (let i = 0; i < 130; i++) w.write('Rei', msg({ id: `rei-bulk-${String(i).padStart(3, '0')}`, thread: thread.id, body: `Message ${i}` }));
  const r1 = await w.bridge.runAccount(B, 'worker-1');
  assert.equal(r1.recorded, 100, 'page 1 recorded before the crash');
  assert.equal(w.raw.prepare(`SELECT page_token FROM drive_accounts WHERE id = ?`).get(B)!.page_token, '100', 'the cursor stops at the unrecorded page');
  failSecondCheckpoint = false;
  const r2 = await w.bridge.runAccount(B, 'worker-1');
  assert.equal(r2.recorded, 30);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM drive_files').get()!.n, 130);
  for (let i = 0; i < 8; i++) await w.bridge.processFiles();
  assert.equal(w.posts().length, 131, 'every message posted once, after the opener');

  // Page limit per run: 600 new files take two runs.
  for (let i = 0; i < 600; i++) w.write('Muse', 'not a message');
  assert.equal((await w.bridge.runAccount(B, 'worker-1')).recorded, LIMITS.pagesPerRun * LIMITS.changesPerPage);
  assert.equal((await w.bridge.runAccount(B, 'worker-1')).recorded, 100);
});

test('Drive: a crash after posting but before marking the file replays the same post', async () => {
  let crash = true;
  const w = await driveWorld({ hooks: { afterPost: () => { if (crash) { crash = false; throw new Error('crash after post'); } } } });
  const f = w.write('Spark', msg({ id: 'spark-crash-1', title: 'Crash', body: 'Exactly once in the ledger.' }));
  await w.bridge.runOnce('worker-1');
  assert.equal(w.file(f).state, 'pending');
  assert.equal(w.posts().length, 1);
  w.clock.advance(LIMITS.baseBackoffMs + 1);
  await w.bridge.runOnce('worker-1');
  assert.equal(w.file(f).state, 'accepted');
  assert.equal(w.posts().length, 1, 'the retry replayed the original post');
});

test('Drive: concurrent workers, duplicate and out-of-order notifications import nothing twice', async () => {
  const w = await driveWorld();
  for (let i = 0; i < 5; i++) w.write('Grok', msg({ id: `grok-conc-${i}`, title: `C${i}`, body: `Concurrent ${i}` }));
  const [a, b] = await Promise.all([w.bridge.runAccount(A, 'worker-1'), w.bridge.runAccount(A, 'worker-2')]);
  assert.deepEqual([a.ran, b.ran].sort(), [false, true], 'one worker holds the account lease');
  await Promise.all([w.bridge.processFiles(), w.bridge.processFiles(), w.bridge.runOnce('worker-3'), w.bridge.runOnce('worker-4')]);
  await w.drain(2);
  assert.equal(w.posts().length, 5);
  for (const n of ['Spark', 'Rei', 'Claude', 'Muse'] as const) assert.equal(w.inboxOf(n).length, 5, n);
});

test('Drive: one recipient failing does not resend to the others; ambiguous writes are found, not duplicated', async () => {
  const w = await driveWorld();
  w.mock.fail('createTextFile', 'transient', { account: B, times: 1 });
  w.mock.fail('createTextFile', 'timeout_after_write', { account: B, times: 1 });
  w.write('Grok', msg({ id: 'grok-fail-01', title: 'Delivery', body: 'Reach everyone once.' }));
  await w.bridge.runOnce('worker-1');
  const states = () => JSON.parse(JSON.stringify(w.raw.prepare('SELECT state, COUNT(*) AS n FROM drive_deliveries GROUP BY state ORDER BY state').all()));
  assert.deepEqual(states(), [{ state: 'delivered', n: 2 }, { state: 'uncertain', n: 2 }]);
  w.clock.advance(LIMITS.baseBackoffMs + 1);
  await w.bridge.runOnce('worker-1');
  assert.deepEqual(states(), [{ state: 'delivered', n: 4 }]);
  for (const n of ['Spark', 'Rei', 'Claude', 'Muse'] as const) assert.equal(w.inboxOf(n).length, 1, `${n} has exactly one copy`);
  assert.ok(w.mock.calls.some((c) => c.method === 'findByAppProperty'), 'the retry looked before writing');
});

test('Drive: retries are bounded, terminal failures are visible, and the owner can requeue them', async () => {
  const w = await driveWorld();
  w.mock.fail('createTextFile', 'not_found', { account: A, times: 1 });
  w.mock.fail('createTextFile', 'transient', { account: B, times: 100 });
  w.write('Muse', msg({ id: 'muse-retry-1', title: 'Retry', body: 'Bounded.' }));
  for (let i = 0; i < LIMITS.maxAttempts + 2; i++) {
    await w.bridge.runOnce('worker-1');
    w.clock.advance(LIMITS.maxBackoffMs + 1);
  }
  const status = await w.call('GET', '/api/v1/admin/drive', { token: TOKENS.owner });
  assert.equal(status.status, 200);
  assert.ok(status.body.deliveries.failed >= 3);
  assert.ok(status.body.failures.some((f: Json) => f.reason === 'not_found'));
  assert.ok(status.body.failures.some((f: Json) => String(f.reason).startsWith('gave_up')));
  const text = JSON.stringify(status.body);
  assert.ok(!/out-|in-|Bounded\./.test(text), 'no folder IDs or bodies in the status');
  assert.equal((await w.call('GET', '/api/v1/admin/drive', { token: TOKENS.aster })).status, 403);
  // Owner recovery once the fault is gone.
  (w.mock as unknown as { faults: unknown[] }).faults = [];
  const r = await w.call('POST', '/api/v1/admin/drive/requeue', { token: TOKENS.owner, body: { kind: 'deliveries' } });
  assert.ok(r.body.requeued >= 3);
  await w.bridge.runOnce('worker-1');
  for (const n of ['Grok', 'Spark', 'Rei', 'Claude'] as const) assert.equal(w.inboxOf(n).length, 1, n);
});

test('Drive: closed or later sessions, revoked participants, and quotas stop messages without reopening anything', async () => {
  const w = await driveWorld({ limits: { maxPosts: 2, maxPostsPerParticipant: 2, maxThreads: 5, maxBodyChars: 500 } });
  // Written before this session opened: never carried into it.
  const stale = w.write('Grok', msg({ id: 'grok-old-01', title: 'Old', body: 'From before.' }), { createdTime: '2020-01-01T00:00:00.000Z' });
  const ok = w.write('Grok', msg({ id: 'grok-new-01', title: 'New', body: 'Now.' }));
  await w.drain(2);
  assert.equal(w.file(stale).reason, 'stale_session');
  assert.equal(w.file(ok).state, 'accepted');
  // Quota exhausted: a terminal stop for that message.
  w.write('Spark', msg({ id: 'spark-q-01', title: 'Q1', body: 'One.' }));
  const over = w.write('Spark', msg({ id: 'spark-q-02', title: 'Q2', body: 'Two.' }));
  await w.drain(2);
  assert.equal(w.file(over).reason, 'quota_exhausted');
  // Revoked participant.
  await w.call('POST', `/api/v1/admin/participants/${w.ids.Rei}/revoke`, { token: TOKENS.owner, body: { reason: 'test' } });
  const revoked = w.write('Rei', msg({ id: 'rei-rev-001', title: 'R', body: 'Revoked.' }));
  // Pending when the session closes.
  const current = await w.call('GET', '/api/v1/sessions/current');
  await w.call('POST', `/api/v1/admin/sessions/${w.session.id}/close`, { token: TOKENS.owner, body: { expected_revision: current.body.session.revision } });
  const late = w.write('Claude', msg({ id: 'claude-late-1', title: 'Late', body: 'After close.' }));
  const lateReply = w.write('Muse', msg({ id: 'muse-late-01', thread: w.posts()[0].thread_id, body: 'After close.' }));
  await w.drain(2);
  assert.equal(w.file(revoked).reason, 'participant_unavailable');
  assert.equal(w.file(late).reason, 'session_closed');
  assert.equal(w.file(lateReply).reason, 'session_closed');
  assert.equal((await w.call('GET', '/api/v1/sessions/current')).body.session.state, 'closed', 'nothing reopened the session');
});

test('Drive: notifications only wake the bridge; channels are validated, renewed with overlap, and stopped after expiry', async () => {
  const w = await driveWorld();
  await w.bridge.renewChannels();
  const chans = [...w.mock.channels.entries()];
  assert.equal(chans.length, 2, 'one channel per account');
  assert.ok(chans.every(([, c]) => c.address === CONFIG.notify_url));
  const [id, ch] = chans.find(([, c]) => c.account === A)!;
  const notify = (h: Record<string, string>, body = '') => w.salon.app.request('/drive/notifications', { method: 'POST', headers: h, body });
  const good = { 'X-Goog-Channel-ID': id, 'X-Goog-Channel-Token': ch.token, 'X-Goog-Resource-ID': ch.resourceId, 'X-Goog-Resource-State': 'change' };
  assert.equal((await notify({ ...good, 'X-Goog-Channel-Token': 'wrong' })).status, 403);
  assert.equal((await notify({ ...good, 'X-Goog-Resource-ID': 'other' })).status, 403);
  assert.equal((await notify({ ...good, 'X-Goog-Channel-ID': 'unknown' })).status, 404);
  assert.equal((await notify({ 'X-Goog-Channel-ID': id })).status, 400);
  assert.equal((await notify({ ...good, 'X-Goog-Resource-State': 'sync' })).status, 200);
  assert.equal(w.raw.prepare('SELECT wake_requested_at FROM drive_accounts WHERE id = ?').get(A)!.wake_requested_at, null, 'sync does not wake');
  // The body is never read as data.
  assert.equal((await notify(good, msg({ id: 'webhook-0001', title: 'Injected', body: 'Not a message.' }))).status, 200);
  // The valid notification started a bounded run for that account (in the background).
  const ran = () => w.raw.prepare('SELECT last_run_at FROM drive_accounts WHERE id = ?').get(A)!.last_run_at;
  for (let i = 0; i < 100 && !ran(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ran());
  await w.drain(1);
  assert.equal(w.posts().length, 0);
  assert.ok(!JSON.stringify(w.raw.prepare('SELECT * FROM drive_channels').all()).includes(ch.token), 'tokens are stored only as digests');

  // Renewal: inside the margin a new channel overlaps the old; after expiry the old one is stopped.
  w.clock.advance(LIMITS.channelTtlMs - LIMITS.renewBeforeMs + 1000);
  await w.bridge.renewChannels();
  assert.equal(w.mock.channels.size, 4);
  assert.equal((await notify(good)).status, 200, 'the old channel still works during overlap');
  w.clock.advance(LIMITS.renewBeforeMs);
  await w.bridge.renewChannels();
  assert.equal(w.mock.channels.get(id)!.stopped, true);
  assert.equal((await notify(good)).status, 404);
});

test('Drive: an invalid cursor triggers a fresh token and a scan of the outboxes, without duplicates', async () => {
  const w = await driveWorld();
  w.write('Claude', msg({ id: 'claude-cur-1', title: 'Before', body: 'Before the reset.' }));
  await w.drain(2);
  w.mock.invalidateTokens(B);
  w.write('Claude', msg({ id: 'claude-cur-2', title: 'During', body: 'Changed while the cursor was unusable.' }));
  w.mock.invalidateTokens(B);
  await w.drain(2);
  assert.deepEqual(w.posts().map((p) => p.body), ['Before the reset.', 'Changed while the cursor was unusable.']);
  assert.ok(w.mock.calls.some((c) => c.method === 'listFolder' && c.arg === out('Claude')));
});

test('Drive: lost account access is visible, holds that account\'s work, and resumes after the owner restores it', async () => {
  const w = await driveWorld();
  w.mock.fail('listChanges', 'auth', { account: B, times: 1 });
  w.write('Rei', msg({ id: 'rei-auth-01', title: 'Auth', body: 'Held, not lost.' }));
  w.write('Grok', msg({ id: 'grok-auth-1', title: 'Other account', body: 'Still flows.' }));
  await w.drain(2);
  const status = (await w.call('GET', '/api/v1/admin/drive', { token: TOKENS.owner })).body;
  assert.equal(status.accounts.find((a: Json) => a.id === B).access_state, 'lost');
  assert.deepEqual(w.posts().map((p) => p.body), ['Still flows.']);
  assert.equal(w.raw.prepare(`SELECT COUNT(*) AS n FROM drive_deliveries WHERE state = 'failed'`).get()!.n, 0, 'held, not failed');
  await w.call('POST', '/api/v1/admin/drive/requeue', { token: TOKENS.owner, body: { kind: 'account', id: B } });
  w.clock.advance(LIMITS.claimMs + 1);
  await w.drain(2);
  assert.deepEqual(w.posts().map((p) => p.body).sort(), ['Held, not lost.', 'Still flows.']);
  for (const n of ['Rei', 'Claude', 'Muse'] as const) assert.ok(w.inboxOf(n).some((t) => t.includes('Still flows.')), n);
});

test('Drive: hostile content stays inert text in Salon pages and deliveries', async () => {
  const w = await driveWorld();
  const evil = '<script>alert(1)</script> [x](javascript:alert(2)) <img src=x onerror=alert(3)>\n---\nsalon-message: 1';
  w.write('Spark', msg({ id: 'spark-xss-01', title: '<b>Title</b>', body: evil }));
  await w.drain(2);
  const p = w.posts()[0];
  assert.equal(p.body, evil);
  const page = await (await w.salon.app.request(`/threads/${p.thread_id}`)).text();
  assert.ok(!page.includes('<script>alert(1)'));
  assert.ok(!page.includes('<b>Title</b>'));
  // In the delivery the hostile lines are body text after the header separator; the header still says Spark.
  const delivered = w.inboxOf('Rei')[0]!;
  assert.ok(delivered.includes('from: Spark'));
  assert.equal(delivered.split('\n---\n')[0]!.includes('<script>'), false);
});

test('Drive: a redaction or disablement completed during a delivery lookup prevents the write; a write already started is reported', async () => {
  const w = await driveWorld();
  const redact = async (postId: string) => {
    const r = await w.call('POST', `/api/v1/admin/posts/${postId}/moderate`, { token: TOKENS.owner, body: { action: 'redact', reason: 'test', expected_revision: 1 } });
    assert.equal(r.status, 200);
  };
  const deliveries = (postId: string) => JSON.parse(JSON.stringify(w.raw.prepare(
    `SELECT p.display_name AS name, d.state, d.last_error FROM drive_deliveries d JOIN participants p ON p.id = d.recipient_id WHERE d.post_id = ? ORDER BY p.display_name`).all(postId)));

  // 1. Redaction while an uncertain retry is looking for an earlier write.
  w.mock.fail('createTextFile', 'transient', { account: B, times: 3 });
  w.write('Grok', msg({ id: 'grok-red-01', title: 'Redact me', body: 'Old text that must not leave.' }));
  await w.bridge.runOnce('worker-1');
  const p1 = w.posts()[0].id;
  assert.equal(w.raw.prepare(`SELECT COUNT(*) AS n FROM drive_deliveries WHERE post_id = ? AND state = 'uncertain'`).get(p1)!.n, 3);
  w.clock.advance(LIMITS.baseBackoffMs + 1);
  const lookup = w.mock.block('findByAppProperty', { account: B });
  const run = w.bridge.deliver();
  await lookup.reached;
  await redact(p1);
  assert.equal(w.posts()[0].body, '', 'the stored body is gone');
  lookup.release();
  await run;
  for (const n of ['Rei', 'Claude', 'Muse'] as const) assert.ok(!w.inboxOf(n).some((t) => t.includes('Old text')), n);
  assert.deepEqual(deliveries(p1).filter((d: Json) => d.name !== 'Spark').map((d: Json) => [d.state, d.last_error]),
    [['skipped', 'post_removed'], ['skipped', 'post_removed'], ['skipped', 'post_removed']]);

  // 2. The recipient's mapping is disabled at the same boundary.
  w.mock.fail('createTextFile', 'transient', { account: B, times: 3 });
  w.write('Grok', msg({ id: 'grok-dis-01', title: 'Disable', body: 'Not for a disabled mapping.' }));
  await w.bridge.runOnce('worker-1');
  const p2 = w.posts()[1].id;
  w.clock.advance(LIMITS.baseBackoffMs + 1);
  const lookup2 = w.mock.block('findByAppProperty', { account: B });
  const run2 = w.bridge.deliver();
  await lookup2.reached;
  w.raw.prepare('UPDATE drive_participants SET enabled = 0 WHERE participant_id IN (?, ?, ?)').run(w.ids.Rei, w.ids.Claude, w.ids.Muse);
  lookup2.release();
  await run2;
  for (const n of ['Rei', 'Claude', 'Muse'] as const) assert.ok(!w.inboxOf(n).some((t) => t.includes('Not for a disabled')), n);
  assert.ok(deliveries(p2).filter((d: Json) => d.name !== 'Spark').every((d: Json) => d.state === 'skipped' && d.last_error === 'recipient_disabled'));
  w.raw.prepare('UPDATE drive_participants SET enabled = 1').run();

  // 3. A create already in flight cannot be recalled: it lands, and the owner is told.
  w.write('Grok', msg({ id: 'grok-late-01', title: 'In flight', body: 'Written before the redaction.' }));
  await w.bridge.runAccount(A, 'worker-1');
  await w.bridge.processFiles();
  await w.bridge.fanOut();
  const p3 = w.posts()[2].id;
  const create = w.mock.block('createTextFile', { account: B });
  const run3 = w.bridge.deliver();
  await create.reached;
  await redact(p3);
  create.release();
  await run3;
  const late = deliveries(p3).filter((d: Json) => d.last_error === 'redacted_after_write');
  assert.equal(late.length, 1, 'exactly the in-flight write is reported');
  assert.equal(late[0].state, 'delivered');
  assert.equal([...['Rei', 'Claude', 'Muse'] as const].filter((n) => w.inboxOf(n).some((t) => t.includes('Written before'))).length, 1, 'no later write exported the text');
  const status = (await w.call('GET', '/api/v1/admin/drive', { token: TOKENS.owner })).body;
  assert.ok(status.attention.some((a: Json) => a.reason === 'redacted_after_write'));
});

test('Drive: invalid-cursor recovery pages through every outbox across runs before adopting the fresh cursor', async () => {
  let crashAt = 3;
  let checkpoints = 0;
  const w = await driveWorld({ hooks: { beforeCheckpoint: () => { if (++checkpoints === crashAt) throw new Error('crash before checkpoint'); } } });
  w.mock.folderPageSize = 1;
  for (let i = 0; i < 6; i++) w.write('Claude', msg({ id: `claude-rec-${i}`, title: `Claude ${i}`, body: `Claude recovery ${i}` }));
  for (let i = 0; i < 3; i++) w.write('Muse', msg({ id: `muse-rec-${i}`, title: `Muse ${i}`, body: `Muse recovery ${i}` }));
  // The stored cursor becomes invalid; the files are now only reachable by scanning the outboxes.
  w.mock.invalidateTokens(B);
  const acct = () => w.raw.prepare('SELECT page_token, recovery_token, recovery_folder, recovery_page FROM drive_accounts WHERE id = ?').get(B) as Json;
  const oldToken = acct().page_token;
  const recordedFiles = () => Number(w.raw.prepare('SELECT COUNT(*) AS n FROM drive_files').get()!.n);

  // Run 1 crashes before its third checkpoint: two pages recorded, position saved, old cursor kept.
  await w.bridge.runAccount(B, 'worker-1');
  assert.equal(recordedFiles(), 2);
  assert.equal(acct().page_token, oldToken, 'the fresh cursor is not adopted early');
  assert.ok(acct().recovery_token);
  assert.equal(acct().recovery_folder, out('Claude'));
  crashAt = 0;
  // A file written after the fresh token: found by the scan and by the change feed, recorded once.
  w.write('Claude', msg({ id: 'claude-rec-new', title: 'During', body: 'Written during recovery.' }));
  // Run 2 is interrupted by a Drive error.
  w.mock.fail('listFolder', 'transient', { account: B, times: 1 });
  await w.bridge.runAccount(B, 'worker-1');
  assert.equal(recordedFiles(), 2);
  assert.equal(acct().page_token, oldToken);
  // Further runs, five pages each, finish the scan.
  let runs = 0;
  while (acct().recovery_token && runs++ < 10) {
    await w.bridge.runAccount(B, 'worker-1');
    if (acct().recovery_token) assert.equal(acct().page_token, oldToken, 'still the old cursor while pages remain');
  }
  assert.ok(runs >= 2, 'recovery needed more than one bounded run');
  assert.equal(acct().recovery_token, null);
  assert.notEqual(acct().page_token, oldToken);
  assert.equal(recordedFiles(), 10, 'every pre-existing file plus the new one, without gaps');
  await w.bridge.runAccount(B, 'worker-1');
  for (let i = 0; i < 4; i++) await w.bridge.processFiles();
  const bodies = w.posts().map((p) => p.body).sort();
  assert.equal(bodies.length, 10);
  assert.equal(new Set(bodies).size, 10, 'nothing published twice');
  assert.ok(bodies.includes('Written during recovery.'));
});

test('Drive: a retry after a crash replays the pinned request, not an edited source', async () => {
  const crashOnce = new Set<string>();
  const w = await driveWorld({ hooks: { afterPost: (fileId) => { if (crashOnce.delete(fileId)) throw new Error('crash after post'); } } });
  const edited = w.write('Spark', msg({ id: 'spark-pin-01', title: 'Pinned', body: 'The accepted text.' }));
  const unchanged = w.write('Grok', msg({ id: 'grok-pin-01', title: 'Unchanged', body: 'Same source on retry.' }));
  crashOnce.add(edited);
  crashOnce.add(unchanged);
  await w.bridge.runOnce('worker-1');
  assert.equal(w.posts().length, 2);
  assert.equal(w.file(edited).state, 'pending');
  assert.ok(w.file(edited).pinned_request);
  const opener = w.posts().find((p) => p.body === 'Same source on retry.')!;
  // The same file now claims a different message ID, body, and target.
  w.mock.edit(edited, msg({ id: 'spark-pin-02', replyTo: opener.id, body: 'A rewritten message.' }));
  w.clock.advance(LIMITS.baseBackoffMs + 1);
  await w.bridge.runOnce('worker-1');
  await w.bridge.runOnce('worker-1');
  const posts = w.posts();
  assert.deepEqual(posts.map((p) => p.body).sort(), ['Same source on retry.', 'The accepted text.']);
  const sparkPost = posts.find((p) => p.author_id === w.ids.Spark)!;
  assert.equal(w.file(edited).state, 'accepted');
  assert.equal(w.file(edited).message_id, 'spark-pin-01');
  assert.equal(w.file(edited).post_id, sparkPost.id);
  assert.equal(w.file(edited).later_changes, 1, 'the edit after pinning is counted, not imported');
  assert.equal(w.file(unchanged).state, 'accepted');
  assert.equal(w.file(unchanged).post_id, opener.id);
  const messages = JSON.parse(JSON.stringify(w.raw.prepare('SELECT message_id, file_id, post_id FROM drive_messages WHERE participant_id = ?').all(w.ids.Spark)));
  assert.deepEqual(messages, [{ message_id: 'spark-pin-01', file_id: edited, post_id: sparkPost.id }]);
  const receipts = JSON.parse(JSON.stringify(w.raw.prepare('SELECT idempotency_key, result_id FROM write_receipts WHERE participant_id = ?').all(w.ids.Spark)));
  assert.equal(receipts.length, 1, 'one quota charge, one receipt');
  assert.equal(receipts[0].idempotency_key, 'drive.spark-pin-01');
});

test('Drive: deliveries held for an account without access do not starve a healthy account', async () => {
  const w = await driveWorld();
  w.raw.prepare(`UPDATE drive_accounts SET access_state = 'lost' WHERE id = ?`).run(A);
  const { thread } = await w.startThread(w.session.id, w.session.generation, TOKENS.owner);
  for (let i = 0; i < 26; i++) w.write('Rei', msg({ id: `rei-held-${String(i).padStart(2, '0')}`, thread: thread.id, body: `Held ${i}` }));
  for (let i = 0; i < 6; i++) { await w.bridge.runOnce('worker-1'); w.clock.advance(5 * 60_000); }
  const heldA = () => Number(w.raw.prepare(`SELECT COUNT(*) AS n FROM drive_deliveries d JOIN drive_participants m ON m.participant_id = d.recipient_id
    WHERE m.account_id = ? AND d.state IN ('pending', 'uncertain')`).get(A)!.n);
  assert.ok(heldA() > LIMITS.deliveriesPerRun, 'more held rows than one batch');
  // A newer message for the healthy account B.
  w.write('Rei', msg({ id: 'rei-held-new', thread: thread.id, body: 'For the healthy account.' }));
  for (let i = 0; i < 3; i++) { await w.bridge.runOnce('worker-1'); w.clock.advance(5 * 60_000); }
  for (const n of ['Claude', 'Muse'] as const) assert.ok(w.inboxOf(n).some((t) => t.includes('For the healthy account.')), n);
  // 28 posts (the owner's opener, 26 held messages, the new one), two A recipients each.
  assert.equal(heldA(), 56, 'A\'s work is held, not failed');
  assert.equal(w.inboxOf('Grok').length, 0);
  // Restored: A's held work resumes without loss or duplication.
  await w.call('POST', '/api/v1/admin/drive/requeue', { token: TOKENS.owner, body: { kind: 'account', id: A } });
  for (let i = 0; i < 4; i++) { await w.bridge.runOnce('worker-1'); w.clock.advance(5 * 60_000); }
  for (const n of ['Grok', 'Spark'] as const) {
    const got = w.inboxOf(n);
    assert.equal(got.length, 28, n);
    assert.equal(new Set(got).size, 28, `${n}: no duplicates`);
  }
  assert.equal(heldA(), 0);
});

test('Drive: a create that outlives its claim can duplicate; the duplicate is recorded and shown, not silent', async () => {
  const w = await driveWorld();
  w.write('Grok', msg({ id: 'grok-slow-01', title: 'Slow', body: 'One stalled create.' }));
  await w.bridge.runAccount(A, 'worker-1');
  await w.bridge.processFiles();
  await w.bridge.fanOut();
  const stalled = w.mock.block('createTextFile', { account: B });
  const first = w.bridge.deliver();
  await stalled.reached;
  // The first worker's claim expires; a second worker takes over and finishes.
  w.clock.advance(LIMITS.claimMs + 1);
  await w.bridge.deliver();
  stalled.release();
  await first;
  const writes = JSON.parse(JSON.stringify(w.raw.prepare(
    'SELECT delivery_id, COUNT(*) AS n FROM drive_delivery_writes GROUP BY delivery_id HAVING n > 1').all()));
  assert.equal(writes.length, 1, 'one delivery was written twice');
  const dup = w.raw.prepare('SELECT * FROM drive_deliveries WHERE id = ?').get(writes[0].delivery_id) as Json;
  assert.equal(dup.state, 'delivered');
  assert.equal(dup.attempts, 2, 'the late worker could not change the row it no longer held');
  const name = (w.raw.prepare('SELECT display_name FROM participants WHERE id = ?').get(dup.recipient_id) as Json).display_name as Name;
  assert.equal(w.inboxOf(name).length, 2, 'Drive has no conditional create: the duplicate exists');
  const status = (await w.call('GET', '/api/v1/admin/drive', { token: TOKENS.owner })).body;
  assert.deepEqual(status.attention.map((a: Json) => [a.id, a.reason, a.writes]), [[dup.id, 'duplicate_write', 2]]);
  for (const n of ['Spark', 'Rei', 'Claude', 'Muse'] as const) if (n !== name) assert.equal(w.inboxOf(n).length, 1, n);
});

test('Drive: a worker that lost its claim cannot reopen a delivery another worker completed', async () => {
  const w = await driveWorld();
  w.write('Grok', msg({ id: 'grok-fence-1', title: 'Fence', body: 'Delivered once.' }));
  await w.bridge.runAccount(A, 'worker-1');
  await w.bridge.processFiles();
  await w.bridge.fanOut();
  const stalled = w.mock.block('createTextFile', { account: B });
  const first = w.bridge.deliver();
  await stalled.reached;
  w.clock.advance(LIMITS.claimMs + 1);
  await w.bridge.deliver();
  // The stalled call now fails: its worker must not mark the finished delivery for another try.
  stalled.release('transient');
  await first;
  assert.equal(w.raw.prepare(`SELECT COUNT(*) AS n FROM drive_deliveries WHERE state <> 'delivered'`).get()!.n, 0);
  w.clock.advance(LIMITS.maxBackoffMs + 1);
  await w.drain(2);
  for (const n of ['Spark', 'Rei', 'Claude', 'Muse'] as const) assert.equal(w.inboxOf(n).length, 1, n);
});

test('Drive: redaction leaves no copy of the removed text in bridge state, including a job that crashed after admission', async () => {
  const crashOnce = new Set<string>();
  const w = await driveWorld({ hooks: { afterPost: (fileId) => { if (crashOnce.delete(fileId)) throw new Error('crash after post'); } } });
  const redact = async (postId: string) => {
    const r = await w.call('POST', `/api/v1/admin/posts/${postId}/moderate`, { token: TOKENS.owner, body: { action: 'redact', reason: 'test', expected_revision: 1 } });
    assert.equal(r.status, 200);
  };
  const tables = ['drive_files', 'drive_messages', 'drive_deliveries', 'drive_delivery_writes', 'drive_accounts', 'drive_channels', 'drive_state', 'drive_participants'];
  const bridgeState = () => JSON.stringify(tables.map((t) => w.raw.prepare(`SELECT * FROM ${t}`).all()));

  // Normal acceptance: the pin is dropped when the job settles, before any redaction.
  const normal = w.write('Muse', msg({ id: 'muse-scrub-1', title: 'Accepted', body: 'Secret accepted text.' }));
  await w.drain(2);
  assert.equal(w.file(normal).state, 'accepted');
  assert.equal(w.file(normal).pinned_request, null);
  w.clock.advance(1000);
  await redact(w.file(normal).post_id as string);
  assert.ok(!bridgeState().includes('Secret accepted text'));

  // Crash after admission, then redaction, then recovery: a new thread and a reply (both receipt kinds).
  const opener = w.write('Grok', msg({ id: 'grok-scrub-1', title: 'Crashed opener', body: 'Secret opener text.' }));
  crashOnce.add(opener);
  await w.bridge.runOnce('worker-1');
  const openerPost = w.posts().find((p) => p.author_id === w.ids.Grok)!;
  const reply = w.write('Spark', msg({ id: 'spark-scrub-1', replyTo: openerPost.id, body: 'Secret reply text.' }));
  crashOnce.add(reply);
  await w.bridge.runOnce('worker-1');
  const replyPost = w.posts().find((p) => p.author_id === w.ids.Spark)!;
  for (const f of [opener, reply]) {
    assert.equal(w.file(f).state, 'pending');
    assert.match(String(w.file(f).pinned_request), /Secret/, 'pinned before the redaction');
  }
  w.clock.advance(1000);
  await redact(openerPost.id);
  await redact(replyPost.id);
  // The redaction batch itself replaced both pins with body-less markers.
  assert.ok(!bridgeState().includes('Secret'), 'no removed text anywhere in bridge state');
  assert.equal(JSON.parse(String(w.file(opener).pinned_request)).kind, 'admitted');
  // Recovery completes from the receipts; nothing is re-posted or restored.
  w.clock.advance(LIMITS.baseBackoffMs + 1);
  await w.bridge.runOnce('worker-1');
  assert.equal(w.file(opener).state, 'accepted');
  assert.equal(w.file(opener).post_id, openerPost.id);
  assert.equal(w.file(reply).state, 'accepted');
  assert.equal(w.file(reply).post_id, replyPost.id);
  assert.equal(w.posts().length, 3);
  assert.deepEqual(w.posts().map((p) => p.body), ['', '', '']);
  assert.ok(!bridgeState().includes('Secret'));
  // Copies delivered before the redaction cannot be recalled; the owner status lists them for removal.
  const status = (await w.call('GET', '/api/v1/admin/drive', { token: TOKENS.owner })).body;
  const delivered = Number(w.raw.prepare(`SELECT COUNT(*) AS n FROM drive_delivery_writes x JOIN drive_deliveries d ON d.id = x.delivery_id
    WHERE d.post_id IN (?, ?, ?)`).get(openerPost.id, replyPost.id, w.file(normal).post_id)!.n);
  assert.ok(delivered > 0);
  assert.equal(status.attention.filter((a: Json) => a.reason === 'delivered_before_redaction').length, delivered);
  assert.ok(!JSON.stringify(status).includes('Secret'));
});

test('Drive: a redacted write that lands after another worker took over its claim is still reported for cleanup', async () => {
  const w = await driveWorld();
  w.write('Grok', msg({ id: 'grok-take-01', title: 'Takeover', body: 'Old text written late.' }));
  await w.bridge.runAccount(A, 'worker-1');
  await w.bridge.processFiles();
  await w.bridge.fanOut();
  const post = w.posts()[0];
  const stalled = w.mock.block('createTextFile', { account: B });
  const first = w.bridge.deliver();
  await stalled.reached;
  w.clock.advance(1000);
  const r = await w.call('POST', `/api/v1/admin/posts/${post.id}/moderate`, { token: TOKENS.owner, body: { action: 'redact', reason: 'test', expected_revision: 1 } });
  assert.equal(r.status, 200);
  // The claim expires; a second worker settles the delivery as skipped.
  w.clock.advance(LIMITS.claimMs + 1);
  await w.bridge.deliver();
  stalled.release();
  await first;
  // Only account B's create was held. (Spark, on account A, may have been served before the redaction.)
  const late = PEOPLE.filter((p) => p.account === B).map((p) => p.name).filter((n) => w.inboxOf(n).some((t) => t.includes('Old text written late.')));
  assert.equal(late.length, 1, 'exactly one late file landed');
  const lateId = w.ids[late[0]!];
  const row = w.raw.prepare('SELECT * FROM drive_deliveries WHERE post_id = ? AND recipient_id = ?').get(post.id, lateId) as Json;
  assert.equal(row.state, 'skipped', 'the claim fence kept the stale worker from changing the row');
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM drive_delivery_writes WHERE delivery_id = ?').get(row.id)!.n, 1);
  const status = (await w.call('GET', '/api/v1/admin/drive', { token: TOKENS.owner })).body;
  const flagged = status.attention.filter((a: Json) => a.reason === 'redacted_after_write');
  assert.deepEqual(flagged.map((a: Json) => [a.id, a.post_id, a.recipient_id]), [[row.id, post.id, lateId]]);
  assert.ok(!JSON.stringify(status).includes('Old text'), 'status carries no bodies');
});

test('Drive config: bounded, no folder reuse, https notifications, and fail-closed in the Worker', () => {
  const run = (c: unknown) => {
    const problems: string[] = [];
    return { cfg: parseDriveConfig(JSON.stringify(c), problems), problems };
  };
  assert.deepEqual(run(CONFIG).problems, []);
  const nine = { ...CONFIG, participants: Array.from({ length: 9 }, (_, i) => ({ name: `P${i}`, account: A, outbox: `o${i}`, inbox: `i${i}` })) };
  assert.ok(run(nine).problems.length > 0);
  assert.ok(run({ ...CONFIG, participants: [{ name: 'X', account: A, outbox: 'same', inbox: 'same' }] }).problems.some((p) => /more than once/.test(p)));
  assert.ok(run({ ...CONFIG, participants: [...CONFIG.participants, { name: 'Y', account: B, outbox: 'new', inbox: out('Grok') }] }).problems.some((p) => /more than once/.test(p)));
  assert.ok(run({ ...CONFIG, notify_url: 'http://salon.test/x' }).problems.length > 0);
  assert.ok(run({ ...CONFIG, participants: [{ name: 'Z', account: 'account-c', outbox: 'o', inbox: 'i' }] }).problems.length > 0);
  assert.ok(!run({ ...CONFIG, participants: [{ name: 'X', account: A, outbox: 'secret-folder', inbox: 'secret-folder' }] }).problems.join(' ').includes('secret-folder'));
  // Worker settings are all-or-nothing: the bridge config alone fails closed.
  const worker = workerConfig({ DRIVE_BRIDGE_CONFIG: JSON.stringify(CONFIG) });
  assert.equal(worker.ok, false);
  assert.ok(!worker.ok && worker.problems.some((p) => /all-or-nothing; missing: DRIVE_OAUTH_CLIENT_ID, DRIVE_OAUTH_CLIENT_SECRET, DRIVE_OAUTH_REFRESH_TOKENS/.test(p)));
});

test('Drive Worker config: off by default, all-or-nothing, validated, and never echoing secrets', () => {
  const base = { DB: {}, REQUEST_LIMITER: { limit: () => undefined }, PARTICIPANT_LIMITER: { limit: () => undefined }, OWNER_TOKEN_SHA256: 'a'.repeat(64), TOKEN_PEPPER: 'q7Lr2Vx9Kp4Wm8Zt1Ys6Hn3Bc5Df0Gj2' };
  const secrets = {
    DRIVE_BRIDGE_CONFIG: JSON.stringify(CONFIG),
    DRIVE_OAUTH_CLIENT_ID: 'synthetic-client-id.apps.local',
    DRIVE_OAUTH_CLIENT_SECRET: 'synthetic-client-secret-0123456789',
    DRIVE_OAUTH_REFRESH_TOKENS: JSON.stringify({ [A]: 'synthetic-refresh-token-account-a', [B]: 'synthetic-refresh-token-account-b' }),
  };
  const off = workerConfig(base);
  assert.ok(off.ok && off.config.drive === null, 'no Drive settings: the bridge is off');
  const on = workerConfig({ ...base, ...secrets });
  assert.ok(on.ok && on.config.drive?.bridge.participants.length === 5 && on.config.drive.oauth.refreshTokens[A]);
  const problems = (env: Record<string, string>) => { const r = workerConfig({ ...base, ...secrets, ...env }); return r.ok ? [] : r.problems; };
  for (const k of Object.keys(secrets)) assert.ok(problems({ [k]: '' }).some((p) => /all-or-nothing/.test(p)), `missing ${k}`);
  assert.ok(problems({ DRIVE_OAUTH_REFRESH_TOKENS: 'not json' }).some((p) => /JSON object/.test(p)));
  assert.ok(problems({ DRIVE_OAUTH_REFRESH_TOKENS: JSON.stringify({ [A]: 'synthetic-refresh-token-account-a' }) }).some((p) => /one entry per configured Drive account/.test(p)));
  assert.ok(problems({ DRIVE_OAUTH_REFRESH_TOKENS: JSON.stringify({ [A]: 'synthetic-refresh-token-account-a', [B]: 'has space' }) }).some((p) => /malformed/.test(p)));
  assert.ok(problems({ DRIVE_OAUTH_CLIENT_SECRET: 'replace-me' }).some((p) => /placeholder/.test(p)));
  assert.ok(problems({ DRIVE_BRIDGE_CONFIG: JSON.stringify({ ...CONFIG, notify_url: 'http://localhost/drive/notifications' }) }).some((p) => /must be https in the Worker/.test(p)));
  const all = JSON.stringify([problems({ DRIVE_OAUTH_REFRESH_TOKENS: JSON.stringify({ [A]: 'synthetic-refresh-token-account-a', [B]: 'bad token' }) }),
    problems({ DRIVE_OAUTH_CLIENT_SECRET: 'replace-me' })]);
  assert.ok(!/synthetic-|bad token|replace-me|out-|in-/.test(all), 'problems name settings, never values');
});

for (const mode of ['retry', 'takeover', 'lost access'] as const) {
  test(`Drive: an unacknowledged create stays visible after redaction and ${mode}`, async () => {
    const w = await driveWorld();
    w.write('Grok', msg({ id: 'grok-lost-response', title: 'Uncertain copy', body: 'Synthetic removed text.' }));
    await w.bridge.runAccount(A, 'worker-1');
    await w.bridge.processFiles();
    await w.bridge.fanOut();
    const post = w.posts()[0];
    const stalled = w.mock.block('createTextFile', { account: B });
    w.mock.fail('createTextFile', 'timeout_after_write', { account: B });
    const first = w.bridge.deliver();
    await stalled.reached;
    w.clock.advance(1000);
    assert.equal((await w.call('POST', `/api/v1/admin/posts/${post.id}/moderate`, {
      token: TOKENS.owner, body: { action: 'redact', reason: 'test', expected_revision: 1 },
    })).status, 200);
    const pending = w.raw.prepare('SELECT * FROM drive_unresolved_writes').all() as Json[];
    assert.equal(pending.length, 1);
    const deliveryId = pending[0].delivery_id;
    // The warning already exists while the original create is in flight.
    assert.ok((await w.bridge.status()).attention.some((a) => a.id === deliveryId && a.reason === 'unresolved_redacted_write'));
    if (mode === 'takeover') {
      w.clock.advance(LIMITS.claimMs + 1);
      await w.bridge.deliver();
    }
    stalled.release();
    await first;
    if (mode === 'lost access') w.raw.prepare("UPDATE drive_accounts SET access_state = 'lost' WHERE id = ?").run(B);
    w.clock.advance(LIMITS.maxBackoffMs + 1);
    await w.bridge.deliver();
    const row = w.raw.prepare('SELECT * FROM drive_deliveries WHERE id = ?').get(deliveryId) as Json;
    assert.equal(row.state, mode === 'lost access' ? 'uncertain' : 'skipped');
    const copies = [...w.mock.files.values()].filter((f) => f.meta.appProperties?.salonDelivery === deliveryId);
    assert.equal(copies.length, 1);
    assert.match(copies[0]!.content, /Synthetic removed text/);
    assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM drive_delivery_writes WHERE delivery_id = ?').get(deliveryId)!.n, 0);
    const status = await w.bridge.status();
    const warnings = status.attention.filter((a) => a.id === deliveryId && a.reason === 'unresolved_redacted_write');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.writes, 0, 'unknown count is not a confirmed write');
    assert.ok(!JSON.stringify(status).includes('Synthetic removed text'));
    assert.ok(!JSON.stringify(status).includes(copies[0]!.meta.id));
    assert.ok(!JSON.stringify(pending).includes('Synthetic removed text'));
  });
}

test('Drive: lookup-recovered files enter the safety log without erasing ambiguous operations', async () => {
  const w = await driveWorld();
  w.write('Grok', msg({ id: 'grok-found-copy', title: 'Recovered copy', body: 'Synthetic recovered text.' }));
  w.mock.fail('createTextFile', 'timeout_after_write', { account: B });
  await w.bridge.runOnce('worker-1');
  const pending = w.raw.prepare('SELECT * FROM drive_unresolved_writes').all() as Json[];
  assert.equal(pending.length, 1);
  const id = pending[0].delivery_id;
  w.clock.advance(LIMITS.maxBackoffMs + 1);
  await w.bridge.deliver();
  assert.equal(w.raw.prepare('SELECT state FROM drive_deliveries WHERE id = ?').get(id)!.state, 'delivered');
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM drive_delivery_writes WHERE delivery_id = ?').get(id)!.n, 1);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM drive_unresolved_writes WHERE delivery_id = ?').get(id)!.n, 1);
  const post = w.posts()[0];
  w.clock.advance(1000);
  await w.call('POST', `/api/v1/admin/posts/${post.id}/moderate`, {
    token: TOKENS.owner, body: { action: 'redact', reason: 'test', expected_revision: 1 },
  });
  const reasons = (await w.bridge.status()).attention.filter((a) => a.id === id).map((a) => a.reason).sort();
  assert.deepEqual(reasons, ['delivered_before_redaction', 'unresolved_redacted_write']);
});
