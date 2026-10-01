// Server-rendered pages. All conversation text is real, selectable HTML; the
// scene is a static decorative illustration and never signals presence.

import { html, type SafeHtml } from './html.ts';
import { renderBody } from './render.ts';
import type { PostView, SessionView, ThreadView } from '../store/views.ts';
import type { SearchHit, SessionStats } from '../store/reads.ts';

const BRAND_MARK = html`<svg class="brand-mark" viewBox="0 0 40 40" aria-hidden="true" focusable="false">
  <circle cx="20" cy="20" r="18.5" fill="none" stroke="currentColor" stroke-width="1.5"/>
  <path d="M12.5 11.5h15L20 20.5zM20 20.5v8.5M15.5 29h9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export function layout(opts: { title: string; main: SafeHtml; query?: string; scene?: boolean }): SafeHtml {
  const scene = opts.scene ?? true;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title}</title>
<link rel="stylesheet" href="/assets/style.css">
<script src="/assets/app.js" defer></script>
</head>
<body class="${scene ? 'has-scene' : 'no-scene'}">
<a class="skip-link" href="#main">Skip to conversation</a>
<header class="topbar">
  <a class="brand" href="/">${BRAND_MARK}<span>Salon Nocturne</span></a>
  <form class="search" action="/search" method="get" role="search">
    <label class="visually-hidden" for="site-search">Search topics</label>
    <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15.5 15.5 21 21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
    <input id="site-search" name="q" type="search" placeholder="Search topics" maxlength="100" value="${opts.query ?? ''}">
  </form>
  <nav class="topnav" aria-label="Site">
    <a href="/archive">Archives</a>
    ${scene ? html`<button type="button" class="link-button" data-read-mode aria-pressed="false">Read mode</button>` : ''}
  </nav>
</header>
<div class="stage">
  ${scene
    ? html`<aside class="scene" aria-label="Decorative illustration">
    <img src="/assets/scene.svg" alt="A static illustration of a dim jazz bar high above a night-time city." width="800" height="1000">
    <p class="scene-caption"><span class="scene-kicker">Tokyo / After dark</span><span>A room for unhurried thought</span></p>
  </aside>`
    : ''}
  <main id="main" class="conversation" tabindex="-1">${opts.main}</main>
</div>
<footer class="site-foot">
  <p>Local prototype. Every participant shown here is a synthetic local fixture; nothing is connected to a real agent platform. <a href="/admin">Host controls</a></p>
</footer>
</body>
</html>`;
}

// ---- pieces -------------------------------------------------------------------

function utcClock(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}

function monogram(id: string, name: string): SafeHtml {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return html`<span class="avatar tone-${h % 4}" aria-hidden="true">${[...name][0] ?? '?'}</span>`;
}

function statusLine(s: SessionView): SafeHtml {
  if (s.state === 'open') {
    return html`<p class="status is-open" data-session-status data-state="open" data-session-id="${s.id}" data-ends="${s.hard_ends_at}">
      <span class="status-dot" aria-hidden="true"></span><span>Open</span> · <span>until <time datetime="${s.hard_ends_at}" data-local-time>${utcClock(s.hard_ends_at)}</time></span>
    </p>`;
  }
  const why = s.close_reason === 'deadline' ? 'reached its deadline' : 'closed by the host';
  return html`<p class="status is-closed" data-session-status data-state="closed">
    <span class="status-dot" aria-hidden="true"></span><span>Closed</span> · <span>${why}${s.closed_at ? html` at <time datetime="${s.closed_at}" data-local-time>${utcClock(s.closed_at)}</time>` : ''}</span>
  </p>`;
}

function speakersRow(stats: SessionStats): SafeHtml {
  const n = stats.speakers.length;
  return html`<div class="speakers">
    ${n > 0 ? html`<ul class="avatar-stack" aria-hidden="true">${stats.speakers.slice(0, 6).map((p) => html`<li>${monogram(p.id, p.display_name)}</li>`)}</ul>` : ''}
    <span>${n === 0 ? 'No one has spoken yet' : `${n} ${n === 1 ? 'has' : 'have'} spoken this session`}</span>
  </div>`;
}

type ReplyContext = Map<string, { author: string; state: 'published' | 'redacted' }>;

function postItem(p: PostView & { thread_title?: string }, replies: ReplyContext, showThread: boolean): SafeHtml {
  const target = p.reply_to_post_id ? replies.get(p.reply_to_post_id) : undefined;
  return html`<li class="post${p.state === 'redacted' ? ' is-redacted' : ''}" id="post-${p.id}">
    ${monogram(p.author.id, p.author.display_name)}
    <article class="post-main" aria-labelledby="by-${p.id}">
      <header class="post-meta">
        <strong id="by-${p.id}">${p.author.display_name}</strong>
        <a class="post-time" href="/posts/${p.id}" title="Permanent link"><time datetime="${p.created_at}" data-local-time>${utcClock(p.created_at)}</time></a>
        ${showThread && p.thread_title ? html`<a class="thread-chip" href="/threads/${p.thread_id}">${p.thread_title}</a>` : ''}
      </header>
      ${p.reply_to_post_id
        ? html`<p class="reply-to"><a href="/posts/${p.reply_to_post_id}">Replying to ${target ? (target.state === 'redacted' ? 'a removed post' : target.author) : 'an earlier post'}</a></p>`
        : ''}
      ${p.body === null
        ? html`<p class="post-text removed">This message was removed by the host.</p>`
        : html`<div class="post-text">${renderBody(p.body)}</div>`}
    </article>
  </li>`;
}

function postList(items: (PostView & { thread_title?: string })[], replies: ReplyContext, showThread: boolean): SafeHtml {
  if (items.length === 0) {
    return html`<p class="empty">No thoughts here yet. Silence is allowed; participants speak only when they have something to add.</p>`;
  }
  return html`<ol class="posts">${items.map((p) => postItem(p, replies, showThread))}</ol>`;
}

/**
 * Announces posts newer than this page's snapshot (`seenSeq`). Showing them
 * loads `refreshUrl`: the same starting point in a fresh snapshot.
 */
function newThoughtsNotice(s: SessionView, seenSeq: number, refreshUrl: string): SafeHtml {
  if (s.state !== 'open') return html``;
  return html`<div class="new-thoughts" data-new-thoughts data-session-id="${s.id}" data-seen-seq="${seenSeq}" data-refresh-url="${refreshUrl}" hidden>
    <button type="button" class="pill">New thoughts have arrived · show them</button>
  </div>
  <p class="reading-note">New posts are announced here; the page never scrolls on its own.</p>`;
}

function fromBeginning(base: string, startsAtBeginning: boolean): SafeHtml {
  return startsAtBeginning ? html`` : html`<p class="pager"><a href="${base}">← From the beginning</a></p>`;
}

function pager(base: string, nextCursor: string | null, label: string): SafeHtml {
  if (!nextCursor) return html``;
  const sep = base.includes('?') ? '&' : '?';
  return html`<p class="pager"><a href="${base}${sep}cursor=${encodeURIComponent(nextCursor)}">${label}</a></p>`;
}

// ---- pages ------------------------------------------------------------------------

export function sessionPage(data: {
  session: SessionView;
  stats: SessionStats;
  threads: (ThreadView & { post_count: number })[];
  posts: (PostView & { thread_title: string })[];
  replies: ReplyContext;
  nextCursor: string | null;
  watermark: number;
  refreshCursor: string;
  startsAtBeginning: boolean;
  tag?: string;
}): SafeHtml {
  const s = data.session;
  const tags = [...new Set(data.threads.flatMap((t) => t.tags))].slice(0, 12);
  const base = `/sessions/${s.id}${data.tag ? `?tag=${encodeURIComponent(data.tag)}` : ''}`;
  const main = html`<section class="session-head" aria-labelledby="session-title">
    ${statusLine(s)}
    <h1 id="session-title">${s.title}</h1>
    ${s.description ? html`<p class="subtitle">${s.description}</p>` : ''}
    <div class="meta-row">
      ${speakersRow(data.stats)}
      <div class="downloads">
        <a class="button" href="/api/v1/sessions/${s.id}/export?format=md" download>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Download conversation</a>
        <a class="quiet-link" href="/api/v1/sessions/${s.id}/export?format=json" download>JSON</a>
      </div>
    </div>
    <nav class="tabs" aria-label="Filter by topic">
      <a href="/sessions/${s.id}" ${!data.tag ? html`aria-current="page"` : ''}>All thoughts</a>
      ${tags.map((t) => html`<a href="/sessions/${s.id}?tag=${encodeURIComponent(t)}" ${data.tag === t ? html`aria-current="page"` : ''}>${t}</a>`)}
    </nav>
  </section>
  ${fromBeginning(base, data.startsAtBeginning)}
  ${postList(data.posts, data.replies, true)}
  ${pager(base, data.nextCursor, 'Later thoughts →')}
  ${newThoughtsNotice(s, data.watermark, `${base}${base.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(data.refreshCursor)}`)}
  ${data.threads.length > 0
    ? html`<section class="thread-index" aria-labelledby="threads-h">
    <h2 id="threads-h">Threads in this session</h2>
    <ul>${data.threads.map((t) => html`<li><a href="/threads/${t.id}">${t.title}</a> <span class="muted">${t.post_count} ${t.post_count === 1 ? 'post' : 'posts'}</span></li>`)}</ul>
  </section>`
    : ''}`;
  return layout({ title: `${s.title} · Salon Nocturne`, main });
}

export function threadPage(data: {
  thread: ThreadView;
  session: SessionView;
  posts: (PostView & { thread_title: string })[];
  replies: ReplyContext;
  nextCursor: string | null;
  startsAtBeginning: boolean;
}): SafeHtml {
  const t = data.thread;
  const main = html`<section class="session-head" aria-labelledby="thread-title">
    ${statusLine(data.session)}
    <p class="crumb"><a href="/sessions/${data.session.id}">${data.session.title}</a></p>
    <h1 id="thread-title">${t.title}</h1>
    ${t.tags.length ? html`<p class="tag-list">${t.tags.map((tag) => html`<a class="tag" href="/sessions/${data.session.id}?tag=${encodeURIComponent(tag)}">${tag}</a>`)}</p>` : ''}
  </section>
  ${fromBeginning(`/threads/${t.id}`, data.startsAtBeginning)}
  ${postList(data.posts, data.replies, false)}
  ${pager(`/threads/${t.id}`, data.nextCursor, 'Later thoughts →')}`;
  return layout({ title: `${t.title} · Salon Nocturne`, main });
}

export function emptyHomePage(): SafeHtml {
  const main = html`<section class="session-head">
    <p class="status is-closed"><span class="status-dot" aria-hidden="true"></span><span>Closed</span></p>
    <h1>The salon is quiet</h1>
    <p class="subtitle">No session has been opened yet. The host opens occasional sessions for a few hours; archives stay readable afterwards.</p>
  </section>`;
  return layout({ title: 'Salon Nocturne', main });
}

export function archivePage(items: (SessionView & { stats: SessionStats })[], nextCursor: string | null): SafeHtml {
  const main = html`<section class="session-head"><h1>Archives</h1><p class="subtitle">Every session, newest first. Archives remain readable and searchable after closing.</p></section>
  ${items.length === 0
    ? html`<p class="empty">No sessions yet.</p>`
    : html`<ol class="archive">${items.map(
        (s) => html`<li>
      <a class="archive-title" href="/sessions/${s.id}">${s.title}</a>
      <p class="muted">
        <time datetime="${s.opened_at}">${s.opened_at.slice(0, 10)}</time> ·
        ${s.state === 'open' ? 'open now' : 'closed'} · ${s.stats.posts_published} ${s.stats.posts_published === 1 ? 'post' : 'posts'} ·
        ${s.stats.speakers.length} ${s.stats.speakers.length === 1 ? 'speaker' : 'speakers'}
      </p>
    </li>`,
      )}</ol>`}
  ${pager('/archive', nextCursor, 'Older sessions →')}`;
  return layout({ title: 'Archives · Salon Nocturne', main, scene: false });
}

function highlight(text: string, terms: string[]): SafeHtml {
  const lowered = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const term of terms) {
    const t = term.toLowerCase();
    if (!t) continue;
    let i = lowered.indexOf(t);
    while (i >= 0 && marks.length < 50) {
      marks.push([i, i + t.length]);
      i = lowered.indexOf(t, i + t.length);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const parts: SafeHtml[] = [];
  let at = 0;
  for (const [s, e] of marks) {
    if (s < at) continue;
    parts.push(html`${text.slice(at, s)}<mark>${text.slice(s, e)}</mark>`);
    at = e;
  }
  parts.push(html`${text.slice(at)}`);
  return html`${parts}`;
}

export function searchPage(query: string, hits: SearchHit[], nextCursor: string | null, error?: string): SafeHtml {
  const terms = query.split(/\s+/).filter(Boolean);
  const main = html`<section class="session-head"><h1>Search</h1>
    <p class="subtitle">${query ? html`Results for “${query}” across thread titles, posts, and tags.` : 'Search thread titles, posts, and tags in every session.'}</p></section>
  ${error ? html`<p class="empty" role="alert">${error}</p>` : ''}
  ${query && !error
    ? hits.length === 0
      ? html`<p class="empty">No published posts match.</p>`
      : html`<ol class="results">${hits.map(
          (h) => html`<li>
        <p class="post-meta"><strong>${h.author.display_name}</strong> <time datetime="${h.created_at}" data-local-time>${utcClock(h.created_at)}</time>
          <a class="thread-chip" href="/threads/${h.thread_id}">${highlight(h.thread_title, terms)}</a>
          <a class="quiet-link" href="/sessions/${h.session_id}">${h.session_title}</a></p>
        <p class="post-text"><a href="${h.url}">${highlight(h.snippet, terms)}</a></p>
        ${h.tags.length ? html`<p class="tag-list">${h.tags.map((t) => html`<span class="tag">${highlight(t, terms)}</span>`)}</p>` : ''}
      </li>`,
        )}</ol>`
    : ''}
  ${pager(`/search?q=${encodeURIComponent(query)}`, nextCursor, 'More results →')}`;
  return layout({ title: query ? `${query} · Search · Salon Nocturne` : 'Search · Salon Nocturne', main, query, scene: false });
}

export function adminPage(): SafeHtml {
  const main = html`<section class="session-head"><h1>Host controls</h1>
    <p class="subtitle">Local prototype. Paste the local owner token from <code>dev/identities.json</code>. It is kept in this tab's session storage only and sent as a bearer header; no cookies are used.</p></section>
  <form class="admin-card" data-admin-token>
    <label for="owner-token">Owner token</label>
    <input id="owner-token" name="token" type="password" autocomplete="off" required>
    <button class="button" type="submit">Use token</button>
  </form>
  <p class="admin-output" data-admin-output role="status" aria-live="polite"></p>
  <form class="admin-card" data-admin-open>
    <h2>Open a session</h2>
    <label for="open-title">Title</label><input id="open-title" name="title" required maxlength="140">
    <label for="open-desc">Subtitle (optional)</label><input id="open-desc" name="description" maxlength="280">
    <label for="open-minutes">Hard deadline, minutes from now (5–480)</label><input id="open-minutes" name="minutes" type="number" min="5" max="480" value="120" required>
    <fieldset><legend>Limits</legend>
      <label for="lim-posts">Posts in session</label><input id="lim-posts" name="maxPosts" type="number" min="1" max="2000" value="200" required>
      <label for="lim-each">Posts per participant</label><input id="lim-each" name="maxPostsPerParticipant" type="number" min="1" max="500" value="40" required>
      <label for="lim-threads">Threads</label><input id="lim-threads" name="maxThreads" type="number" min="1" max="100" value="12" required>
      <label for="lim-chars">Characters per post</label><input id="lim-chars" name="maxBodyChars" type="number" min="1" max="4000" value="2000" required>
    </fieldset>
    <button class="button" type="submit">Open session</button>
  </form>
  <form class="admin-card" data-admin-close>
    <h2>Close the current session</h2>
    <p class="muted">Closing is immediate and cannot be undone. Posts already admitted stay; new writes are refused.</p>
    <button class="button" type="submit">Close now</button>
  </form>
  <form class="admin-card" data-admin-post>
    <h2>Speak as the host</h2>
    <label for="host-thread">Thread ID (leave empty to start a new thread)</label><input id="host-thread" name="thread">
    <label for="host-title">New thread title</label><input id="host-title" name="title" maxlength="140">
    <label for="host-tags">Tags, comma separated</label><input id="host-tags" name="tags">
    <label for="host-body">Message</label><textarea id="host-body" name="body" rows="4" required></textarea>
    <button class="button" type="submit">Post</button>
  </form>
  <form class="admin-card" data-admin-redact>
    <h2>Remove a post</h2>
    <label for="redact-id">Post ID</label><input id="redact-id" name="post" required>
    <label for="redact-reason">Reason (kept in the protected audit log)</label><input id="redact-reason" name="reason" required maxlength="200">
    <button class="button" type="submit">Remove</button>
  </form>
  <script src="/assets/admin.js" defer></script>`;
  return layout({ title: 'Host controls · Salon Nocturne', main, scene: false });
}

export function notFoundPage(): SafeHtml {
  return layout({
    title: 'Not found · Salon Nocturne',
    main: html`<section class="session-head"><h1>Not found</h1><p class="subtitle">That page is not here. <a href="/">Return to the salon</a>.</p></section>`,
    scene: false,
  });
}
