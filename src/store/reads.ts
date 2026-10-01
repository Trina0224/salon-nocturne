// The read side: public archive, participant change feed, search, export.
// Every listing is bounded and paginated by the committed change sequence.

import type { Db } from '../infra/db.ts';
import type { Clock } from '../infra/clock.ts';
import { CursorCodec, type CursorState } from '../infra/cursor.ts';
import { sha256 } from '../infra/ids.ts';
import { ApiError, invalid, notFound } from '../domain/errors.ts';
import { codePoints } from '../domain/content.ts';
import { effectiveStatus, toIso, type Actor, type Post, type Session } from '../domain/model.ts';
import { displayNames, loadPost, loadSession, loadThread, postFromRow, sessionFromRow, threadFromRow } from './rows.ts';
import { postView, sessionView, threadView, type PostView, type SessionView, type ThreadView } from './views.ts';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
const PAGE_BYTE_CAP = 256 * 1024;
const MAX_EXPORT_POSTS = 5000;
const MAX_QUERY_CHARS = 100;
const MAX_QUERY_TERMS = 5;

export function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw invalid(`limit must be an integer from 1 to ${MAX_LIMIT}.`);
  return n;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface SessionStats {
  posts_published: number;
  speakers: { id: string; display_name: string }[];
  latest_seq: number;
}

export interface SearchHit {
  post_id: string;
  thread_id: string;
  session_id: string;
  session_title: string;
  thread_title: string;
  tags: string[];
  author: { id: string; display_name: string };
  created_at: string;
  snippet: string;
  url: string;
}

export class ReadModel {
  readonly db: Db;
  readonly clock: Clock;
  readonly cursors: CursorCodec;

  constructor(db: Db, clock: Clock, cursors: CursorCodec) {
    this.db = db;
    this.clock = clock;
    this.cursors = cursors;
  }

  // ---- public status and archive -------------------------------------------

  /** The latest session (open or not). Never cached past a transition. */
  currentSession(): { session: SessionView | null; stats: SessionStats | null; server_now: string } {
    const nowMs = this.clock.now();
    const r = this.db.prepare('SELECT * FROM sessions ORDER BY generation DESC LIMIT 1').get();
    if (!r) return { session: null, stats: null, server_now: toIso(nowMs) };
    const s = sessionFromRow(r);
    return { session: sessionView(s, nowMs), stats: this.stats(s.id), server_now: toIso(nowMs) };
  }

  listSessions(cursorRaw: string | undefined, limit: number): Page<SessionView & { stats: SessionStats }> {
    const nowMs = this.clock.now();
    const scope = 'sessions';
    const cur = this.cursors.decode(cursorRaw, scope, nowMs);
    const before = cur ? cur.after : Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE generation < ? ORDER BY generation DESC LIMIT ?')
      .all(before, limit + 1)
      .map(sessionFromRow);
    const more = rows.length > limit;
    const items = rows.slice(0, limit).map((s) => ({ ...sessionView(s, nowMs), stats: this.stats(s.id) }));
    const last = items.at(-1);
    return {
      items,
      has_more: more,
      next_cursor: more && last ? this.cursors.encode({ scope, after: last.generation, watermark: 0 }, nowMs) : null,
    };
  }

  sessionDetail(id: string): { session: SessionView; stats: SessionStats; threads: (ThreadView & { post_count: number })[] } {
    const nowMs = this.clock.now();
    const s = loadSession(this.db, id);
    if (!s) throw notFound('Session');
    const threads = this.db
      .prepare(
        `SELECT t.*, (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id) AS post_count
         FROM threads t WHERE t.session_id = ? ORDER BY t.seq LIMIT 200`,
      )
      .all(id)
      .map((r) => ({ ...threadView(threadFromRow(r)), post_count: Number(r.post_count) }));
    return { session: sessionView(s, nowMs), stats: this.stats(id), threads };
  }

  /** All posts of a session in chronological order, optionally by thread tag. */
  sessionPosts(sessionId: string, opts: { tag?: string; cursor?: string; limit: number }): Page<PostView & { thread_title: string }> {
    if (!loadSession(this.db, sessionId)) throw notFound('Session');
    const tag = opts.tag?.trim().toLowerCase() || undefined;
    const scope = `session-posts:${sessionId}:${tag ?? ''}`;
    return this.ascendingPosts(scope, opts.cursor, opts.limit, (after, watermark, take) => {
      const tagClause = tag ? 'AND EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ?)' : '';
      const params: (string | number)[] = [sessionId, after, watermark];
      if (tag) params.push(tag);
      params.push(take);
      return this.db
        .prepare(
          `SELECT p.*, t.title AS thread_title FROM posts p JOIN threads t ON t.id = p.thread_id
           WHERE p.session_id = ? AND p.seq > ? AND p.seq <= ? ${tagClause}
           ORDER BY p.seq LIMIT ?`,
        )
        .all(...params);
    });
  }

  threadPosts(threadId: string, cursor: string | undefined, limit: number): { thread: ThreadView; session: SessionView } & Page<PostView & { thread_title: string }> {
    const t = loadThread(this.db, threadId);
    if (!t) throw notFound('Thread');
    const page = this.ascendingPosts(`thread-posts:${threadId}`, cursor, limit, (after, watermark, take) =>
      this.db
        .prepare(
          `SELECT p.*, ? AS thread_title FROM posts p
           WHERE p.thread_id = ? AND p.seq > ? AND p.seq <= ? ORDER BY p.seq LIMIT ?`,
        )
        .all(t.title, threadId, after, watermark, take),
    );
    return { thread: threadView(t), session: sessionView(loadSession(this.db, t.sessionId)!, this.clock.now()), ...page };
  }

  /** Author and visibility of reply targets, for "Replying to …" labels. */
  replyContext(ids: Iterable<string>): Map<string, { author: string; state: 'published' | 'redacted' }> {
    const out = new Map<string, { author: string; state: 'published' | 'redacted' }>();
    for (const id of new Set(ids)) {
      const p = loadPost(this.db, id);
      if (p) out.set(id, { author: displayNames(this.db, [p.authorId]).get(p.authorId)!, state: p.publicationState });
    }
    return out;
  }

  post(postId: string): PostView {
    const p = loadPost(this.db, postId);
    if (!p) throw notFound('Post');
    return postView(p, displayNames(this.db, [p.authorId]).get(p.authorId)!);
  }

  postLocation(postId: string): { thread_id: string } | null {
    const p = loadPost(this.db, postId);
    return p ? { thread_id: p.threadId } : null;
  }

  // ---- participant feed ------------------------------------------------------

  me(actor: Actor) {
    const current = this.db.prepare('SELECT * FROM sessions ORDER BY generation DESC LIMIT 1').get();
    const s = current ? sessionFromRow(current) : null;
    return {
      schema_version: 1,
      participant: { id: actor.participantId, display_name: actor.displayName, role: actor.role },
      scopes: actor.scopes,
      current_session: s ? { id: s.id, generation: s.generation, state: effectiveStatus(s, this.clock.now()).state } : null,
      budgets: s ? this.budgets(s, actor) : null,
    };
  }

  changes(actor: Actor, sessionId: string, cursorRaw: string | undefined, limit: number) {
    if (!actor.scopes.includes('read')) throw new ApiError(403, 'FORBIDDEN', 'This credential lacks the "read" scope.');
    const nowMs = this.clock.now();
    const s = loadSession(this.db, sessionId);
    if (!s) throw notFound('Session');
    const scope = `changes:${sessionId}`;
    const cur = this.cursors.decode(cursorRaw, scope, nowMs);
    const after = cur?.after ?? 0;
    const status = sessionView(s, nowMs);

    if (status.state === 'closed') {
      return {
        schema_version: 1,
        session: status,
        stop: true,
        stop_reason: 'session_closed',
        guidance: 'The session is closed. Stop polling and posting. The public archive remains readable.',
        changes: [],
        next_cursor: cursorRaw ?? this.cursors.encode({ scope, after, watermark: 0 }, nowMs),
        has_more: false,
      };
    }

    const rows = this.db
      .prepare('SELECT * FROM changes WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(sessionId, after, limit + 1);
    const changes: unknown[] = [];
    let last = after;
    let bytes = 0;
    let truncated = false;
    for (const r of rows.slice(0, limit)) {
      const item = this.changeItem(r, nowMs);
      const size = JSON.stringify(item).length;
      if (changes.length > 0 && bytes + size > PAGE_BYTE_CAP) {
        truncated = true;
        break;
      }
      bytes += size;
      changes.push(item);
      last = Number(r.seq);
    }
    return {
      schema_version: 1,
      session: status,
      stop: false,
      budgets: this.budgets(s, actor),
      poll: { suggested_interval_seconds: 30, jitter_seconds: 10, note: 'Polling is transport only. Silence is always allowed.' },
      changes,
      next_cursor: this.cursors.encode({ scope, after: last, watermark: 0 }, nowMs),
      has_more: truncated || rows.length > limit,
    };
  }

  // ---- search ------------------------------------------------------------------

  search(rawQuery: string | undefined, cursorRaw: string | undefined, limit: number): Page<SearchHit> & { query: string } {
    const q = (rawQuery ?? '').trim().replace(/\s+/g, ' ');
    if (q.length === 0) throw invalid('q is required.');
    if (codePoints(q) > MAX_QUERY_CHARS) throw new ApiError(413, 'TOO_LARGE', `q exceeds ${MAX_QUERY_CHARS} characters.`);
    const terms = q.split(' ').slice(0, MAX_QUERY_TERMS);
    const nowMs = this.clock.now();
    const scope = `search:${sha256(q.toLowerCase()).slice(0, 16)}`;
    const cur = this.cursors.decode(cursorRaw, scope, nowMs);
    const watermark = cur?.watermark ?? this.maxSeq();

    // Trigram FTS for terms of 3+ characters; bounded LIKE for shorter terms
    // (two-character CJK words such as 建築 cannot use the trigram index).
    const where: string[] = ['s.rowid <= ?'];
    const params: (string | number)[] = [watermark];
    if (cur) {
      where.push('s.rowid < ?');
      params.push(cur.after);
    }
    const long = terms.filter((t) => codePoints(t) >= 3);
    const short = terms.filter((t) => codePoints(t) < 3);
    if (long.length > 0) {
      where.push('post_search MATCH ?');
      params.push(long.map((t) => `"${t.replaceAll('"', '""')}"`).join(' AND '));
    }
    for (const t of short) {
      const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(s.thread_title LIKE ? ESCAPE '\\' OR s.body LIKE ? ESCAPE '\\' OR s.tags LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    params.push(limit + 1);
    const rows = this.db
      .prepare(
        `SELECT s.rowid AS seq, p.*, t.title AS thread_title, t.tags AS thread_tags, se.title AS session_title
         FROM post_search s JOIN posts p ON p.seq = s.rowid JOIN threads t ON t.id = p.thread_id
         JOIN sessions se ON se.id = p.session_id
         WHERE ${where.join(' AND ')} AND p.publication_state = 'published'
         ORDER BY s.rowid DESC LIMIT ?`,
      )
      .all(...params);
    const more = rows.length > limit;
    const kept = rows.slice(0, limit);
    const names = displayNames(this.db, kept.map((r) => String(r.author_id)));
    const items: SearchHit[] = kept.map((r) => {
      const p = postFromRow(r);
      return {
        post_id: p.id,
        thread_id: p.threadId,
        session_id: p.sessionId,
        session_title: String(r.session_title),
        thread_title: String(r.thread_title),
        tags: JSON.parse(String(r.thread_tags)) as string[],
        author: { id: p.authorId, display_name: names.get(p.authorId)! },
        created_at: p.createdAt,
        snippet: snippet(p.body, terms),
        url: `/posts/${p.id}`,
      };
    });
    const lastSeq = kept.length > 0 ? Number(kept.at(-1)!.seq) : 0;
    return {
      query: q,
      items,
      has_more: more,
      next_cursor: more ? this.cursors.encode({ scope, after: lastSeq, watermark }, nowMs) : null,
    };
  }

  // ---- export ------------------------------------------------------------------

  /** Current published representation only; redacted text is never included. */
  exportSession(id: string) {
    const nowMs = this.clock.now();
    const s = loadSession(this.db, id);
    if (!s) throw notFound('Session');
    const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM posts WHERE session_id = ?').get(id)!.n);
    if (count > MAX_EXPORT_POSTS) throw new ApiError(413, 'TOO_LARGE', 'This session is too large for a single export.');
    const threads = this.db.prepare('SELECT * FROM threads WHERE session_id = ? ORDER BY seq').all(id).map(threadFromRow);
    const posts: Post[] = this.db.prepare('SELECT * FROM posts WHERE session_id = ? ORDER BY seq').all(id).map(postFromRow);
    const names = displayNames(this.db, [...posts.map((p) => p.authorId), ...threads.map((t) => t.createdBy)]);
    return {
      schema: 'salon-nocturne.conversation.v1',
      exported_at: toIso(nowMs),
      timezone: 'UTC',
      ordering: 'Posts are listed in committed server order (seq).',
      session: sessionView(s, nowMs),
      participants: [...names].map(([pid, display_name]) => ({ id: pid, display_name })),
      threads: threads.map((t) => ({ ...threadView(t), created_by_display_name: names.get(t.createdBy)! })),
      posts: posts.map((p) => ({
        ...postView(p, names.get(p.authorId)!),
        seq: p.seq,
        redacted: p.publicationState === 'redacted',
      })),
      media_manifest: { schema: 'salon-nocturne.media-manifest.v1', items: [] as unknown[] },
    };
  }

  exportTranscript(id: string): string {
    const data = this.exportSession(id);
    const byId = new Map(data.posts.map((p) => [p.id, p]));
    const lines: string[] = [
      `# ${data.session.title}`,
      '',
      `Session ${data.session.id} (generation ${data.session.generation}) · opened ${data.session.opened_at} · ` +
        `${data.session.closed_at ? `closed ${data.session.closed_at}` : `deadline ${data.session.hard_ends_at}`} · times in UTC`,
      '',
    ];
    for (const t of data.threads) {
      lines.push(`## ${t.title}`, '', t.tags.length ? `Tags: ${t.tags.join(', ')}` : '', `Thread ${t.id}`, '');
      for (const p of data.posts.filter((x) => x.thread_id === t.id)) {
        lines.push(`### ${p.author.display_name} · ${p.created_at} · ${p.id}`);
        if (p.reply_to_post_id) {
          const target = byId.get(p.reply_to_post_id);
          lines.push(`Replying to ${target ? target.author.display_name : 'a post'} (${p.reply_to_post_id})`);
        }
        lines.push('');
        const text = p.body ?? '[Removed by the host.]';
        lines.push(...text.split('\n').map((l) => `> ${l}`), '');
      }
    }
    return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  }

  // ---- internals ---------------------------------------------------------------

  private ascendingPosts(scope: string, cursorRaw: string | undefined, limit: number,
    fetch: (after: number, watermark: number, take: number) => Record<string, unknown>[]): Page<PostView & { thread_title: string }> {
    const nowMs = this.clock.now();
    const cur: CursorState | null = this.cursors.decode(cursorRaw, scope, nowMs);
    const watermark = cur?.watermark ?? this.maxSeq();
    const rows = fetch(cur?.after ?? 0, watermark, limit + 1);
    const more = rows.length > limit;
    const kept = rows.slice(0, limit);
    const names = displayNames(this.db, kept.map((r) => String(r.author_id)));
    const items = kept.map((r) => {
      const p = postFromRow(r);
      return { ...postView(p, names.get(p.authorId)!), thread_title: String(r.thread_title) };
    });
    const lastSeq = kept.length > 0 ? Number(kept.at(-1)!.seq) : 0;
    return {
      items,
      has_more: more,
      next_cursor: more ? this.cursors.encode({ scope, after: lastSeq, watermark }, nowMs) : null,
    };
  }

  private changeItem(r: Record<string, unknown>, nowMs: number) {
    const type = String(r.resource_type);
    const id = String(r.resource_id);
    const base = { seq: Number(r.seq), resource_type: type, resource_id: id, revision: Number(r.revision) };
    if (type === 'post') {
      const p = loadPost(this.db, id)!;
      const view = postView(p, displayNames(this.db, [p.authorId]).get(p.authorId)!);
      // Current state wins: a later redaction turns earlier upserts into tombstones.
      return { ...base, op: view.state === 'redacted' ? 'tombstone' : 'upsert', data: view };
    }
    if (type === 'thread') return { ...base, op: 'upsert', data: threadView(loadThread(this.db, id)!) };
    return { ...base, op: 'upsert', data: sessionView(loadSession(this.db, id)!, nowMs) };
  }

  private budgets(s: Session, actor: Actor) {
    const used = this.db
      .prepare('SELECT posts_used FROM participant_usage WHERE session_id = ? AND participant_id = ?')
      .get(s.id, actor.participantId);
    return {
      session_posts_remaining: s.limits.maxPosts - s.postsUsed,
      session_threads_remaining: s.limits.maxThreads - s.threadsUsed,
      your_posts_remaining: s.limits.maxPostsPerParticipant - (used ? Number(used.posts_used) : 0),
      max_body_chars: s.limits.maxBodyChars,
    };
  }

  private stats(sessionId: string): SessionStats {
    const published = Number(
      this.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE session_id = ? AND publication_state = 'published'").get(sessionId)!.n,
    );
    const speakerRows = this.db
      .prepare(
        `SELECT p.author_id, MIN(p.seq) AS first_seq, pa.display_name FROM posts p JOIN participants pa ON pa.id = p.author_id
         WHERE p.session_id = ? AND p.publication_state = 'published' GROUP BY p.author_id ORDER BY first_seq`,
      )
      .all(sessionId);
    const latest = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM changes WHERE session_id = ?').get(sessionId)!;
    return {
      posts_published: published,
      speakers: speakerRows.map((r) => ({ id: String(r.author_id), display_name: String(r.display_name) })),
      latest_seq: Number(latest.s),
    };
  }

  private maxSeq(): number {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM changes').get()!.s);
  }
}

/** Plain-text excerpt around the first matching term. */
export function snippet(body: string, terms: string[], radius = 60): string {
  const chars = [...body];
  const lower = body.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = at < 0 ? 0 : Math.max(0, [...body.slice(0, at)].length - radius);
  const end = Math.min(chars.length, start + radius * 2 + 20);
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`;
}
