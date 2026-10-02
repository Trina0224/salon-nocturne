import { Hono, type Context } from 'hono';
import { ApiError } from '../domain/errors.ts';
import type { ReadModel } from '../store/reads.ts';
import type { SafeHtml } from './html.ts';
import { adminPage, archivePage, emptyHomePage, notFoundPage, searchPage, sessionPage, threadPage } from './pages.ts';

const PAGE_SIZE = 100;

export function webRoutes(reads: ReadModel): Hono {
  const web = new Hono();

  const page = (c: Context, body: SafeHtml, status: 200 | 404 = 200) => {
    c.header('Cache-Control', 'no-store');
    return c.html(body.value, status);
  };

  // A web 404 renders a page instead of JSON.
  const orNotFound = async (c: Context, fn: () => Promise<SafeHtml>) => {
    try {
      return page(c, await fn());
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'NOT_FOUND' || err.code === 'INVALID_CURSOR' || err.code === 'CURSOR_EXPIRED')) {
        return page(c, notFoundPage(), 404);
      }
      throw err;
    }
  };

  const renderSession = (c: Context, sessionId: string) =>
    orNotFound(c, async () => {
      const detail = await reads.sessionDetail(sessionId);
      const tag = c.req.query('tag') || undefined;
      const posts = await reads.sessionPosts(sessionId, { tag, cursor: c.req.query('cursor'), limit: PAGE_SIZE });
      const replies = await reads.replyContext(posts.items.flatMap((p) => (p.reply_to_post_id ? [p.reply_to_post_id] : [])));
      return sessionPage({
        ...detail, posts: posts.items, replies, nextCursor: posts.next_cursor, tag,
        watermark: posts.watermark, refreshCursor: posts.refresh_cursor, startsAtBeginning: posts.starts_at_beginning,
      });
    });

  web.get('/', async (c) => {
    const current = await reads.currentSession();
    if (!current.session) return page(c, emptyHomePage());
    return renderSession(c, current.session.id);
  });

  web.get('/sessions/:id', (c) => renderSession(c, c.req.param('id')));

  web.get('/threads/:id', (c) =>
    orNotFound(c, async () => {
      const data = await reads.threadPosts(c.req.param('id'), { cursor: c.req.query('cursor'), limit: PAGE_SIZE, at: c.req.query('at') });
      const replies = await reads.replyContext(data.items.flatMap((p) => (p.reply_to_post_id ? [p.reply_to_post_id] : [])));
      return threadPage({
        thread: data.thread, session: data.session, posts: data.items, replies,
        nextCursor: data.next_cursor, startsAtBeginning: data.starts_at_beginning,
      });
    }),
  );

  // Stable post reference: opens the thread page at the post, on any page.
  web.get('/posts/:id', async (c) => {
    const id = c.req.param('id');
    const loc = await reads.postLocation(id);
    if (!loc) return page(c, notFoundPage(), 404);
    return c.redirect(`/threads/${loc.thread_id}?at=${encodeURIComponent(id)}#post-${id}`, 302);
  });

  web.get('/archive', (c) =>
    orNotFound(c, async () => {
      const list = await reads.listSessions(c.req.query('cursor'), 50);
      return archivePage(list.items, list.next_cursor);
    }),
  );

  web.get('/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return page(c, searchPage('', [], null));
    try {
      const r = await reads.search(q, c.req.query('cursor'), 30);
      return page(c, searchPage(r.query, r.items, r.next_cursor));
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) return page(c, searchPage(q.slice(0, 100), [], null, err.message));
      throw err;
    }
  });

  web.get('/admin', (c) => page(c, adminPage()));

  return web;
}
