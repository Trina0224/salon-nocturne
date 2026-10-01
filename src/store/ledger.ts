// The write side. Every mutation runs inside one BEGIN IMMEDIATE transaction
// that performs, in order: trusted-clock read, access recheck, idempotency
// lookup, session/deadline/generation check, quota reservation, change event,
// durable write, and receipt. SPEC.md §3 requires these to be one atomic unit.
//
// This is the local adapter. It does not prove D1 or Durable Object behavior;
// see SPEC.md §2 "Write-admission risk".

import type { Db } from '../infra/db.ts';
import { immediate } from '../infra/db.ts';
import type { Clock } from '../infra/clock.ts';
import { newId, payloadDigest } from '../infra/ids.ts';
import { ApiError, forbidden, invalid, notFound, sessionClosed } from '../domain/errors.ts';
import {
  codePoints,
  rejectFields,
  requireString,
  validateBody,
  validateDescription,
  validateLimits,
  validateTags,
  validateTitle,
} from '../domain/content.ts';
import {
  HARD_CAPS,
  effectiveStatus,
  toIso,
  type Actor,
  type Post,
  type Scope,
  type Session,
  type Thread,
  type WriteOperation,
} from '../domain/model.ts';
import { displayNames, loadPost, loadSession, loadThread, postFromRow } from './rows.ts';
import { isCredentialActive } from './identities.ts';
import { postView, sessionView, threadView, type PostView, type SessionView, type ThreadView } from './views.ts';

export interface LedgerHooks {
  /** Test seam: runs after the write lock is taken, before the clock is read. */
  beforeAdmission?: () => void;
}

export interface WriteResult<T> {
  /** 201 for a new write, 200 for an idempotent replay or no-op. */
  status: 200 | 201;
  value: T;
}

type Body = Record<string, unknown>;

const SPOOF_FIELDS = ['author_id', 'author', 'created_by', 'participant_id'];

function requireInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid(`${field} must be an integer.`);
  return value;
}

function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 64) throw invalid(`${field} must be a post ID or null.`);
  return value;
}

const quotaExhausted = (what: string) =>
  new ApiError(429, 'QUOTA_EXHAUSTED', `The ${what} budget for this session is exhausted. Stop posting in this session.`, true);

export class Ledger {
  readonly db: Db;
  readonly clock: Clock;
  readonly hooks: LedgerHooks;

  constructor(db: Db, clock: Clock, hooks: LedgerHooks = {}) {
    this.db = db;
    this.clock = clock;
    this.hooks = hooks;
  }

  // ---- owner: sessions ----------------------------------------------------

  openSession(actor: Actor, raw: Body): SessionView {
    const title = validateTitle(raw.title);
    const description = validateDescription(raw.description);
    const limits = validateLimits(raw.limits);

    return immediate(this.db, () => {
      const nowMs = this.admit(actor, 'admin');
      const endsMs = resolveDeadline(raw, nowMs);
      const nowIso = toIso(nowMs);
      this.materializeExpired(nowMs);
      if (this.db.prepare("SELECT 1 FROM sessions WHERE state = 'open'").get()) {
        throw new ApiError(409, 'SESSION_ALREADY_OPEN', 'Close the current session before opening another.');
      }
      const generation = Number(this.db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS g FROM sessions').get()!.g);
      const id = newId('ses');
      this.db
        .prepare(
          `INSERT INTO sessions (id, generation, title, description, state, opened_at, hard_ends_at, revision,
             max_posts, max_posts_per_participant, max_threads, max_body_chars, opened_by)
           VALUES (?, ?, ?, ?, 'open', ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .run(id, generation, title, description, nowIso, toIso(endsMs), limits.maxPosts,
          limits.maxPostsPerParticipant, limits.maxThreads, limits.maxBodyChars, actor.participantId);
      this.appendChange(id, 'session', id, 'upsert', 1, nowIso);
      this.audit(actor, 'open_session', 'session', id, null, nowIso);
      return sessionView(loadSession(this.db, id)!, nowMs);
    });
  }

  closeSession(actor: Actor, sessionId: string, raw: Body): WriteResult<SessionView> {
    const expected = requireInt(raw.expected_revision, 'expected_revision');

    return immediate(this.db, () => {
      const nowMs = this.admit(actor, 'admin');
      const s = loadSession(this.db, sessionId);
      if (!s) throw notFound('Session');
      // Idempotent: closing a closed session succeeds without a new revision.
      if (s.state === 'closed') return { status: 200, value: sessionView(s, nowMs) };
      if (expected !== s.revision) {
        throw new ApiError(409, 'REVISION_CONFLICT', `The session is at revision ${s.revision}.`);
      }
      const nowIso = toIso(nowMs);
      const pastDeadline = effectiveStatus(s, nowMs).state === 'closed';
      this.markClosed(s, pastDeadline ? s.hardEndsAt : nowIso, pastDeadline ? 'deadline' : 'owner', nowIso);
      this.audit(actor, 'close_session', 'session', s.id, null, nowIso);
      return { status: 200, value: sessionView(loadSession(this.db, s.id)!, nowMs) };
    });
  }

  // ---- participants: append-only writes -----------------------------------

  createThread(actor: Actor, sessionId: string, raw: Body, key: string): WriteResult<{ thread: ThreadView; post: PostView }> {
    rejectFields(raw, SPOOF_FIELDS);
    const title = validateTitle(raw.title);
    const tags = validateTags(raw.tags);
    const body = validateBody(raw.body, HARD_CAPS.maxBodyChars);
    const generation = requireInt(raw.generation, 'generation');
    const digest = payloadDigest({ title, tags, body, generation });

    return immediate(this.db, () => {
      const nowMs = this.admit(actor, 'post');
      const s = loadSession(this.db, sessionId);
      if (!s) throw notFound('Session');
      const prior = this.findReceipt(actor, s.id, 'create_thread', key, digest);
      if (prior) return { status: 200, value: this.threadWithFirstPost(prior) };

      this.assertWritable(s, nowMs, generation);
      this.assertBodyFits(s, body);
      if (s.threadsUsed >= s.limits.maxThreads) throw quotaExhausted('thread');
      this.reservePost(s, actor);
      this.db.prepare('UPDATE sessions SET threads_used = threads_used + 1 WHERE id = ?').run(s.id);

      const nowIso = toIso(nowMs);
      const threadId = newId('thr');
      const threadSeq = this.appendChange(s.id, 'thread', threadId, 'upsert', 1, nowIso);
      this.db
        .prepare('INSERT INTO threads (id, seq, session_id, title, tags, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(threadId, threadSeq, s.id, title, JSON.stringify(tags), actor.participantId, nowIso);
      const thread: Thread = { id: threadId, seq: threadSeq, sessionId: s.id, title, tags, createdBy: actor.participantId, createdAt: nowIso };
      this.insertPost(s, thread, actor, body, null, nowIso);
      this.saveReceipt(actor, s.id, 'create_thread', key, digest, 'thread', threadId, nowIso);
      return { status: 201, value: this.threadWithFirstPost(threadId) };
    });
  }

  createPost(actor: Actor, threadId: string, raw: Body, key: string): WriteResult<PostView> {
    rejectFields(raw, SPOOF_FIELDS);
    const body = validateBody(raw.body, HARD_CAPS.maxBodyChars);
    const replyTo = optionalId(raw.reply_to_post_id, 'reply_to_post_id');
    const claimedSession = requireString(raw.session_id, 'session_id');
    const generation = requireInt(raw.generation, 'generation');
    const digest = payloadDigest({ threadId, body, replyTo, claimedSession, generation });

    return immediate(this.db, () => {
      const nowMs = this.admit(actor, 'post');
      const thread = loadThread(this.db, threadId);
      if (!thread) throw notFound('Thread');
      const s = loadSession(this.db, thread.sessionId)!;
      const prior = this.findReceipt(actor, s.id, 'create_post', key, digest);
      if (prior) return { status: 200, value: this.postResult(prior) };

      if (claimedSession !== s.id) {
        throw new ApiError(409, 'STALE_SESSION', 'This thread belongs to a different session.', true);
      }
      this.assertWritable(s, nowMs, generation);
      this.assertBodyFits(s, body);
      if (replyTo !== null) {
        // One error for missing, cross-thread, and removed targets: no leaks.
        const target = loadPost(this.db, replyTo);
        if (!target || target.threadId !== thread.id || target.publicationState !== 'published') {
          throw new ApiError(400, 'INVALID_REPLY_TARGET', 'reply_to_post_id must be a visible post in this thread.');
        }
      }
      this.reservePost(s, actor);
      const nowIso = toIso(nowMs);
      const postId = this.insertPost(s, thread, actor, body, replyTo, nowIso);
      this.saveReceipt(actor, s.id, 'create_post', key, digest, 'post', postId, nowIso);
      return { status: 201, value: this.postResult(postId) };
    });
  }

  // ---- owner: moderation and access ---------------------------------------

  /** Available after closing and after budget exhaustion; uses no quota. */
  moderatePost(actor: Actor, postId: string, raw: Body): WriteResult<PostView> {
    if (raw.action !== 'redact') throw invalid('action must be "redact".');
    const reason = validateTitle(raw.reason, 'reason', 200);
    const expected = requireInt(raw.expected_revision, 'expected_revision');

    return immediate(this.db, () => {
      const nowMs = this.admit(actor, 'admin');
      const p = loadPost(this.db, postId);
      if (!p) throw notFound('Post');
      if (p.publicationState === 'redacted') return { status: 200, value: this.postResult(p.id) };
      if (expected !== p.revision) {
        throw new ApiError(409, 'REVISION_CONFLICT', `The post is at revision ${p.revision}.`);
      }
      const nowIso = toIso(nowMs);
      // The text is discarded, not hidden: no public or protected copy remains.
      this.db
        .prepare("UPDATE posts SET body = '', publication_state = 'redacted', revision = revision + 1 WHERE id = ?")
        .run(p.id);
      this.db.prepare('DELETE FROM post_search WHERE rowid = ?').run(p.seq);
      this.appendChange(p.sessionId, 'post', p.id, 'tombstone', p.revision + 1, nowIso);
      this.audit(actor, 'redact_post', 'post', p.id, reason, nowIso);
      return { status: 200, value: this.postResult(p.id) };
    });
  }

  revokeParticipant(actor: Actor, participantId: string, raw: Body): WriteResult<{ id: string; status: 'revoked' }> {
    const reason = validateTitle(raw.reason, 'reason', 200);
    return immediate(this.db, () => {
      const nowMs = this.admit(actor, 'admin');
      const p = this.db.prepare('SELECT role, status FROM participants WHERE id = ?').get(participantId);
      if (!p) throw notFound('Participant');
      if (p.role === 'owner') throw invalid('The owner identity cannot be revoked through this route.');
      if (p.status === 'revoked') return { status: 200, value: { id: participantId, status: 'revoked' } };
      const nowIso = toIso(nowMs);
      this.db.prepare("UPDATE participants SET status = 'revoked', revoked_at = ? WHERE id = ?").run(nowIso, participantId);
      this.db.prepare('UPDATE credentials SET revoked_at = ? WHERE participant_id = ? AND revoked_at IS NULL').run(nowIso, participantId);
      this.audit(actor, 'revoke_participant', 'participant', participantId, reason, nowIso);
      return { status: 200, value: { id: participantId, status: 'revoked' } };
    });
  }

  // ---- admission internals --------------------------------------------------

  /** Final admission: trusted time is read here, after the write lock is held. */
  private admit(actor: Actor, scope: Scope): number {
    this.hooks.beforeAdmission?.();
    const nowMs = this.clock.now();
    if (!isCredentialActive(this.db, actor)) {
      throw new ApiError(403, 'REVOKED', 'This credential has been revoked. Stop session work.', true);
    }
    if (!actor.scopes.includes(scope)) throw forbidden(`This credential lacks the "${scope}" scope.`);
    if (scope === 'admin' && actor.role !== 'owner') throw forbidden('Only the owner may do this.');
    return nowMs;
  }

  private assertWritable(s: Session, nowMs: number, generation: number): void {
    if (generation !== s.generation) {
      throw new ApiError(409, 'STALE_SESSION', `This session is generation ${s.generation}.`, true);
    }
    if (effectiveStatus(s, nowMs).state !== 'open') throw sessionClosed();
  }

  private assertBodyFits(s: Session, body: string): void {
    if (codePoints(body) > s.limits.maxBodyChars) {
      throw new ApiError(413, 'TOO_LARGE', `body exceeds ${s.limits.maxBodyChars} characters for this session.`);
    }
  }

  private reservePost(s: Session, actor: Actor): void {
    if (s.postsUsed >= s.limits.maxPosts) throw quotaExhausted('session post');
    const usage = this.db
      .prepare('SELECT posts_used FROM participant_usage WHERE session_id = ? AND participant_id = ?')
      .get(s.id, actor.participantId);
    if (usage && Number(usage.posts_used) >= s.limits.maxPostsPerParticipant) throw quotaExhausted('participant post');
    const reserved = this.db
      .prepare('UPDATE sessions SET posts_used = posts_used + 1 WHERE id = ? AND posts_used < max_posts')
      .run(s.id);
    if (reserved.changes !== 1) throw quotaExhausted('session post');
    this.db
      .prepare(
        `INSERT INTO participant_usage (session_id, participant_id, posts_used) VALUES (?, ?, 1)
         ON CONFLICT (session_id, participant_id) DO UPDATE SET posts_used = posts_used + 1`,
      )
      .run(s.id, actor.participantId);
  }

  private insertPost(s: Session, thread: Thread, actor: Actor, body: string, replyTo: string | null, nowIso: string): string {
    const id = newId('post');
    const seq = this.appendChange(s.id, 'post', id, 'upsert', 1, nowIso);
    this.db
      .prepare(
        `INSERT INTO posts (id, seq, session_id, thread_id, author_id, reply_to_post_id, body, created_at, revision, publication_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'published')`,
      )
      .run(id, seq, s.id, thread.id, actor.participantId, replyTo, body, nowIso);
    this.db
      .prepare('INSERT INTO post_search (rowid, post_id, thread_title, body, tags) VALUES (?, ?, ?, ?, ?)')
      .run(seq, id, thread.title, body, thread.tags.join(' '));
    return id;
  }

  private findReceipt(actor: Actor, sessionId: string, op: WriteOperation, key: string, digest: string): string | null {
    const r = this.db
      .prepare(
        `SELECT payload_digest, result_id FROM write_receipts
         WHERE participant_id = ? AND session_id = ? AND operation = ? AND idempotency_key = ?`,
      )
      .get(actor.participantId, sessionId, op, key);
    if (!r) return null;
    if (r.payload_digest !== digest) {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different payload.');
    }
    return String(r.result_id);
  }

  private saveReceipt(actor: Actor, sessionId: string, op: WriteOperation, key: string, digest: string,
    resultType: string, resultId: string, nowIso: string): void {
    this.db
      .prepare(
        `INSERT INTO write_receipts (participant_id, session_id, operation, idempotency_key, payload_digest, result_type, result_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(actor.participantId, sessionId, op, key, digest, resultType, resultId, nowIso);
  }

  private appendChange(sessionId: string, type: 'session' | 'thread' | 'post', id: string,
    op: 'upsert' | 'tombstone', revision: number, nowIso: string): number {
    const r = this.db
      .prepare('INSERT INTO changes (session_id, resource_type, resource_id, op, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, type, id, op, revision, nowIso);
    return Number(r.lastInsertRowid);
  }

  private audit(actor: Actor, action: string, targetType: string, targetId: string, reason: string | null, nowIso: string): void {
    this.db
      .prepare('INSERT INTO audit_log (actor_id, action, target_type, target_id, reason, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(actor.participantId, action, targetType, targetId, reason, nowIso);
  }

  private markClosed(s: Session, closedAt: string, reason: 'owner' | 'deadline', nowIso: string): void {
    this.db
      .prepare("UPDATE sessions SET state = 'closed', closed_at = ?, close_reason = ?, revision = revision + 1 WHERE id = ?")
      .run(closedAt, reason, s.id);
    this.appendChange(s.id, 'session', s.id, 'upsert', s.revision + 1, nowIso);
  }

  /** Records deadline closures lazily; effective state never depended on this. */
  private materializeExpired(nowMs: number): void {
    const nowIso = toIso(nowMs);
    const rows = this.db.prepare("SELECT id FROM sessions WHERE state = 'open' AND hard_ends_at <= ?").all(nowIso);
    for (const r of rows) {
      const s = loadSession(this.db, String(r.id))!;
      this.markClosed(s, s.hardEndsAt, 'deadline', nowIso);
    }
  }

  private postResult(postId: string): PostView {
    const p = loadPost(this.db, postId)!;
    return postView(p, displayNames(this.db, [p.authorId]).get(p.authorId)!);
  }

  private threadWithFirstPost(threadId: string): { thread: ThreadView; post: PostView } {
    const t = loadThread(this.db, threadId)!;
    const first: Post = postFromRow(this.db.prepare('SELECT * FROM posts WHERE thread_id = ? ORDER BY seq LIMIT 1').get(threadId)!);
    return { thread: threadView(t), post: this.postResult(first.id) };
  }
}

function resolveDeadline(raw: Body, nowMs: number): number {
  const hasAt = raw.hard_ends_at !== undefined;
  const hasDuration = raw.duration_minutes !== undefined;
  if (hasAt === hasDuration) throw invalid('Provide exactly one of hard_ends_at or duration_minutes.');
  let endsMs: number;
  if (hasAt) {
    const at = requireString(raw.hard_ends_at, 'hard_ends_at');
    endsMs = Date.parse(at);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || Number.isNaN(endsMs)) throw invalid('hard_ends_at must be an RFC 3339 timestamp.');
  } else {
    endsMs = nowMs + requireInt(raw.duration_minutes, 'duration_minutes') * 60_000;
  }
  const minutes = (endsMs - nowMs) / 60_000;
  if (minutes < HARD_CAPS.minSessionMinutes || minutes > HARD_CAPS.maxSessionMinutes) {
    throw invalid(`The deadline must be between ${HARD_CAPS.minSessionMinutes} minutes and ${HARD_CAPS.maxSessionMinutes / 60} hours from now.`);
  }
  return endsMs;
}
