// Regression tests for the PR #2 review: links beyond the first page, the
// new-thoughts refresh, host double-submit, old-tab polling, and UTF-8
// response budgets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { TOKENS, setup, type Json } from './helpers.ts';
import { PAGE_BYTE_CAP } from '../src/store/reads.ts';

const BIG = { maxPosts: 2000, maxPostsPerParticipant: 500, maxThreads: 5, maxBodyChars: 4000 };
const agents = [TOKENS.aster, TOKENS.birch, TOKENS.cedar];

/** Loads a browser script without a DOM and returns its global exports. */
function loadBrowserScript(name: string): Json {
  const context: Json = {};
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL(`../public/assets/${name}`, import.meta.url), 'utf8'), context);
  return context;
}

const attr = (html: string, name: string) => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(html);
  return m ? m[1]!.replaceAll('&amp;', '&') : null;
};
const laterLink = (html: string) => {
  const m = /<a href="([^"]+)">Later thoughts →<\/a>/.exec(html);
  return m ? m[1]!.replaceAll('&amp;', '&') : null;
};

/** One thread holding `count` posts (opener included); returns post IDs in order. */
async function bigThread(ctx: ReturnType<typeof setup>, count: number, body: (i: number) => string) {
  const s = await ctx.openSession({ limits: BIG });
  const { thread, post } = await ctx.startThread(s.id, s.generation, TOKENS.owner, body(0));
  const ids = [post.id];
  for (let i = 1; i < count; i++) {
    const r = await ctx.post(thread.id, s, agents[i % 3]!, body(i));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ids.push(r.body.post.id);
  }
  return { s, thread, ids };
}

// ---- 1. permanent, search, and reply links beyond the first page --------------

test('/posts/:id lands on posts beyond the first 100', async () => {
  const ctx = setup();
  const { s, thread, ids } = await bigThread(ctx, 101, (i) => `Post number ${i}${i === 100 ? ' with the word zephyrine' : ''}.`);
  const last = ids[100]!;

  const firstPage = (await ctx.call('GET', `/threads/${thread.id}`)).body as string;
  assert.ok(!firstPage.includes(`id="post-${last}"`), 'precondition: post 101 is not on the first page');

  const follow = async (url: string) => {
    const r = await ctx.call('GET', url);
    assert.equal(r.status, 302);
    const location = r.res.headers.get('location')!;
    const page = await ctx.call('GET', location.split('#')[0]!);
    assert.equal(page.status, 200);
    return { location, html: page.body as string };
  };

  const permalink = await follow(`/posts/${last}`);
  assert.ok(permalink.location.endsWith(`#post-${last}`));
  assert.ok(permalink.html.includes(`id="post-${last}"`));
  assert.ok(permalink.html.includes('← From the beginning'));

  const middle = await follow(`/posts/${ids[57]}`);
  assert.ok(middle.html.includes(`id="post-${ids[57]}"`));
  assert.ok(middle.html.includes(`id="post-${ids[54]}"`), 'a little earlier context is shown');

  // Search results link through /posts/:id.
  const hit = (await ctx.call('GET', '/api/v1/search?q=zephyrine')).body.items[0];
  assert.equal(hit.post_id, last);
  assert.ok((await follow(hit.url)).html.includes(`id="post-${last}"`));

  // Reply links too.
  const reply = await ctx.post(thread.id, s, TOKENS.birch, 'Replying to the last one.', { reply_to_post_id: last });
  const replyPage = await follow(`/posts/${reply.body.post.id}`);
  assert.ok(replyPage.html.includes(`href="/posts/${last}"`));
  assert.ok((await follow(`/posts/${last}`)).html.includes(`id="post-${last}"`));
});

test('/posts/:id lands on the post even when the byte budget shortens pages', async () => {
  const ctx = setup();
  const { thread, ids } = await bigThread(ctx, 30, (i) => `${i} ${'光'.repeat(3990)}`);
  const firstPage = await ctx.call('GET', `/api/v1/threads/${thread.id}/posts?limit=100`);
  assert.ok(firstPage.body.items.length < 25, 'precondition: the budget cuts the first page short');
  const r = await ctx.call('GET', `/posts/${ids[27]}`);
  const html = (await ctx.call('GET', r.res.headers.get('location')!.split('#')[0]!)).body as string;
  assert.ok(html.includes(`id="post-${ids[27]}"`));
});

// ---- 2. new-thoughts refresh on a later page -------------------------------------

test('showing new thoughts on page two reveals the announced post', async () => {
  const ctx = setup();
  const { SalonNocturne } = loadBrowserScript('app.js');
  const { s, thread } = await bigThread(ctx, 101, (i) => `Line ${i}.`);

  const page1 = (await ctx.call('GET', `/sessions/${s.id}`)).body as string;
  const page2Url = laterLink(page1)!;
  assert.ok(page2Url, 'page one links to page two');
  const page2 = (await ctx.call('GET', page2Url)).body as string;
  assert.ok(page2.includes('Line 100.'));
  assert.equal(laterLink(page2), null);
  const seen = Number(attr(page2, 'data-seen-seq'));
  const refreshUrl = attr(page2, 'data-refresh-url')!;

  // Post #102 arrives while the reader is on page two.
  const late = await ctx.post(thread.id, s, TOKENS.cedar, 'Line 101, the late one.');
  const status = (await ctx.call('GET', `/api/v1/sessions/${s.id}/status`)).body;
  assert.equal(SalonNocturne.decidePoll(s.id, seen, status), 'new', 'the notice appears');

  // Clicking the notice loads a fresh snapshot from the same starting point.
  const refreshed = (await ctx.call('GET', refreshUrl)).body as string;
  assert.ok(refreshed.includes(`id="post-${late.body.post.id}"`), 'the announced post is shown');
  assert.ok(refreshed.includes('Line 100.'), 'the reader keeps their place in the listing');
  const newSeen = Number(attr(refreshed, 'data-seen-seq'));
  assert.equal(SalonNocturne.decidePoll(s.id, newSeen, status), 'none', 'the notice clears only once the post is visible');

  // A plain reload of the old page-two URL is no longer a dead end either.
  const reloaded = (await ctx.call('GET', page2Url)).body as string;
  const onward = laterLink(reloaded);
  assert.ok(onward, 'the stale snapshot links onward to newer posts');
  assert.ok(((await ctx.call('GET', onward!)).body as string).includes(`id="post-${late.body.post.id}"`));
});

// ---- 3. host double-submit and lost-response retry -----------------------------

test('host post: a double submit sends once; a lost response retries with the same key', async () => {
  const ctx = setup();
  const { SalonAdmin } = loadBrowserScript('admin.js');
  const s = await ctx.openSession();
  const { thread } = await ctx.startThread(s.id, s.generation);
  const countPosts = () => Number(ctx.raw.prepare('SELECT COUNT(*) AS n FROM posts').get()!.n);
  const used = () => Number(ctx.raw.prepare('SELECT posts_used FROM sessions').get()!.posts_used);
  const request = { path: `/api/v1/threads/${thread.id}/posts`, body: { body: 'From the host.', session_id: s.id, generation: s.generation } };
  const realSend = async (req: typeof request, key: string) => {
    const r = await ctx.call('POST', req.path, { token: TOKENS.owner, key, body: req.body });
    if (r.status >= 400) throw Object.assign(new Error(r.body.error.code), { definite: r.status < 500 });
    return r.body;
  };
  let n = 0;
  const makeKey = () => `host-test-key-${++n}`;
  // The submitter takes the form's signature and a builder for new requests.
  const as = (req: typeof request) => [JSON.stringify(req), () => req] as const;

  // Double submit while the first request is still in flight.
  const sentKeys: string[] = [];
  const slow = SalonAdmin.createSubmitter(async (req: typeof request, key: string) => {
    sentKeys.push(key);
    await new Promise((r) => setTimeout(r, 20));
    return realSend(req, key);
  }, makeKey);
  const before = countPosts();
  const [a, b] = await Promise.all([slow(...as(request)), slow(...as(request))]);
  assert.equal(sentKeys.length, 1);
  assert.equal(a.post.id, b.post.id);
  assert.equal(countPosts(), before + 1);

  // The server commits, but the response is lost on the way back.
  let attempt = 0;
  const lossy = SalonAdmin.createSubmitter(async (req: typeof request, key: string) => {
    sentKeys.push(key);
    const result = await realSend(req, key);
    if (++attempt === 1) throw new TypeError('Failed to fetch');
    return result;
  }, makeKey);
  const lostRequest = { ...request, body: { ...request.body, body: 'Lost on the way back.' } };
  const usedBefore = used();
  await assert.rejects(lossy(...as(lostRequest)), TypeError);
  const retry = await lossy(...as(lostRequest));
  assert.equal(sentKeys.at(-1), sentKeys.at(-2), 'the retry reuses the uncertain key');
  assert.equal(retry.replayed, true);
  assert.equal(countPosts(), before + 2);
  assert.equal(used(), usedBefore + 1, 'quota is charged once');

  // A definite rejection forgets the key; a changed payload gets a new key.
  const keys: string[] = [];
  const rejecting = SalonAdmin.createSubmitter(async (_req: unknown, key: string) => {
    keys.push(key);
    throw Object.assign(new Error('SESSION_CLOSED'), { definite: true });
  }, makeKey);
  await assert.rejects(rejecting(...as(request)));
  await assert.rejects(rejecting(...as(request)));
  assert.notEqual(keys[0], keys[1]);
  const flaky = SalonAdmin.createSubmitter(async (_req: unknown, key: string) => {
    keys.push(key);
    throw new TypeError('Failed to fetch');
  }, makeKey);
  await assert.rejects(flaky(...as(request)));
  await assert.rejects(flaky(...as(lostRequest)));
  assert.notEqual(keys.at(-1), keys.at(-2));
});

// ---- 4. an old session tab stops polling --------------------------------------

test('a tab watching session A stops when A closes, even after B opens', async () => {
  const ctx = setup();
  const { SalonNocturne } = loadBrowserScript('app.js');
  const a = await ctx.openSession({ title: 'Session A' });
  const pageA = (await ctx.call('GET', '/')).body as string;
  assert.equal(attr(pageA, 'data-session-id'), a.id);
  const seen = Number(attr(pageA, 'data-seen-seq'));

  await ctx.call('POST', `/api/v1/admin/sessions/${a.id}/close`, { token: TOKENS.owner, body: { expected_revision: a.revision } });
  const b = await ctx.openSession({ title: 'Session B' });
  assert.notEqual(b.id, a.id);

  const statusA = (await ctx.call('GET', `/api/v1/sessions/${a.id}/status`)).body;
  assert.equal(statusA.session.id, a.id);
  assert.equal(SalonNocturne.decidePoll(a.id, seen, statusA), 'closed', 'A’s tab shows closure and stops');

  assert.equal(SalonNocturne.decidePoll(a.id, seen, { notFound: true }), 'stop');
  assert.equal(SalonNocturne.decidePoll(a.id, seen, { session: { id: b.id, state: 'open' } }), 'stop');
  assert.equal(SalonNocturne.decidePoll(a.id, seen, null), 'retry');
  assert.ok(!readFileSync(new URL('../public/assets/app.js', import.meta.url), 'utf8').includes('/sessions/current'));
});

// ---- 5. UTF-8 response budget -----------------------------------------------------

test('paginated responses stay within the UTF-8 byte cap and continue without gaps', async () => {
  const ctx = setup();
  // Maximal posts: 4,000 code points of 3-byte CJK or 4-byte emoji.
  const { s, thread, ids } = await bigThread(ctx, 101, (i) => `${String(i).padStart(3, '0')} ${(i % 2 ? '建' : '🌃').repeat(3995)}`);

  async function walk(path: string, token: string | undefined, field: 'items' | 'changes', idOf: (x: Json) => string) {
    const seenIds: string[] = [];
    let cursor = '';
    let pages = 0;
    for (; pages < 200; pages++) {
      const sep = path.includes('?') ? '&' : '?';
      const r = await ctx.call('GET', `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { token });
      assert.equal(r.status, 200);
      const bytes = Buffer.byteLength(await r.res.text(), 'utf8');
      assert.ok(bytes <= PAGE_BYTE_CAP, `${path} page ${pages} is ${bytes} bytes`);
      seenIds.push(...r.body[field].map(idOf));
      if (!r.body.has_more) break;
      cursor = r.body.next_cursor;
    }
    assert.ok(pages > 1, `${path} needed several pages`);
    return seenIds;
  }

  assert.deepEqual(await walk(`/api/v1/threads/${thread.id}/posts`, undefined, 'items', (p) => p.id), ids);
  assert.deepEqual(await walk(`/api/v1/sessions/${s.id}/posts`, undefined, 'items', (p) => p.id), ids);
  const changeSeqs = ctx.raw.prepare('SELECT seq FROM changes WHERE session_id = ? ORDER BY seq').all(s.id).map((r) => String(r.seq));
  assert.deepEqual(await walk(`/api/v1/sessions/${s.id}/changes`, TOKENS.birch, 'changes', (c) => String(c.seq)), changeSeqs);
});
