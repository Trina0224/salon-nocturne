// The Drive v3 HTTP adapter and token provider, against recorded fetch stubs
// and a fake Google (test/drive-http-fake.ts) in front of MockDrive.
// Synthetic credentials and data only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriveError } from '../src/drive/client.ts';
import { DriveHttpClient, queryLiteral, DRIVE_API } from '../src/drive/http.ts';
import { RefreshTokenProvider, GOOGLE_TOKEN_URL, type AccessTokenProvider, type FetchLike } from '../src/drive/tokens.ts';
import { readCapped } from '../src/drive/http-body.ts';
import { parseDriveConfig } from '../src/drive/config.ts';
import { LIMITS } from '../src/drive/bridge.ts';
import { MockDrive } from './drive-mock.ts';
import { FakeGoogle, SYNTHETIC_OAUTH, googleError, GOOGLE_DOC } from './drive-http-fake.ts';
import { TOKENS, setup, type Json } from './helpers.ts';

const A = 'account-a';
const B = 'account-b';

const fixed = (token = 'synthetic-access'): AccessTokenProvider => ({ token: async () => token });
const ok = (v: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });

/** A fetch that records requests and answers from a queue. */
function recorder(answers: (Response | (() => Response | Promise<Response>))[]) {
  const seen: { url: URL; init: RequestInit; headers: Headers }[] = [];
  const fetch: FetchLike = async (input, init) => {
    seen.push({ url: new URL(input), init, headers: new Headers(init.headers) });
    const a = answers.shift();
    if (!a) throw new Error('no answer queued');
    return typeof a === 'function' ? a() : a;
  };
  return { fetch, seen };
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    assert.ok(err instanceof DriveError, String(err));
    return `${err.kind}:${err.message}`;
  }
}

const FILE = { id: 'f1', name: 'm.txt', mimeType: 'text/plain', parents: ['out-1'], size: '12', trashed: false, createdTime: '2026-10-01T00:00:00.000Z', modifiedTime: '2026-10-01T00:00:00.000Z' };

test('Drive HTTP: request contracts for every DriveClient method', async () => {
  const r = recorder([
    ok({ startPageToken: '41' }),
    ok({ nextPageToken: '42', changes: [{ fileId: 'f1', removed: false, file: FILE }, { fileId: 'f2', removed: true }] }),
    ok(FILE),
    new Response('salon-message: 1'),
    new Response('\uFEFFdoc text'),
    ok({ files: [FILE], nextPageToken: 'p2' }),
    ok({ id: 'new-file' }),
    ok({ files: [{ id: 'found' }] }),
    ok({ resourceId: 'res-1', expiration: '1790000000000' }),
    new Response(null, { status: 204 }),
  ]);
  const c = new DriveHttpClient({ accountId: A, tokens: fixed('synthetic-access-a'), fetch: r.fetch });
  assert.equal(await c.getStartPageToken(), '41');
  const page = await c.listChanges('41', 100);
  assert.deepEqual([page.nextPageToken, page.changes.length, page.changes[0]!.file!.size, page.changes[1]!.file], ['42', 2, 12, undefined]);
  assert.equal((await c.getFile('f1')).parents[0], 'out-1');
  assert.equal(await c.download('f1', 1024), 'salon-message: 1');
  assert.equal(await c.exportText('f1', 1024), 'doc text', 'UTF-8 decoding drops the byte-order mark (the parser would too)');
  assert.equal((await c.listFolder("o'1\\x", undefined)).nextPageToken, 'p2');
  assert.deepEqual(await c.createTextFile('in-1', 'salon-p.txt', 'body --x', { salonBridge: '1', salonDelivery: 'dlv_1' }), { id: 'new-file' });
  assert.deepEqual(await c.findByAppProperty('in-1', 'salonDelivery', 'dlv_1'), { id: 'found' });
  assert.deepEqual(await c.watchChanges('41', { id: 'ch_1', token: 'tok', address: 'https://salon.test/drive/notifications', expiration: 1_800_000_000_000 }),
    { resourceId: 'res-1', expiration: 1_790_000_000_000 });
  await c.stopChannel('ch_1', 'res-1');

  const [start, changes, get, media, exp, folder, create, find, watch, stop] = r.seen;
  for (const s of r.seen) {
    assert.equal(s.headers.get('authorization'), 'Bearer synthetic-access-a');
    assert.equal(s.init.redirect, 'manual', 'redirects are never followed');
    assert.ok(s.init.signal, 'every request has a timeout');
    assert.ok(s.url.origin === 'https://www.googleapis.com');
  }
  assert.equal(start!.url.pathname, '/drive/v3/changes/startPageToken');
  assert.equal(changes!.url.pathname, '/drive/v3/changes');
  assert.equal(changes!.url.searchParams.get('pageToken'), '41');
  assert.equal(changes!.url.searchParams.get('pageSize'), '100');
  assert.match(changes!.url.searchParams.get('fields')!, /^nextPageToken,newStartPageToken,changes\(fileId,removed,file\(id,name,mimeType,parents,size,trashed,appProperties,createdTime,modifiedTime\)\)$/);
  assert.equal(get!.url.pathname, '/drive/v3/files/f1');
  assert.equal(media!.url.searchParams.get('alt'), 'media');
  assert.equal(exp!.url.pathname, '/drive/v3/files/f1/export');
  assert.equal(exp!.url.searchParams.get('mimeType'), 'text/plain');
  assert.equal(folder!.url.searchParams.get('q'), "'o\\'1\\\\x' in parents and trashed = false", 'query literals are escaped');
  assert.equal(create!.url.toString(), 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id');
  assert.equal(create!.init.method, 'POST');
  const boundary = /multipart\/related; boundary=(\S+)/.exec(create!.headers.get('content-type')!)![1]!;
  const parts = String(create!.init.body).split(`--${boundary}`);
  assert.equal(parts.length, 4, 'metadata part, media part, closing delimiter');
  assert.match(parts[1]!, /Content-Type: application\/json; charset=UTF-8\r\n\r\n\{"name":"salon-p.txt","mimeType":"text\/plain","parents":\["in-1"\],"appProperties":\{"salonBridge":"1","salonDelivery":"dlv_1"\}\}/);
  assert.match(parts[2]!, /Content-Type: text\/plain; charset=UTF-8\r\n\r\nbody --x\r\n$/);
  assert.equal(parts[3], '--\r\n');
  assert.equal(find!.url.searchParams.get('q'), "appProperties has { key='salonDelivery' and value='dlv_1' } and 'in-1' in parents and trashed = false");
  assert.equal(watch!.url.pathname, '/drive/v3/changes/watch');
  assert.deepEqual(JSON.parse(String(watch!.init.body)), { id: 'ch_1', type: 'web_hook', address: 'https://salon.test/drive/notifications', token: 'tok', expiration: '1800000000000' });
  assert.equal(stop!.url.pathname, '/drive/v3/channels/stop');
  assert.deepEqual(JSON.parse(String(stop!.init.body)), { id: 'ch_1', resourceId: 'res-1' });
  assert.equal(queryLiteral("a'b"), "'a\\'b'");
});

test('Drive HTTP: errors are classified by status and reason, with sanitized messages', async () => {
  const cases: [Response, string][] = [
    [googleError(400, 'invalid', 'pageToken'), 'invalid_cursor:page_token_rejected'],
    [googleError(400, 'invalid', 'pageSize'), 'permanent:bad_request'],
    [googleError(404, 'notFound', 'fileId'), 'not_found:not_found'],
    [googleError(403, 'userRateLimitExceeded'), 'rate_limited:rate_limited'],
    [googleError(403, 'rateLimitExceeded'), 'rate_limited:rate_limited'],
    [googleError(429, 'rateLimitExceeded'), 'rate_limited:rate_limited'],
    [googleError(403, 'insufficientFilePermissions'), 'permanent:file_forbidden'],
    [googleError(403, 'appNotAuthorizedToFile'), 'permanent:file_forbidden'],
    [googleError(403, 'insufficientPermissions'), 'auth:account_forbidden'],
    [googleError(403, 'somethingNew'), 'permanent:forbidden'],
    [new Response('<html>oops</html>', { status: 403 }), 'permanent:forbidden'],
    [googleError(500, 'backendError'), 'transient:server_error'],
    [googleError(503, 'backendError'), 'transient:server_error'],
    [new Response(null, { status: 302, headers: { Location: 'https://elsewhere.invalid/' } }), 'permanent:redirect_refused'],
  ];
  for (const [res, expected] of cases) {
    const r = recorder([res]);
    const c = new DriveHttpClient({ accountId: A, tokens: fixed(), fetch: r.fetch });
    assert.equal(await kindOf(c.listChanges('7', 10)), expected, expected);
    assert.equal(r.seen.length, 1, 'no retry, and a redirect target is never fetched');
  }
  // Only a page-token rejection is an invalid cursor; a missing file on another call is not.
  const r = recorder([googleError(404, 'notFound')]);
  assert.equal(await kindOf(new DriveHttpClient({ accountId: A, tokens: fixed(), fetch: r.fetch }).getFile('x')), 'not_found:not_found');
  // A failed or unreadable create is ambiguous, never a definite failure.
  for (const res of [googleError(503, 'backendError'), new Response('not json', { status: 200 }), ok({ kind: 'drive#file' })]) {
    const c = new DriveHttpClient({ accountId: A, tokens: fixed(), fetch: recorder([res]).fetch });
    assert.equal(await kindOf(c.createTextFile('in', 'n', 'b', {})), 'transient:outcome_unknown');
  }
  const lost = new DriveHttpClient({ accountId: A, tokens: fixed(), fetch: async () => { throw new TypeError('socket hang up'); } });
  assert.equal(await kindOf(lost.createTextFile('in', 'n', 'b', {})), 'transient:outcome_unknown');
  assert.equal(await kindOf(lost.getFile('x')), 'transient:network');
});

test('Drive HTTP: malformed responses, oversized and streamed bodies, and timeouts', async () => {
  const malformed: Response[] = [
    new Response('{not json'), ok([1, 2]), ok({ changes: [] }), ok({ newStartPageToken: '9', changes: [{ removed: false }] }),
    ok({ newStartPageToken: '9', changes: [{ fileId: 'f', file: { id: 'f' } }] }), ok({ newStartPageToken: '9', changes: [{ fileId: 'f', file: { ...FILE, size: '-1' } }] }),
  ];
  for (const res of malformed) {
    assert.equal(await kindOf(new DriveHttpClient({ accountId: A, tokens: fixed(), fetch: recorder([res]).fetch }).listChanges('1', 10)), 'transient:malformed_response');
  }
  // An empty page with a next token is valid and followed by the bridge.
  const empty = await new DriveHttpClient({ accountId: A, tokens: fixed(), fetch: recorder([ok({ nextPageToken: '2', changes: [] })]).fetch }).listChanges('1', 10);
  assert.deepEqual(empty, { changes: [], nextPageToken: '2' });

  // Declared length over the cap: refused without reading.
  const declared = new Response('x'.repeat(10), { headers: { 'Content-Length': String(64 * 1024) } });
  assert.equal(await kindOf(readCapped(declared, 32 * 1024)), 'too_large:too_large');
  // Streamed without a length: read up to the cap, then cancelled.
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      pulled++;
      ctrl.enqueue(new Uint8Array(8 * 1024).fill(120));
      if (pulled > 100) ctrl.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const c = new DriveHttpClient({ accountId: A, tokens: fixed(), fetch: recorder([new Response(stream)]).fetch });
  assert.equal(await kindOf(c.download('f', 32 * 1024)), 'too_large:too_large');
  assert.ok(cancelled && pulled < 10, 'the stream was cancelled near the cap');
  assert.equal(await readCapped(new Response('x'.repeat(32 * 1024)), 32 * 1024), 'x'.repeat(32 * 1024), 'exactly the cap is accepted');

  // A request that never answers times out.
  // (Node's AbortSignal.timeout does not keep the process alive, so the stub holds a timer of its own.)
  const hanging: FetchLike = (_input, init) => new Promise((_, reject) => {
    const hold = setTimeout(() => undefined, 5_000);
    init.signal!.addEventListener('abort', () => {
      clearTimeout(hold);
      reject(init.signal!.reason);
    });
  });
  const slow = new DriveHttpClient({ accountId: A, tokens: fixed(), fetch: hanging, timeoutMs: 30 });
  assert.equal(await kindOf(slow.getStartPageToken()), 'timeout:network');
  assert.equal(await kindOf(slow.createTextFile('in', 'n', 'b', {})), 'timeout:outcome_unknown');
});

test('Drive HTTP: tokens are per account, refreshed once on 401, and never leak into errors', async () => {
  const mock = new MockDrive([A, B]);
  const google = new FakeGoogle(mock);
  const provider = new RefreshTokenProvider(SYNTHETIC_OAUTH, google.fetch);
  const a = new DriveHttpClient({ accountId: A, tokens: provider, fetch: google.fetch });
  const b = new DriveHttpClient({ accountId: B, tokens: provider, fetch: google.fetch });
  await Promise.all([a.getStartPageToken(), a.getStartPageToken(), b.getStartPageToken()]);
  const tokenCalls = () => google.calls.filter((c) => c.path === '/token').length;
  assert.equal(tokenCalls(), 2, 'one refresh per account, shared by concurrent callers');
  const driveCalls = google.calls.filter((c) => c.host === 'www.googleapis.com');
  assert.ok(driveCalls.filter((c) => c.account === A).every((c) => c.authorization!.includes('account-a')));
  assert.ok(driveCalls.filter((c) => c.account === B).every((c) => c.authorization!.includes('account-b')));
  assert.ok(google.calls.filter((c) => c.path === '/token').every((c) => c.authorization === undefined), 'no bearer token goes to the token endpoint');

  // Access token revoked server-side: one refresh, then the request succeeds.
  google.expireAccessTokens();
  await a.getStartPageToken();
  assert.equal(tokenCalls(), 3);
  // Refresh grant revoked: 'auth' (the account is held), with no secret in the message.
  google.expireAccessTokens();
  google.tokenFailures.push({ status: 400, error: 'invalid_grant' });
  const err = await a.getStartPageToken().catch((e: unknown) => e) as DriveError;
  assert.equal(`${err.kind}:${err.message}`, 'auth:invalid_grant');
  assert.ok(!JSON.stringify([err.message, err.stack]).match(/synthetic-(refresh|access|client-secret)/));
  // Token endpoint trouble is retryable, and an unknown account has no grant.
  google.tokenFailures.push({ status: 503, error: 'unavailable' });
  assert.equal(await kindOf(a.getStartPageToken()), 'transient:token_http_5xx');
  google.tokenFailures.push({ status: 401, error: 'invalid_client' });
  assert.equal(await kindOf(a.getStartPageToken()), 'auth:invalid_client');
  assert.equal(await kindOf(new DriveHttpClient({ accountId: 'account-c', tokens: provider, fetch: google.fetch }).getStartPageToken()), 'auth:no_grant_for_account');
  // A persistent 401 after the refresh is 'auth', not an endless loop.
  const r = recorder([googleError(401, 'authError'), googleError(401, 'authError')]);
  assert.equal(await kindOf(new DriveHttpClient({ accountId: A, tokens: fixed(), fetch: r.fetch }).getFile('f')), 'auth:unauthorized');
  assert.equal(r.seen.length, 2);
  // The token endpoint URL is fixed, and redirects there are refused too.
  const tr = recorder([new Response(null, { status: 307, headers: { Location: 'https://elsewhere.invalid/' } })]);
  assert.equal(await kindOf(new RefreshTokenProvider(SYNTHETIC_OAUTH, tr.fetch).token(A)), 'permanent:token_redirect_refused');
  assert.equal(tr.seen[0]!.url.toString(), GOOGLE_TOKEN_URL);
  assert.equal(tr.seen[0]!.init.redirect, 'manual');
});

// ---- the bridge end to end through the real adapter -----------------------------------

const PEOPLE = [
  { name: 'Grok', account: A }, { name: 'Spark', account: A },
  { name: 'Rei', account: B }, { name: 'Claude', account: B }, { name: 'Muse', account: B },
] as const;
type Name = (typeof PEOPLE)[number]['name'];
const out = (n: Name) => `out-${n.toLowerCase()}`;
const inbox = (n: Name) => `in-${n.toLowerCase()}`;
const CONFIG = {
  version: 1, notify_url: 'https://salon.test/drive/notifications', accounts: [{ id: A }, { id: B }],
  participants: PEOPLE.map((p) => ({ name: p.name, account: p.account, outbox: out(p.name), inbox: inbox(p.name) })),
};
const msg = (id: string, head: string, body: string) => `salon-message: 1\nid: ${id}\n${head}\n---\n${body}\n`;

async function httpWorld() {
  const mock = new MockDrive([A, B]);
  const google = new FakeGoogle(mock);
  const config = parseDriveConfig(JSON.stringify(CONFIG), [])!;
  const tokens = new RefreshTokenProvider(SYNTHETIC_OAUTH, google.fetch);
  const w = setup({ drive: { config, client: (accountId) => new DriveHttpClient({ accountId, tokens, fetch: google.fetch }) } });
  mock.now = () => w.clock.now();
  google.now = () => w.clock.now();
  await w.salon.ready;
  const bridge = w.salon.drive!;
  await bridge.syncConfig();
  const session = await w.openSession({ limits: { maxPosts: 1000, maxPostsPerParticipant: 400, maxThreads: 100, maxBodyChars: 2000 } });
  w.clock.advance(1000);
  const account = (n: Name) => PEOPLE.find((p) => p.name === n)!.account;
  const write = (n: Name, content: string, mimeType?: string) => mock.addFile(account(n), out(n), { content, mimeType });
  const inboxOf = (n: Name) => mock.filesIn(inbox(n)).map((f) => f.content);
  const posts = () => w.raw.prepare('SELECT id, body, author_id FROM posts ORDER BY seq').all() as Json[];
  return { ...w, mock, google, bridge, session, write, inboxOf, posts };
}

test('Drive HTTP end to end: both formats, pagination, cross-account delivery, and invalid-cursor recovery through the adapter', async () => {
  const w = await httpWorld();
  w.write('Grok', msg('grok-http-01', 'title: Over HTTP', 'Plain text through Drive v3.'));
  w.write('Muse', msg('muse-http-01', 'title: As a Doc', 'Exported as text.'), GOOGLE_DOC);
  // 130 more changes in account B: two change pages, the first ending in a page of non-messages.
  for (let i = 0; i < 130; i++) w.mock.addFile(B, out('Rei'), { content: 'not a message', mimeType: 'image/png' });
  await w.bridge.runOnce('worker-1');
  await w.bridge.runOnce('worker-1');
  assert.deepEqual(w.posts().map((p) => p.body).sort(), ['Exported as text.', 'Plain text through Drive v3.']);
  for (const n of ['Spark', 'Rei', 'Claude'] as const) assert.equal(w.inboxOf(n).length, 2, n);
  assert.equal(w.inboxOf('Grok').length, 1);
  const pages = w.google.calls.filter((c) => c.path === '/drive/v3/changes' && c.account === B);
  assert.ok(pages.some((c) => c.query.get('pageToken') !== pages[0]!.query.get('pageToken')), 'followed nextPageToken');
  // Account isolation: each inbox was written with its own account's token.
  for (const c of w.google.calls.filter((x) => x.path === '/upload/drive/v3/files')) assert.ok(c.authorization!.includes(c.account!));

  // Invalid cursor: recovery scans outbox folders page by page over HTTP.
  w.mock.folderPageSize = 1;
  w.write('Claude', msg('claude-http-1', 'title: Recovered', 'Found by the folder scan.'));
  w.mock.invalidateTokens(B);
  for (let i = 0; i < 4; i++) await w.bridge.runOnce('worker-1');
  assert.ok(w.posts().some((p) => p.body === 'Found by the folder scan.'));
  assert.ok(w.google.calls.some((c) => c.path === '/drive/v3/files' && /in parents and trashed = false$/.test(c.query.get('q') ?? '') && c.query.get('pageToken')));
  assert.equal(new Set(w.posts().map((p) => p.body)).size, w.posts().length, 'nothing posted twice');
});

test('Drive HTTP end to end: a create whose response is lost keeps its uncertainty and is found, not duplicated', async () => {
  const w = await httpWorld();
  w.mock.fail('createTextFile', 'timeout_after_write', { account: B, times: 1 });
  w.write('Spark', msg('spark-http-lost', 'title: Lost response', 'Written once.'));
  await w.bridge.runOnce('worker-1');
  const uncertain = w.raw.prepare(`SELECT id FROM drive_deliveries WHERE state = 'uncertain'`).all() as Json[];
  assert.equal(uncertain.length, 1);
  const markers = () => Number((w.raw.prepare('SELECT COUNT(*) AS n FROM drive_unresolved_writes WHERE delivery_id = ?').get(uncertain[0]!.id) as Json).n);
  assert.equal(markers(), 1, 'the body-less uncertainty marker survives the lost response');
  w.clock.advance(LIMITS.maxBackoffMs + 1);
  await w.bridge.runOnce('worker-1');
  for (const n of ['Grok', 'Rei', 'Claude', 'Muse'] as const) assert.equal(w.inboxOf(n).length, 1, `${n}: exactly one copy`);
  assert.ok(w.google.calls.some((c) => /appProperties has/.test(c.query.get('q') ?? '')), 'looked before writing again');
  assert.equal(markers(), 1, 'a search hit does not erase the uncertainty of the lost create');
  assert.equal((w.raw.prepare('SELECT state FROM drive_deliveries WHERE id = ?').get(uncertain[0]!.id) as Json).state, 'delivered');

  // Rate limits and file-level refusals are not account loss.
  w.mock.fail('createTextFile', 'rate_limited', { account: A, times: 1 });
  w.mock.fail('getFile', 'permanent', { account: B, times: 1 });
  const refused = w.write('Rei', msg('rei-http-refused', 'title: Refused', 'Drive refuses this file.'));
  await w.bridge.runOnce('worker-1');
  const accounts = w.raw.prepare('SELECT id, access_state FROM drive_accounts ORDER BY id').all() as Json[];
  assert.deepEqual(accounts.map((a) => a.access_state), ['ok', 'ok']);
  assert.equal((w.raw.prepare('SELECT state, reason FROM drive_files WHERE file_id = ?').get(refused) as Json).reason, 'drive_file_forbidden');
});

test('Drive HTTP: channels use the expiration Drive grants; notifications wake, coalesce, and ignore unknown metadata', async () => {
  const w = await httpWorld();
  w.google.grantedWatchMs = 2 * 24 * 60 * 60_000; // Drive may grant less than requested
  await w.bridge.renewChannels();
  const chans = w.raw.prepare('SELECT * FROM drive_channels ORDER BY account_id').all() as Json[];
  assert.equal(chans.length, 2);
  assert.equal(Date.parse(chans[0]!.expires_at as string), w.clock.now() + w.google.grantedWatchMs, 'stored the granted expiration');
  const [id, ch] = [...w.mock.channels.entries()].find(([, c]) => c.account === A)!;
  const notify = (h: Record<string, string>) => w.salon.app.request('/drive/notifications', { method: 'POST', headers: h });
  const good = { 'X-Goog-Channel-ID': id, 'X-Goog-Channel-Token': ch.token, 'X-Goog-Resource-ID': ch.resourceId, 'X-Goog-Resource-State': 'change' };
  const wake = () => w.raw.prepare('SELECT wake_requested_at FROM drive_accounts WHERE id = ?').get(A) as Json;

  // A sync, even for a channel not stored yet (it can precede the watch response), does nothing.
  assert.equal((await notify({ ...good, 'X-Goog-Channel-ID': 'ch_not_stored_yet', 'X-Goog-Resource-State': 'sync' })).status, 200);
  // Unknown resource states and oversized headers start nothing.
  assert.equal((await notify({ ...good, 'X-Goog-Resource-State': 'remove' })).status, 200);
  assert.equal((await notify({ ...good, 'X-Goog-Channel-Token': 'x'.repeat(300) })).status, 400);
  assert.equal(wake().wake_requested_at, null);
  // Both spellings Drive's guide uses wake the account; a second notification while one is pending is coalesced.
  const direct = (state: string) => w.bridge.notification({ channelId: id, token: ch.token, resourceId: ch.resourceId, resourceState: state });
  assert.deepEqual(await direct('change'), { status: 200, woke: true, accountId: A });
  assert.deepEqual(await direct('changed'), { status: 200, woke: false, accountId: A }, 'coalesced');
  w.raw.prepare('UPDATE drive_accounts SET wake_requested_at = NULL').run();
  assert.equal((await direct('changed')).woke, true);
  w.raw.prepare('UPDATE drive_accounts SET wake_requested_at = NULL').run();
  // Through the app, a valid notification starts one bounded run for that account in the background.
  w.write('Grok', msg('grok-http-wake', 'title: Woken', 'Arrived by notification.'));
  assert.equal((await notify(good)).status, 200);
  for (let i = 0; i < 100 && !w.inboxOf('Rei').some((t) => t.includes('Arrived by notification.')); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(w.posts().some((p) => p.body === 'Arrived by notification.'));
  assert.ok(w.inboxOf('Rei').some((t) => t.includes('Arrived by notification.')), 'ingested and delivered by the woken run');
  assert.equal(wake().wake_requested_at, null, 'the run consumed the wake-up');
  const r2 = await direct('changed');
  assert.equal(r2.woke, true);
});
