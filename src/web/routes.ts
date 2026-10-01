import { Hono, type Context } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../domain/errors.ts';
import type { ReadModel } from '../store/reads.ts';
import type { SafeHtml } from './html.ts';
import { adminPage, archivePage, emptyHomePage, notFoundPage, searchPage, sessionPage, threadPage } from './pages.ts';

const ASSET_DIR = fileURLToPath(new URL('./assets/', import.meta.url));
const ASSETS: Record<string, { type: string; body: string }> = Object.fromEntries(
  [
    ['style.css', 'text/css; charset=utf-8'],
    ['app.js', 'text/javascript; charset=utf-8'],
    ['admin.js', 'text/javascript; charset=utf-8'],
    ['scene.svg', 'image/svg+xml'],
  ].map(([name, type]) => [name!, { type: type!, body: readFileSync(ASSET_DIR + name, 'utf8') }]),
);

const PAGE_SIZE = 100;

export function webRoutes(reads: ReadModel): Hono {
  const web = new Hono();

  const page = (c: Context, body: SafeHtml, status: 200 | 404 = 200) => {
    c.header('Cache-Control', 'no-store');
    return c.html(body.value, status);
  };

  // A web 404 renders a page instead of JSON.
  const orNotFound = (c: Context, fn: () => SafeHtml) => {
    try {
      return page(c, fn());
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'NOT_FOUND' || err.code === 'INVALID_CURSOR' || err.code === 'CURSOR_EXPIRED')) {
        return page(c, notFoundPage(), 404);
      }
      throw err;
    }
  };

  web.get('/assets/:name', (c) => {
    const asset = ASSETS[c.req.param('name')];
    if (!asset) return c.notFound();
    c.header('Cache-Control', 'public, max-age=300');
    if (asset.type === 'image/svg+xml') c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    return c.body(asset.body, 200, { 'Content-Type': asset.type });
  });

  const renderSession = (c: Context, sessionId: string) =>
    orNotFound(c, () => {
      const detail = reads.sessionDetail(sessionId);
      const tag = c.req.query('tag') || undefined;
      const posts = reads.sessionPosts(sessionId, { tag, cursor: c.req.query('cursor'), limit: PAGE_SIZE });
      const replies = reads.replyContext(posts.items.flatMap((p) => (p.reply_to_post_id ? [p.reply_to_post_id] : [])));
      return sessionPage({ ...detail, posts: posts.items, replies, nextCursor: posts.next_cursor, tag });
    });

  web.get('/', (c) => {
    const current = reads.currentSession();
    if (!current.session) return page(c, emptyHomePage());
    return renderSession(c, current.session.id);
  });

  web.get('/sessions/:id', (c) => renderSession(c, c.req.param('id')));

  web.get('/threads/:id', (c) =>
    orNotFound(c, () => {
      const data = reads.threadPosts(c.req.param('id'), c.req.query('cursor'), PAGE_SIZE);
      const replies = reads.replyContext(data.items.flatMap((p) => (p.reply_to_post_id ? [p.reply_to_post_id] : [])));
      return threadPage({ thread: data.thread, session: data.session, posts: data.items, replies, nextCursor: data.next_cursor });
    }),
  );

  // Stable post reference: redirects to the post's place in its thread.
  web.get('/posts/:id', (c) => {
    const loc = reads.postLocation(c.req.param('id'));
    if (!loc) return page(c, notFoundPage(), 404);
    return c.redirect(`/threads/${loc.thread_id}#post-${c.req.param('id')}`, 302);
  });

  web.get('/archive', (c) =>
    orNotFound(c, () => {
      const list = reads.listSessions(c.req.query('cursor'), 50);
      return archivePage(list.items, list.next_cursor);
    }),
  );

  web.get('/search', (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return page(c, searchPage('', [], null));
    try {
      const r = reads.search(q, c.req.query('cursor'), 30);
      return page(c, searchPage(r.query, r.items, r.next_cursor));
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return page(c, searchPage(q.slice(0, 100), [], null, err.message));
      throw err;
    }
  });

  web.get('/admin', (c) => page(c, adminPage()));

  return web;
}
