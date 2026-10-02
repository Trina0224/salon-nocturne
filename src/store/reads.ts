// The read side: public archive, participant change feed, search, export.
// Every listing is bounded by item count and UTF-8 bytes and paginated by the
// committed change sequence. Queries join display names in the database to
// keep D1 round trips and rows read low.

import type { SqlDb, SqlValue, Row } from '../infra/sql.ts';
import type { Clock } from '../infra/clock.ts';
import { CursorCodec, type CursorState } from '../infra/cursor.ts';
import { sha256Hex, utf8Length } from '../infra/crypto.ts';
import { ApiError, invalid, notFound } from '../domain/errors.ts';
import { codePoints } from '../domain/content.ts';
import { effectiveStatus, toIso, type Actor, type Session } from '../domain/model.ts';
import { loadPost, loadSession, loadThread, postFromRow, sessionFromRow, threadFromRow } from './rows.ts';
import { postView, sessionView, threadView, type PostView, type SessionView, type ThreadView } from './views.ts';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
/** Hard cap on the UTF-8 size of any paginated JSON response. */
export const PAGE_BYTE_CAP = 256 * 1024;
// Room for cursors, the schema_version wrapper, and has_more flags, which are
// added after items are chosen.
const ENVELOPE_RESERVE = 1024;
// Posts shown before a linked post when a page opens at that post.
const AT_CONTEXT = 3;
const MAX_EXPORT_POSTS = 5000;
const MAX_QUERY_CHARS = 100;
const MAX_QUERY_TERMS = 5;
// One- and two-character terms cannot use the trigram index; they scan only
// this many of the most recent change sequences to bound rows read.
export const SHORT_TERM_SEQ_WINDOW = 50_000;

export interface ReadLimits {
  /** Largest export, in UTF-8 bytes of the JSON document. */
  exportByteCap: number;
}

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

export interface PostPage extends Page<PostView & { thread_title: string }> {
  /** Highest committed sequence this page's snapshot includes. */
  watermark: number;
  /** Same starting point, fresh snapshot: use to show newly arrived posts. */
  refresh_cursor: string;
  /** False when the page starts after the first post of the listing. */
  starts_at_beginning: boolean;
}

export const utf8Bytes = (value: unknown) => utf8Length(JSON.stringify(value));

/**
 * Keeps items in order while the whole response, envelope included, stays
 * within PAGE_BYTE_CAP UTF-8 bytes. At least one item is always kept (a single
 * maximal post is far below the cap), so pagination always makes progress.
 */
export function fitToBudget<T>(envelope: unknown, items: T[]): { kept: T[]; truncated: boolean } {
  let used = utf8Bytes(envelope) + ENVELOPE_RESERVE;
  const kept: T[] = [];
  for (const item of items) {
    const size = utf8Bytes(item) + 1;
    if (kept.length > 0 && used + size > PAGE_BYTE_CAP) return { kept, truncated: true };
    used += size;
    kept.push(item);
  }
  return { kept, truncated: false };
}

export interface SessionStats {
  posts_published: number;
  speakers: { id: string; display_name: string }[];
  latest_seq: number;
  /** Sequence of the newest post in the session (0 if none). */
  latest_post_seq: number;
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

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** Builds a post view from a row that also carries `author_name`. */
function postViewFromRow(r: Row): PostView {
  return postView(postFromRow(r), String(r.author_name ?? 'Unknown'));
}

export class ReadModel {
  readonly db: SqlDb;
  readonly clock: Clock;
  readonly cursors: CursorCodec;
  readonly limits: ReadLimits;

  constructor(db: SqlDb, clock: Clock, cursors: CursorCodec, limits: ReadLimits) {
    this.db = db;
    this.clock = clock;
    this.cursors = cursors;
    this.limits = limits;
  }

  // ---- public status and archive -------------------------------------------

  /** The latest session (open or not). Never cached past a transition. */
  async currentSession(): Promise<{ session: SessionView | null; stats: SessionStats | null; server_now: string }> {
    const nowMs = this.clock.now();
    const r = await this.db.first('SELECT * FROM sessions ORDER BY generation DESC LIMIT 1');
    if (!r) return { session: null, stats: null, server_now: toIso(nowMs) };
    const s = sessionFromRow(r);
    return { session: sessionView(s, nowMs), stats: await this.stats(s.id), server_now: toIso(nowMs) };
  }

  async listSessions(cursorRaw: string | undefined, limit: number): Promise<Page<SessionView & { stats: SessionStats }>> {
    const nowMs = this.clock.now();
    const scope = 'sessions';
    const cur = await this.cursors.decode(cursorRaw, scope, nowMs);
    const before = cur ? cur.after : Number.MAX_SAFE_INTEGER;
    const rows = (await this.db.all('SELECT * FROM sessions WHERE generation < ? ORDER BY generation DESC LIMIT ?', before, limit + 1))
      .map(sessionFromRow);
    const views: (SessionView & { stats: SessionStats })[] = [];
    for (const s of rows.slice(0, limit)) views.push({ ...sessionView(s, nowMs), stats: await this.stats(s.id) });
    const fit = fitToBudget({ items: [] }, views);
    const more = fit.truncated || rows.length > limit;
    const last = fit.kept.at(-1);
    return {
      items: fit.kept,
      has_more: more,
      next_cursor: more && last ? await this.cursors.encode({ scope, after: last.generation, watermark: 0 }, nowMs) : null,
    };
  }

  async sessionDetail(id: string): Promise<{ session: SessionView; stats: SessionStats; threads: (ThreadView & { post_count: number })[] }> {
    const nowMs = this.clock.now();
    const s = await loadSession(this.db, id);
    if (!s) throw notFound('Session');
    const threads = (await this.db.all(
      `SELECT t.*, (SELECT COUNT(*) FROM posts p WHERE p.thread_id = t.id) AS post_count
       FROM threads t WHERE t.session_id = ? ORDER BY t.seq LIMIT 200`,
      id,
    )).map((r) => ({ ...threadView(threadFromRow(r)), post_count: Number(r.post_count) }));
    return { session: sessionView(s, nowMs), stats: await this.stats(id), threads };
  }

  /** Lightweight public status of one specific session, for pages watching it. */
  async sessionStatus(id: string): Promise<{ session: SessionView; stats: SessionStats; server_now: string }> {
    const nowMs = this.clock.now();
    const s = await loadSession(this.db, id);
    if (!s) throw notFound('Session');
    return { session: sessionView(s, nowMs), stats: await this.stats(id), server_now: toIso(nowMs) };
  }

  /** All posts of a session in chronological order, optionally by thread tag. */
  async sessionPosts(sessionId: string, opts: { tag?: string; cursor?: string; limit: number }): Promise<PostPage> {
    if (!(await loadSession(this.db, sessionId))) throw notFound('Session');
    const tag = opts.tag?.trim().toLowerCase() || undefined;
    const scope = `session-posts:${sessionId}:${tag ?? ''}`;
    return this.ascendingPosts(scope, opts.cursor, opts.limit, { items: [] }, 0, (after, watermark, take) => {
      const tagClause = tag ? 'AND EXISTS (SELECT 1 FROM json_each(t.tags) WHERE value = ?)' : '';
      const params: SqlValue[] = [sessionId, after, watermark];
      if (tag) params.push(tag);
      params.push(take);
      return this.db.all(
        `SELECT p.*, t.title AS thread_title, pa.display_name AS author_name
         FROM posts p JOIN threads t ON t.id = p.thread_id JOIN participants pa ON pa.id = p.author_id
         WHERE p.session_id = ? AND p.seq > ? AND p.seq <= ? ${tagClause}
         ORDER BY p.seq LIMIT ?`,
        ...params,
      );
    });
  }

  /**
   * Posts of one thread. With `at` (and no cursor) the page opens a few posts
   * before that post, so links to posts on later pages still land on them.
   */
  async threadPosts(threadId: string, opts: { cursor?: string; limit: number; at?: string }): Promise<{ thread: ThreadView; session: SessionView } & PostPage> {
    const t = await loadThread(this.db, threadId);
    if (!t) throw notFound('Thread');
    const session = sessionView((await loadSession(this.db, t.sessionId))!, this.clock.now());
    let startAfter = 0;
    if (opts.at && !opts.cursor) {
      const target = await loadPost(this.db, opts.at);
      if (target && target.threadId === threadId) {
        const before = await this.db.all(
          'SELECT seq FROM posts WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
          threadId, target.seq, AT_CONTEXT + 1,
        );
        startAfter = before.length > AT_CONTEXT ? Number(before[AT_CONTEXT]!.seq) : 0;
      }
    }
    const page = await this.ascendingPosts(`thread-posts:${threadId}`, opts.cursor, opts.limit,
      { thread: threadView(t), session, items: [] }, startAfter, (after, watermark, take) =>
        this.db.all(
          `SELECT p.*, ? AS thread_title, pa.display_name AS author_name
           FROM posts p JOIN participants pa ON pa.id = p.author_id
           WHERE p.thread_id = ? AND p.seq > ? AND p.seq <= ? ORDER BY p.seq LIMIT ?`,
          t.title, threadId, after, watermark, take,
        ),
    );
    return { thread: threadView(t), session, ...page };
  }

  /** Author and visibility of reply targets, for "Replying to …" labels. */
  async replyContext(ids: Iterable<string>): Promise<Map<string, { author: string; state: 'published' | 'redacted' }>> {
    const out = new Map<string, { author: string; state: 'published' | 'redacted' }>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 90) {
      const chunk = unique.slice(i, i + 90);
      const rows = await this.db.all(
        `SELECT p.id, p.publication_state, pa.display_name FROM posts p JOIN participants pa ON pa.id = p.author_id
         WHERE p.id IN (${placeholders(chunk.length)})`,
        ...chunk,
      );
      for (const r of rows) out.set(String(r.id), { author: String(r.display_name), state: r.publication_state as 'published' | 'redacted' });
    }
    return out;
  }

  async post(postId: string): Promise<PostView> {
    const r = await this.db.first(
      'SELECT p.*, pa.display_name AS author_name FROM posts p JOIN participants pa ON pa.id = p.author_id WHERE p.id = ?',
      postId,
    );
    if (!r) throw notFound('Post');
    return postViewFromRow(r);
  }

  async postLocation(postId: string): Promise<{ thread_id: string } | null> {
    const p = await loadPost(this.db, postId);
    return p ? { thread_id: p.threadId } : null;
  }

  // ---- participant feed ------------------------------------------------------

  async me(actor: Actor) {
    const current = await this.db.first('SELECT * FROM sessions ORDER BY generation DESC LIMIT 1');
    const s = current ? sessionFromRow(current) : null;
    return {
      schema_version: 1,
      participant: { id: actor.participantId, display_name: actor.displayName, role: actor.role },
      scopes: actor.scopes,
      current_session: s ? { id: s.id, generation: s.generation, state: effectiveStatus(s, this.clock.now()).state } : null,
      budgets: s ? await this.budgets(s, actor) : null,
    };
  }

  async changes(actor: Actor, sessionId: string, cursorRaw: string | undefined, limit: number) {
    if (!actor.scopes.includes('read')) throw new ApiError(403, 'FORBIDDEN', 'This credential lacks the "read" scope.');
    const nowMs = this.clock.now();
    const s = await loadSession(this.db, sessionId);
    if (!s) throw notFound('Session');
    const scope = `changes:${sessionId}`;
    const cur = await this.cursors.decode(cursorRaw, scope, nowMs);
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
        next_cursor: cursorRaw ?? (await this.cursors.encode({ scope, after, watermark: 0 }, nowMs)),
        has_more: false,
      };
    }

    const rows = await this.db.all('SELECT * FROM changes WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?', sessionId, after, limit + 1);
    const envelope = {
      schema_version: 1,
      session: status,
      stop: false,
      budgets: await this.budgets(s, actor),
      poll: { suggested_interval_seconds: 30, jitter_seconds: 10, note: 'Polling is transport only. Silence is always allowed.' },
    };
    const candidates = await this.changeItems(rows.slice(0, limit), nowMs);
    const fit = fitToBudget({ ...envelope, changes: [] }, candidates);
    const last = fit.kept.length > 0 ? fit.kept.at(-1)!.seq : after;
    return {
      ...envelope,
      changes: fit.kept,
      next_cursor: await this.cursors.encode({ scope, after: last, watermark: 0 }, nowMs),
      has_more: fit.truncated || rows.length > limit,
    };
  }

  // ---- search ------------------------------------------------------------------

  async search(rawQuery: string | undefined, cursorRaw: string | undefined, limit: number): Promise<Page<SearchHit> & { query: string }> {
    const q = (rawQuery ?? '').trim().replace(/\s+/g, ' ');
    if (q.length === 0) throw invalid('q is required.');
    if (codePoints(q) > MAX_QUERY_CHARS) throw new ApiError(413, 'TOO_LARGE', `q exceeds ${MAX_QUERY_CHARS} characters.`);
    const terms = q.split(' ').slice(0, MAX_QUERY_TERMS);
    const nowMs = this.clock.now();
    const scope = `search:${(await sha256Hex(q.toLowerCase())).slice(0, 16)}`;
    const cur = await this.cursors.decode(cursorRaw, scope, nowMs);
    const watermark = cur?.watermark ?? (await this.maxSeq());

    // Trigram FTS for terms of 3+ characters; bounded LIKE for shorter terms
    // (two-character CJK words such as 建築 cannot use the trigram index).
    const where: string[] = ['s.rowid <= ?'];
    const params: SqlValue[] = [watermark];
    if (cur) {
      where.push('s.rowid < ?');
      params.push(cur.after);
    }
    const long = terms.filter((t) => codePoints(t) >= 3);
    const short = terms.filter((t) => codePoints(t) < 3);
    if (long.length > 0) {
      where.push('post_search MATCH ?');
      params.push(long.map((t) => `"${t.replaceAll('"', '""')}"`).join(' AND '));
    } else {
      where.push('s.rowid > ?');
      params.push(watermark - SHORT_TERM_SEQ_WINDOW);
    }
    for (const t of short) {
      const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(s.thread_title LIKE ? ESCAPE '\\' OR s.body LIKE ? ESCAPE '\\' OR s.tags LIKE ? ESCAPE '\\')");
      params.push(like, like, like);
    }
    params.push(limit + 1);
    const rows = await this.db.all(
      `SELECT s.rowid AS seq, p.*, t.title AS thread_title, t.tags AS thread_tags, se.title AS session_title,
              pa.display_name AS author_name
       FROM post_search s JOIN posts p ON p.seq = s.rowid JOIN threads t ON t.id = p.thread_id
       JOIN sessions se ON se.id = p.session_id JOIN participants pa ON pa.id = p.author_id
       WHERE ${where.join(' AND ')} AND p.publication_state = 'published'
       ORDER BY s.rowid DESC LIMIT ?`,
      ...params,
    );
    const candidates = rows.slice(0, limit);
    const hits: SearchHit[] = candidates.map((r) => {
      const p = postFromRow(r);
      return {
        post_id: p.id,
        thread_id: p.threadId,
        session_id: p.sessionId,
        session_title: String(r.session_title),
        thread_title: String(r.thread_title),
        tags: JSON.parse(String(r.thread_tags)) as string[],
        author: { id: p.authorId, display_name: String(r.author_name) },
        created_at: p.createdAt,
        snippet: snippet(p.body, terms),
        url: `/posts/${p.id}`,
      };
    });
    const fit = fitToBudget({ query: q, items: [] }, hits);
    const more = fit.truncated || rows.length > limit;
    const lastSeq = fit.kept.length > 0 ? Number(candidates[fit.kept.length - 1]!.seq) : 0;
    return {
      query: q,
      items: fit.kept,
      has_more: more,
      next_cursor: more ? await this.cursors.encode({ scope, after: lastSeq, watermark }, nowMs) : null,
    };
  }

  // ---- export ------------------------------------------------------------------

  /**
   * Current published representation only; redacted text is never included.
   * Bounded by post count and by bytes, checked before the document is built.
   */
  async exportSession(id: string) {
    const nowMs = this.clock.now();
    const s = await loadSession(this.db, id);
    if (!s) throw notFound('Session');
    const size = (await this.db.first(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS body_bytes FROM posts WHERE session_id = ?`,
      id,
    ))!;
    const tooLarge = new ApiError(413, 'TOO_LARGE', 'This session is too large for a single export.');
    if (Number(size.n) > MAX_EXPORT_POSTS || Number(size.body_bytes) > this.limits.exportByteCap) throw tooLarge;
    const threads = (await this.db.all(
      `SELECT t.*, pa.display_name AS creator_name FROM threads t JOIN participants pa ON pa.id = t.created_by
       WHERE t.session_id = ? ORDER BY t.seq`,
      id,
    ));
    const posts = await this.db.all(
      `SELECT p.*, pa.display_name AS author_name FROM posts p JOIN participants pa ON pa.id = p.author_id
       WHERE p.session_id = ? ORDER BY p.seq`,
      id,
    );
    const participants = new Map<string, string>();
    for (const r of threads) participants.set(String(r.created_by), String(r.creator_name));
    for (const r of posts) participants.set(String(r.author_id), String(r.author_name));
    const doc = {
      schema: 'salon-nocturne.conversation.v1',
      exported_at: toIso(nowMs),
      timezone: 'UTC',
      ordering: 'Posts are listed in committed server order (seq).',
      session: sessionView(s, nowMs),
      participants: [...participants].map(([pid, display_name]) => ({ id: pid, display_name })),
      threads: threads.map((r) => ({ ...threadView(threadFromRow(r)), created_by_display_name: String(r.creator_name) })),
      posts: posts.map((r) => {
        const p = postFromRow(r);
        return { ...postViewFromRow(r), seq: p.seq, redacted: p.publicationState === 'redacted' };
      }),
      media_manifest: { schema: 'salon-nocturne.media-manifest.v1', items: [] as unknown[] },
    };
    if (utf8Bytes(doc) > this.limits.exportByteCap + 1024 * 1024) throw tooLarge;
    return doc;
  }

  async exportTranscript(id: string): Promise<string> {
    const data = await this.exportSession(id);
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

  // ---- owner reads ---------------------------------------------------------------

  /** Participants and credential metadata for the owner; never digests or tokens. */
  async listParticipants() {
    const participants = await this.db.all(
      `SELECT id, display_name, role, status, created_at, revoked_at FROM participants WHERE role = 'agent' ORDER BY created_at, id LIMIT 200`,
    );
    const creds = await this.db.all(
      `SELECT c.id, c.participant_id, c.label, c.created_at, c.revoked_at FROM credentials c
       JOIN participants p ON p.id = c.participant_id WHERE p.role = 'agent' ORDER BY c.created_at`,
    );
    return participants.map((p) => ({
      ...p,
      credentials: creds.filter((c) => c.participant_id === p.id).map(({ participant_id: _omit, ...c }) => c),
    }));
  }

  // ---- internals ---------------------------------------------------------------

  /**
   * Ascending, gap-free pagination by committed sequence. A cursor freezes a
   * snapshot (watermark) so pages never shift while posts arrive; when the
   * snapshot is exhausted but newer posts exist, next_cursor continues into a
   * fresh snapshot instead of ending the listing. A cursor whose watermark is
   * negative means "fresh snapshot from this position" (see refresh_cursor).
   */
  private async ascendingPosts(scope: string, cursorRaw: string | undefined, limit: number, envelope: Record<string, unknown>,
    startAfter: number, fetch: (after: number, watermark: number, take: number) => Promise<Row[]>): Promise<PostPage> {
    const nowMs = this.clock.now();
    const cur: CursorState | null = await this.cursors.decode(cursorRaw, scope, nowMs);
    const latest = await this.maxSeq();
    const watermark = cur && cur.watermark >= 0 ? cur.watermark : latest;
    const after = cur ? cur.after : startAfter;
    const rows = await fetch(after, watermark, limit + 1);
    const candidates = rows.slice(0, limit);
    const views = candidates.map((r) => ({ ...postViewFromRow(r), thread_title: String(r.thread_title) }));
    const fit = fitToBudget(envelope, views);
    const lastSeq = fit.kept.length > 0 ? Number(candidates[fit.kept.length - 1]!.seq) : after;
    let next: string | null = null;
    if (fit.truncated || rows.length > limit) {
      next = await this.cursors.encode({ scope, after: lastSeq, watermark }, nowMs);
    } else if (watermark < latest && (await fetch(lastSeq, latest, 1)).length > 0) {
      next = await this.cursors.encode({ scope, after: lastSeq, watermark: -1 }, nowMs);
    }
    return {
      items: fit.kept,
      has_more: next !== null,
      next_cursor: next,
      watermark,
      refresh_cursor: await this.cursors.encode({ scope, after, watermark: -1 }, nowMs),
      starts_at_beginning: after === 0,
    };
  }

  /** Current representations for a page of changes, loaded in a few queries. */
  private async changeItems(rows: Row[], nowMs: number) {
    const ids = (type: string) => [...new Set(rows.filter((r) => r.resource_type === type).map((r) => String(r.resource_id)))];
    const load = async (type: string, sql: (n: number) => string) => {
      const out = new Map<string, Row>();
      const all = ids(type);
      for (let i = 0; i < all.length; i += 90) {
        const chunk = all.slice(i, i + 90);
        for (const r of await this.db.all(sql(chunk.length), ...chunk)) out.set(String(r.id), r);
      }
      return out;
    };
    const posts = await load('post', (n) =>
      `SELECT p.*, pa.display_name AS author_name FROM posts p JOIN participants pa ON pa.id = p.author_id WHERE p.id IN (${placeholders(n)})`);
    const threads = await load('thread', (n) => `SELECT * FROM threads WHERE id IN (${placeholders(n)})`);
    const sessions = await load('session', (n) => `SELECT * FROM sessions WHERE id IN (${placeholders(n)})`);
    return rows.map((r) => {
      const type = String(r.resource_type);
      const id = String(r.resource_id);
      const base = { seq: Number(r.seq), resource_type: type, resource_id: id, revision: Number(r.revision) };
      if (type === 'post') {
        const view = postViewFromRow(posts.get(id)!);
        // Current state wins: a later redaction turns earlier upserts into tombstones.
        return { ...base, op: view.state === 'redacted' ? 'tombstone' : 'upsert', data: view as unknown };
      }
      if (type === 'thread') return { ...base, op: 'upsert', data: threadView(threadFromRow(threads.get(id)!)) as unknown };
      return { ...base, op: 'upsert', data: sessionView(sessionFromRow(sessions.get(id)!), nowMs) as unknown };
    });
  }

  private async budgets(s: Session, actor: Actor) {
    const used = await this.db.first(
      'SELECT posts_used FROM participant_usage WHERE session_id = ? AND participant_id = ?',
      s.id, actor.participantId,
    );
    return {
      session_posts_remaining: s.limits.maxPosts - s.postsUsed,
      session_threads_remaining: s.limits.maxThreads - s.threadsUsed,
      your_posts_remaining: s.limits.maxPostsPerParticipant - (used ? Number(used.posts_used) : 0),
      max_body_chars: s.limits.maxBodyChars,
    };
  }

  /**
   * Index-backed and independent of session size: counters maintained at
   * admission, MAX over (session_id, seq) indexes, and redacted posts only.
   * This runs on every status poll, so it must stay cheap in rows read.
   */
  private async stats(sessionId: string): Promise<SessionStats> {
    const counts = (await this.db.first(
      `SELECT s.posts_used,
         (SELECT COUNT(*) FROM posts WHERE session_id = ?1 AND publication_state = 'redacted') AS redacted,
         (SELECT COALESCE(MAX(seq), 0) FROM changes WHERE session_id = ?1) AS latest,
         (SELECT COALESCE(MAX(seq), 0) FROM posts WHERE session_id = ?1) AS latest_post
       FROM sessions s WHERE s.id = ?1`,
      sessionId,
    ))!;
    // participant_usage rows are created on each participant's first post, so
    // rowid order is the order in which people first spoke.
    const speakerRows = await this.db.all(
      `SELECT u.participant_id, pa.display_name FROM participant_usage u JOIN participants pa ON pa.id = u.participant_id
       WHERE u.session_id = ? ORDER BY u.rowid LIMIT 50`,
      sessionId,
    );
    return {
      posts_published: Number(counts.posts_used) - Number(counts.redacted),
      speakers: speakerRows.map((r) => ({ id: String(r.participant_id), display_name: String(r.display_name) })),
      latest_seq: Number(counts.latest),
      latest_post_seq: Number(counts.latest_post),
    };
  }

  private async maxSeq(): Promise<number> {
    return Number((await this.db.first('SELECT COALESCE(MAX(seq), 0) AS s FROM changes'))!.s);
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
