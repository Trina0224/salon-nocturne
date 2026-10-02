import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOKENS, setup } from './helpers.ts';
import { renderBody } from '../src/web/render.ts';
import { assertLocalOnly } from '../src/server.ts';

test('post text is escaped; only http(s) URLs become links', () => {
  const out = renderBody('<script>alert(1)</script> <img src=x onerror=alert(1)> javascript:alert(1) https://example.com/a?b=1&c=2. data:text/html,hi');
  assert.ok(!out.value.includes('<script'));
  assert.ok(!out.value.includes('<img'));
  assert.ok(out.value.includes('&lt;script&gt;'));
  assert.equal((out.value.match(/<a /g) ?? []).length, 1);
  assert.ok(out.value.includes('href="https://example.com/a?b=1&amp;c=2"'));
  assert.ok(out.value.includes('rel="nofollow noopener noreferrer ugc"'));
  assert.ok(out.value.endsWith('data:text/html,hi'), 'non-http schemes stay plain text');
  assert.ok(out.value.includes('</a>.'), 'trailing punctuation is not part of the link');
  assert.ok(!renderBody('https://user:pw@example.com').value.includes('<a '), 'credentials in URLs are not linked');
  assert.ok(!renderBody('https://example.com/"onmouseover="x').value.includes('"onmouseover'), 'quotes cannot break out of href');
});

test('pages render real, escaped conversation text with security headers', async () => {
  const { openSession, startThread, post, call } = setup();
  const s = await openSession({ title: 'Night <b>talk</b>' });
  const { thread, post: opener } = await startThread(s.id, s.generation, TOKENS.aster, 'Hello <script>x()</script>', { title: 'A <i>room</i>', tags: ['architecture'] });
  await post(thread.id, s, TOKENS.birch, '回覆：建築與光。', { reply_to_post_id: opener.id });

  const home = await call('GET', '/');
  assert.equal(home.status, 200);
  const htmlText = home.body as string;
  assert.ok(htmlText.includes('Night &lt;b&gt;talk&lt;/b&gt;'));
  assert.ok(htmlText.includes('Hello &lt;script&gt;x()&lt;/script&gt;'));
  assert.ok(!htmlText.includes('<script>x()'));
  assert.ok(htmlText.includes('回覆：建築與光。'));
  assert.ok(htmlText.includes('Replying to Aster'));
  assert.ok(htmlText.includes('2 have spoken this session'));
  assert.ok(htmlText.includes(`/api/v1/sessions/${s.id}/export?format=md`));
  assert.ok(!htmlText.includes('21:00'), 'no fictional mockup hours');
  const csp = home.res.headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(home.res.headers.get('x-content-type-options'), 'nosniff');

  const threadPage = await call('GET', `/threads/${thread.id}`);
  assert.equal(threadPage.status, 200);
  assert.ok((threadPage.body as string).includes('A &lt;i&gt;room&lt;/i&gt;'));

  const link = await call('GET', `/posts/${opener.id}`);
  assert.equal(link.status, 302);
  assert.equal(link.res.headers.get('location'), `/threads/${thread.id}?at=${opener.id}#post-${opener.id}`);

  const search = await call('GET', `/search?q=${encodeURIComponent('建築')}`);
  assert.ok((search.body as string).includes('<mark>建築</mark>'));

  const tag = await call('GET', `/sessions/${s.id}?tag=architecture`);
  assert.ok((tag.body as string).includes('aria-current="page">architecture'));

  assert.equal((await call('GET', '/archive')).status, 200);
  assert.equal((await call('GET', '/admin')).status, 200);
});

test('a closed session page shows its real state, not mockup data', async () => {
  const { openSession, call, clock } = setup();
  await openSession({ duration_minutes: 10 });
  clock.advance(11 * 60_000);
  const page = (await call('GET', '/')).body as string;
  assert.ok(page.includes('reached its deadline'));
  assert.ok(!page.includes('data-new-thoughts'), 'no new-post polling for closed sessions');
});

test('empty and unknown pages', async () => {
  const { call } = setup();
  const home = await call('GET', '/');
  assert.ok((home.body as string).includes('The salon is quiet'));
  const missing = await call('GET', '/threads/thr_missing');
  assert.equal(missing.status, 404);
  assert.equal((await call('GET', '/nowhere')).status, 404);
  const api = await call('GET', '/api/v1/nowhere');
  assert.equal(api.status, 404);
  assert.equal(api.body.error.code, 'NOT_FOUND');
});

test('the server refuses to run with fixture identities outside local mode', () => {
  assert.doesNotThrow(() => assertLocalOnly({}));
  assert.doesNotThrow(() => assertLocalOnly({ SALON_ENV: 'local' }));
  assert.throws(() => assertLocalOnly({ SALON_ENV: 'production' }));
  assert.throws(() => assertLocalOnly({ SALON_ENV: 'local', NODE_ENV: 'production' }));
});

test('request logs carry no credentials, bodies, or query strings', async () => {
  const lines: string[] = [];
  const { createLocalSalon } = await import('../src/node/local.ts');
  const { FakeClock } = await import('../src/infra/clock.ts');
  const { T0 } = await import('./helpers.ts');
  const salon = await createLocalSalon({ dbPath: ':memory:', clock: new FakeClock(T0), log: (l) => lines.push(l) });
  await salon.app.request('/api/v1/me?secret=shh', { headers: { Authorization: `Bearer ${TOKENS.aster}` } });
  await salon.app.request('/api/v1/admin/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKENS.owner}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Private title', duration_minutes: 60, limits: { maxPosts: 1, maxPostsPerParticipant: 1, maxThreads: 1, maxBodyChars: 10 } }),
  });
  const all = lines.join('\n');
  assert.ok(lines.length >= 2);
  for (const secret of ['dev-agent', 'dev-owner', 'Bearer', 'shh', 'Private title']) assert.ok(!all.includes(secret), secret);
});
