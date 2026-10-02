// The write side. Every mutation is ONE batch (one transaction) on either
// adapter. Its first statement is a guarded insert into `admissions` that
// evaluates, at final admission and against current state:
//   trusted time → access still valid → target exists → session/generation →
//   open and before the deadline → size → reply target → quotas → write rate
// A failing check names its reason through a CHECK constraint, which aborts
// and rolls back the whole batch, so counters, change events, content, and
// receipts are written together or not at all. See docs/architecture.md.

import type { Clock } from '../infra/clock.ts';
import { stmt, failedCheck, isUniqueViolation, type SqlDb, type SqlValue, type Statement } from '../infra/sql.ts';
import { newAgentToken, newId, payloadDigest } from '../infra/ids.ts';
import { ApiError, forbidden, invalid, notFound, rateLimited, sessionClosed } from '../domain/errors.ts';
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
import { HARD_CAPS, toIso, type Actor, type Scope, type WriteOperation } from '../domain/model.ts';
import { displayNames, loadPost, loadSession, loadThread, postFromRow } from './rows.ts';
import { AGENT_SCOPES, OAUTH_BINDING_SCOPES, accessStillValidSql, isAccessValid, type Authenticator } from './auth.ts';
import { oauthBindingView, postView, sessionView, threadView, type OAuthBindingView, type PostView, type SessionView, type ThreadView } from './views.ts';

export interface LedgerHooks {
  /** Test seam: runs just before the admission batch is sent. */
  beforeAdmission?: () => void | Promise<void>;
}

export interface LedgerLimits {
  /** Posts (including thread openers) one participant may write per minute. */
  writesPerMinute: number;
}

export interface WriteResult<T> {
  /** 201 for a new write, 200 for an idempotent replay or no-op. */
  status: 200 | 201;
  value: T;
}

export interface IssuedCredential {
  participant: { id: string; display_name: string; role: 'agent'; status: string };
  credential: { id: string; token: string; scopes: Scope[]; created_at: string };
}

type Body = Record<string, unknown>;

const SPOOF_FIELDS = ['author_id', 'author', 'created_by', 'participant_id'];
const ISO = "'%Y-%m-%dT%H:%M:%fZ'";

function requireInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid(`${field} must be an integer.`);
  return value;
}

function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 64) throw invalid(`${field} must be a post ID or null.`);
  return value;
}

/** Accumulates SQL text and its anonymous `?` parameters in textual order. */
class Query {
  private readonly parts: string[] = [];
  private readonly values: SqlValue[] = [];

  add(sql: string, ...params: SqlValue[]): this {
    this.parts.push(sql);
    this.values.push(...params);
    return this;
  }

  build(): Statement {
    return { sql: this.parts.join('\n'), params: this.values };
  }
}

/** Maps a guard reason to the API error the caller sees. */
function admissionError(reason: string, notFoundWhat: string): ApiError {
  switch (reason) {
    case 'REVOKED':
      return new ApiError(403, 'REVOKED', 'This credential has been revoked. Stop session work.', true);
    case 'NOT_FOUND':
      return notFound(notFoundWhat);
    case 'STALE_SESSION':
      return new ApiError(409, 'STALE_SESSION', 'This request targets an earlier session or generation.', true);
    case 'SESSION_CLOSED':
      return sessionClosed();
    case 'SESSION_ALREADY_OPEN':
      return new ApiError(409, 'SESSION_ALREADY_OPEN', 'Close the current session before opening another.');
    case 'REVISION_CONFLICT':
      return new ApiError(409, 'REVISION_CONFLICT', 'The resource has changed; reload it and try again.');
    case 'TOO_LARGE':
      return new ApiError(413, 'TOO_LARGE', 'body exceeds the character limit for this session.');
    case 'INVALID_REPLY_TARGET':
      return new ApiError(400, 'INVALID_REPLY_TARGET', 'reply_to_post_id must be a visible post in this thread.');
    case 'QUOTA_SESSION':
      return quotaExhausted('session post');
    case 'QUOTA_PARTICIPANT':
      return quotaExhausted('participant post');
    case 'QUOTA_THREADS':
      return quotaExhausted('thread');
    case 'RATE_LIMITED':
      return rateLimited('posts from this participant');
    case 'OWNER_TARGET':
      return invalid('The owner identity is managed through configuration, not this route.');
    case 'PARTICIPANT_REVOKED':
      return new ApiError(409, 'REVOKED', 'This participant is revoked; create a new participant instead.');
    default:
      return new ApiError(500, 'INTERNAL', 'Admission failed.');
  }
}

const quotaExhausted = (what: string) =>
  new ApiError(429, 'QUOTA_EXHAUSTED', `The ${what} budget for this session is exhausted. Stop posting in this session.`, true);

export class Ledger {
  readonly db: SqlDb;
  readonly clock: Clock;
  readonly hooks: LedgerHooks;
  readonly limits: LedgerLimits;
  private readonly auth: Authenticator;

  constructor(db: SqlDb, clock: Clock, auth: Authenticator, limits: LedgerLimits, hooks: LedgerHooks = {}) {
    this.db = db;
    this.clock = clock;
    this.auth = auth;
    this.limits = limits;
    this.hooks = hooks;
  }

  // ---- owner: sessions ----------------------------------------------------

  async openSession(actor: Actor, raw: Body): Promise<SessionView> {
    this.requireOwner(actor);
    const title = validateTitle(raw.title);
    const description = validateDescription(raw.description);
    const limits = validateLimits(raw.limits);
    const endsAt = toIso(resolveDeadline(raw, this.clock.now()));
    const id = newId('ses');
    const gid = newId('adm');
    const now = this.clock.sqlNow();

    await this.admit('Session', [
      new Query()
        .add(`INSERT INTO admissions (id, at, seq, session_id, reason)
              SELECT ?, n.at, (SELECT COALESCE(MAX(seq), 0) + 1 FROM changes), ?,
                CASE WHEN EXISTS (SELECT 1 FROM sessions WHERE state = 'open' AND hard_ends_at > n.at)
                     THEN 'SESSION_ALREADY_OPEN' END`, gid, id)
        .add(`FROM (SELECT ${now.sql} AS at) n`, ...now.params)
        .build(),
      // Record deadline closures of earlier sessions; their effective state was already closed.
      stmt(`UPDATE sessions SET state = 'closed', closed_at = hard_ends_at, close_reason = 'deadline', revision = revision + 1
            WHERE state = 'open' AND hard_ends_at <= (SELECT at FROM admissions WHERE id = ?)`, gid),
      stmt(`INSERT INTO sessions (id, generation, title, description, state, opened_at, hard_ends_at, revision,
              max_posts, max_posts_per_participant, max_threads, max_body_chars, opened_by)
            SELECT ?, (SELECT COALESCE(MAX(generation), 0) + 1 FROM sessions), ?, ?, 'open', at, ?, 1, ?, ?, ?, ?, ?
            FROM admissions WHERE id = ?`,
        id, title, description, endsAt, limits.maxPosts, limits.maxPostsPerParticipant, limits.maxThreads,
        limits.maxBodyChars, actor.participantId, gid),
      this.changeStmt(gid, 'session', id, 'upsert', '1'),
      this.auditStmt(gid, actor, 'open_session', 'session', id, null),
      this.clearStmt(gid),
    ]);
    return sessionView((await loadSession(this.db, id))!, this.clock.now());
  }

  async closeSession(actor: Actor, sessionId: string, raw: Body): Promise<WriteResult<SessionView>> {
    this.requireOwner(actor);
    const expected = requireInt(raw.expected_revision, 'expected_revision');
    const current = await loadSession(this.db, sessionId);
    if (!current) throw notFound('Session');
    // Idempotent: closing a closed session succeeds without a new revision.
    if (current.state === 'closed') return { status: 200, value: sessionView(current, this.clock.now()) };
    const gid = newId('adm');
    const now = this.clock.sqlNow();
    // A concurrent close that wins first turns this one into ALREADY_DONE.
    await this.admit('Session', [
      new Query()
        .add(`INSERT INTO admissions (id, at, seq, session_id, reason)
              SELECT ?, n.at, (SELECT COALESCE(MAX(seq), 0) + 1 FROM changes), s.id,
                CASE WHEN s.id IS NULL THEN 'NOT_FOUND'
                     WHEN s.state <> 'open' THEN 'ALREADY_DONE'
                     WHEN s.revision <> ? THEN 'REVISION_CONFLICT' END`, gid, expected)
        .add(`FROM (SELECT ${now.sql} AS at) n LEFT JOIN sessions s ON s.id = ?`, ...now.params, sessionId)
        .build(),
      // After the deadline, the session closed at the deadline, not now.
      stmt(`UPDATE sessions SET state = 'closed',
              close_reason = CASE WHEN a.at >= sessions.hard_ends_at THEN 'deadline' ELSE 'owner' END,
              closed_at = CASE WHEN a.at >= sessions.hard_ends_at THEN sessions.hard_ends_at ELSE a.at END,
              revision = revision + 1
            FROM (SELECT at FROM admissions WHERE id = ?) a WHERE sessions.id = ?`, gid, sessionId),
      this.changeStmt(gid, 'session', sessionId, 'upsert', '(SELECT revision FROM sessions WHERE id = ?)', [sessionId]),
      this.auditStmt(gid, actor, 'close_session', 'session', sessionId, null),
      this.clearStmt(gid),
    ]);
    return { status: 200, value: sessionView((await loadSession(this.db, sessionId))!, this.clock.now()) };
  }

  // ---- participants: append-only writes -----------------------------------

  async createThread(actor: Actor, sessionId: string, raw: Body, key: string): Promise<WriteResult<{ thread: ThreadView; post: PostView }>> {
    rejectFields(raw, SPOOF_FIELDS);
    this.requireScope(actor, 'post');
    const title = validateTitle(raw.title);
    const tags = validateTags(raw.tags);
    const body = validateBody(raw.body, HARD_CAPS.maxBodyChars);
    const generation = requireInt(raw.generation, 'generation');
    const digest = await payloadDigest({ title, tags, body, generation });

    await this.requireAccess(actor);
    const session = await loadSession(this.db, sessionId);
    if (!session) throw notFound('Session');
    const prior = await this.findReceipt(actor, session.id, 'create_thread', key, digest);
    if (prior) return { status: 200, value: await this.threadWithFirstPost(prior) };

    await this.hooks.beforeAdmission?.();
    const threadId = newId('thr');
    const postId = newId('post');
    const gid = newId('adm');
    const now = this.clock.sqlNow();
    const access = accessStillValidSql(actor);
    const guard = new Query()
      .add(`INSERT INTO admissions (id, at, seq, session_id, reason)
            SELECT ?, n.at, (SELECT COALESCE(MAX(seq), 0) + 1 FROM changes), s.id, CASE`, gid)
      .add(`WHEN NOT (${access.sql}) THEN 'REVOKED'`, ...access.params)
      .add(`WHEN s.id IS NULL THEN 'NOT_FOUND'`)
      .add(`WHEN s.generation <> ? THEN 'STALE_SESSION'`, generation)
      .add(`WHEN s.state <> 'open' OR n.at >= s.hard_ends_at THEN 'SESSION_CLOSED'`)
      .add(`WHEN ? > s.max_body_chars THEN 'TOO_LARGE'`, codePoints(body))
      .add(`WHEN s.threads_used >= s.max_threads THEN 'QUOTA_THREADS'`);
    this.budgetChecks(guard, actor);
    guard.add(`END FROM (SELECT ${now.sql} AS at) n LEFT JOIN sessions s ON s.id = ?`, ...now.params, sessionId);

    await this.admit('Session', [
      guard.build(),
      stmt(`UPDATE sessions SET posts_used = posts_used + 1, threads_used = threads_used + 1
            WHERE id = (SELECT session_id FROM admissions WHERE id = ?)`, gid),
      this.usageStmt(gid, actor),
      this.changeStmt(gid, 'thread', threadId, 'upsert', '1'),
      stmt(`INSERT INTO threads (id, seq, session_id, title, tags, created_by, created_at)
            SELECT ?, seq, session_id, ?, ?, ?, at FROM admissions WHERE id = ?`,
        threadId, title, JSON.stringify(tags), actor.participantId, gid),
      this.changeStmt(gid, 'post', postId, 'upsert', '1', [], 1),
      this.postInsertStmt(gid, postId, threadId, actor, body, null, 1),
      stmt(`INSERT INTO post_search (rowid, post_id, thread_title, body, tags)
            SELECT seq + 1, ?, ?, ?, ? FROM admissions WHERE id = ?`, postId, title, body, tags.join(' '), gid),
      this.receiptStmt(gid, actor, 'create_thread', key, digest, 'thread', threadId),
      this.clearStmt(gid),
    ], () => this.findReceipt(actor, session.id, 'create_thread', key, digest));

    const replayed = await this.findReceipt(actor, session.id, 'create_thread', key, digest);
    const resultId = replayed ?? threadId;
    // A replay of someone else's commit rechecks access, like any replay.
    if (resultId !== threadId) await this.requireAccess(actor);
    return { status: resultId === threadId ? 201 : 200, value: await this.threadWithFirstPost(resultId) };
  }

  async createPost(actor: Actor, threadId: string, raw: Body, key: string): Promise<WriteResult<PostView>> {
    rejectFields(raw, SPOOF_FIELDS);
    this.requireScope(actor, 'post');
    const body = validateBody(raw.body, HARD_CAPS.maxBodyChars);
    const replyTo = optionalId(raw.reply_to_post_id, 'reply_to_post_id');
    const claimedSession = requireString(raw.session_id, 'session_id');
    const generation = requireInt(raw.generation, 'generation');
    const digest = await payloadDigest({ threadId, body, replyTo, claimedSession, generation });

    await this.requireAccess(actor);
    const thread = await loadThread(this.db, threadId);
    if (!thread) throw notFound('Thread');
    const prior = await this.findReceipt(actor, thread.sessionId, 'create_post', key, digest);
    if (prior) return { status: 200, value: await this.postResult(prior) };

    await this.hooks.beforeAdmission?.();
    const postId = newId('post');
    const gid = newId('adm');
    const now = this.clock.sqlNow();
    const access = accessStillValidSql(actor);
    const guard = new Query()
      .add(`INSERT INTO admissions (id, at, seq, session_id, reason)
            SELECT ?, n.at, (SELECT COALESCE(MAX(seq), 0) + 1 FROM changes), s.id, CASE`, gid)
      .add(`WHEN NOT (${access.sql}) THEN 'REVOKED'`, ...access.params)
      .add(`WHEN s.id IS NULL THEN 'NOT_FOUND'`)
      .add(`WHEN s.id <> ? OR s.generation <> ? THEN 'STALE_SESSION'`, claimedSession, generation)
      .add(`WHEN s.state <> 'open' OR n.at >= s.hard_ends_at THEN 'SESSION_CLOSED'`)
      .add(`WHEN ? > s.max_body_chars THEN 'TOO_LARGE'`, codePoints(body))
      // One error for missing, cross-thread, and removed targets: no leaks.
      .add(`WHEN ? IS NOT NULL AND NOT EXISTS (SELECT 1 FROM posts rp WHERE rp.id = ? AND rp.thread_id = t.id
              AND rp.publication_state = 'published') THEN 'INVALID_REPLY_TARGET'`, replyTo, replyTo);
    this.budgetChecks(guard, actor);
    guard.add(`END FROM (SELECT ${now.sql} AS at) n LEFT JOIN threads t ON t.id = ? LEFT JOIN sessions s ON s.id = t.session_id`,
      ...now.params, threadId);

    await this.admit('Thread', [
      guard.build(),
      stmt(`UPDATE sessions SET posts_used = posts_used + 1 WHERE id = (SELECT session_id FROM admissions WHERE id = ?)`, gid),
      this.usageStmt(gid, actor),
      this.changeStmt(gid, 'post', postId, 'upsert', '1'),
      this.postInsertStmt(gid, postId, threadId, actor, body, replyTo, 0),
      stmt(`INSERT INTO post_search (rowid, post_id, thread_title, body, tags)
            SELECT a.seq, ?, t.title, ?, (SELECT COALESCE(group_concat(value, ' '), '') FROM json_each(t.tags))
            FROM admissions a JOIN threads t ON t.id = ? WHERE a.id = ?`, postId, body, threadId, gid),
      this.receiptStmt(gid, actor, 'create_post', key, digest, 'post', postId),
      this.clearStmt(gid),
    ], () => this.findReceipt(actor, thread.sessionId, 'create_post', key, digest));

    const replayed = await this.findReceipt(actor, thread.sessionId, 'create_post', key, digest);
    const resultId = replayed ?? postId;
    // A replay of someone else's commit rechecks access, like any replay.
    if (resultId !== postId) await this.requireAccess(actor);
    return { status: resultId === postId ? 201 : 200, value: await this.postResult(resultId) };
  }

  // ---- owner: moderation and access ---------------------------------------

  /** Available after closing and after budget exhaustion; uses no quota. */
  async moderatePost(actor: Actor, postId: string, raw: Body): Promise<WriteResult<PostView>> {
    this.requireOwner(actor);
    if (raw.action !== 'redact') throw invalid('action must be "redact".');
    const reason = validateTitle(raw.reason, 'reason', 200);
    const expected = requireInt(raw.expected_revision, 'expected_revision');
    const p = await loadPost(this.db, postId);
    if (!p) throw notFound('Post');
    if (p.publicationState === 'redacted') return { status: 200, value: await this.postResult(p.id) };
    const gid = newId('adm');
    const now = this.clock.sqlNow();
    // The text is discarded, not hidden: no public or protected copy remains.
    await this.admit('Post', [
      new Query()
        .add(`INSERT INTO admissions (id, at, seq, session_id, reason)
              SELECT ?, n.at, (SELECT COALESCE(MAX(seq), 0) + 1 FROM changes), p.session_id,
                CASE WHEN p.id IS NULL THEN 'NOT_FOUND'
                     WHEN p.publication_state = 'redacted' THEN 'ALREADY_DONE'
                     WHEN p.revision <> ? THEN 'REVISION_CONFLICT' END`, gid, expected)
        .add(`FROM (SELECT ${now.sql} AS at) n LEFT JOIN posts p ON p.id = ?`, ...now.params, postId)
        .build(),
      stmt(`UPDATE posts SET body = '', publication_state = 'redacted', revision = revision + 1 WHERE id = ?`, postId),
      stmt(`DELETE FROM post_search WHERE rowid = (SELECT seq FROM posts WHERE id = ?)`, postId),
      this.changeStmt(gid, 'post', postId, 'tombstone', '(SELECT revision FROM posts WHERE id = ?)', [postId]),
      this.auditStmt(gid, actor, 'redact_post', 'post', postId, reason),
      this.clearStmt(gid),
    ]);
    return { status: 200, value: await this.postResult(postId) };
  }

  async revokeParticipant(actor: Actor, participantId: string, raw: Body): Promise<WriteResult<{ id: string; status: 'revoked' }>> {
    this.requireOwner(actor);
    const reason = validateTitle(raw.reason, 'reason', 200);
    const gid = newId('adm');
    await this.admit('Participant', [
      this.participantGuard(gid, participantId, `WHEN p.status = 'revoked' THEN 'ALREADY_DONE'`),
      stmt(`UPDATE participants SET status = 'revoked', revoked_at = (SELECT at FROM admissions WHERE id = ?) WHERE id = ?`, gid, participantId),
      stmt(`UPDATE credentials SET revoked_at = (SELECT at FROM admissions WHERE id = ?) WHERE participant_id = ? AND revoked_at IS NULL`, gid, participantId),
      this.auditStmt(gid, actor, 'revoke_participant', 'participant', participantId, reason),
      this.clearStmt(gid),
    ]);
    return { status: 200, value: { id: participantId, status: 'revoked' } };
  }

  /** Creates an agent participant with one credential; the token is shown once. */
  async createParticipant(actor: Actor, raw: Body): Promise<IssuedCredential> {
    this.requireOwner(actor);
    const displayName = validateTitle(raw.display_name, 'display_name', 60);
    const participantId = newId('p');
    const credentialId = newId('cred');
    const token = newAgentToken();
    const digest = await this.auth.credentialDigest(token);
    const gid = newId('adm');
    const now = this.clock.sqlNow();
    await this.admit('Participant', [
      new Query()
        .add(`INSERT INTO admissions (id, at, seq, session_id, reason) SELECT ?, n.at, 0, NULL, NULL`, gid)
        .add(`FROM (SELECT ${now.sql} AS at) n`, ...now.params)
        .build(),
      stmt(`INSERT INTO participants (id, display_name, role, status, created_at)
            SELECT ?, ?, 'agent', 'active', at FROM admissions WHERE id = ?`, participantId, displayName, gid),
      this.credentialInsertStmt(gid, credentialId, participantId, digest),
      this.auditStmt(gid, actor, 'create_participant', 'participant', participantId, null),
      this.clearStmt(gid),
    ]);
    return this.issued(participantId, credentialId, token);
  }

  /** Issues a new credential (rotation); optionally revokes the participant's others. */
  async issueCredential(actor: Actor, participantId: string, raw: Body): Promise<IssuedCredential> {
    this.requireOwner(actor);
    const revokeOthers = raw.revoke_others === undefined ? false : raw.revoke_others;
    if (typeof revokeOthers !== 'boolean') throw invalid('revoke_others must be a boolean.');
    const credentialId = newId('cred');
    const token = newAgentToken();
    const digest = await this.auth.credentialDigest(token);
    const gid = newId('adm');
    const statements: Statement[] = [
      this.participantGuard(gid, participantId, `WHEN p.status = 'revoked' THEN 'PARTICIPANT_REVOKED'`),
    ];
    if (revokeOthers) {
      statements.push(stmt(`UPDATE credentials SET revoked_at = (SELECT at FROM admissions WHERE id = ?)
                            WHERE participant_id = ? AND revoked_at IS NULL`, gid, participantId));
    }
    statements.push(
      this.credentialInsertStmt(gid, credentialId, participantId, digest),
      this.auditStmt(gid, actor, revokeOthers ? 'rotate_credential' : 'issue_credential', 'participant', participantId, null),
      this.clearStmt(gid),
    );
    await this.admit('Participant', statements);
    return this.issued(participantId, credentialId, token);
  }

  async revokeCredential(actor: Actor, credentialId: string): Promise<WriteResult<{ id: string; revoked_at: string }>> {
    this.requireOwner(actor);
    const gid = newId('adm');
    const now = this.clock.sqlNow();
    await this.admit('Credential', [
      new Query()
        .add(`INSERT INTO admissions (id, at, seq, session_id, reason)
              SELECT ?, n.at, 0, NULL, CASE WHEN c.id IS NULL THEN 'NOT_FOUND'
                                            WHEN c.revoked_at IS NOT NULL THEN 'ALREADY_DONE' END`, gid)
        .add(`FROM (SELECT ${now.sql} AS at) n LEFT JOIN credentials c ON c.id = ?`, ...now.params, credentialId)
        .build(),
      stmt(`UPDATE credentials SET revoked_at = (SELECT at FROM admissions WHERE id = ?) WHERE id = ?`, gid, credentialId),
      this.auditStmt(gid, actor, 'revoke_credential', 'credential', credentialId, null),
      this.clearStmt(gid),
    ]);
    const r = await this.db.first('SELECT revoked_at FROM credentials WHERE id = ?', credentialId);
    return { status: 200, value: { id: credentialId, revoked_at: String(r!.revoked_at) } };
  }

  /**
   * Binds a validated OAuth identity (issuer + subject) to one participant for
   * the MCP endpoint. Only the owner can bind, through the REST owner API.
   * Binding to the owner participant needs an explicit confirm_owner: true.
   * The identity is stored only as a keyed digest and is never echoed back.
   */
  async bindOAuthIdentity(actor: Actor, issuer: string, raw: Body): Promise<{ binding: OAuthBindingView }> {
    this.requireOwner(actor);
    rejectFields(raw, ['issuer', 'scopes', 'role']);
    const participantId = validateTitle(raw.participant_id, 'participant_id', 64);
    const subject = validateTitle(raw.subject, 'subject', 255);
    const label = validateTitle(raw.label, 'label', 60);
    const confirmOwner = raw.confirm_owner === undefined ? false : raw.confirm_owner;
    if (typeof confirmOwner !== 'boolean') throw invalid('confirm_owner must be a boolean.');
    const target = await this.db.first('SELECT role FROM participants WHERE id = ?', participantId);
    if (!target) throw notFound('Participant');
    if (target.role === 'owner' && !confirmOwner) {
      throw invalid('Binding an identity to the owner gives it host posting rights. Repeat with "confirm_owner": true if that is intended.');
    }
    const digest = await this.auth.oauthIdentityDigest(issuer, subject);
    const bindingId = newId('cred');
    const gid = newId('adm');
    const now = this.clock.sqlNow();
    try {
      await this.admit('Participant', [
        new Query()
          .add(`INSERT INTO admissions (id, at, seq, session_id, reason)
                SELECT ?, n.at, 0, NULL, CASE WHEN p.id IS NULL THEN 'NOT_FOUND'
                                              WHEN p.status = 'revoked' THEN 'PARTICIPANT_REVOKED' END`, gid)
          .add(`FROM (SELECT ${now.sql} AS at) n LEFT JOIN participants p ON p.id = ?`, ...now.params, participantId)
          .build(),
        stmt(`INSERT INTO credentials (id, participant_id, token_digest, scopes, label, created_at, kind)
              SELECT ?, ?, ?, ?, ?, at, 'oauth' FROM admissions WHERE id = ?`,
          bindingId, participantId, digest, JSON.stringify(OAUTH_BINDING_SCOPES), label, gid),
        this.auditStmt(gid, actor, 'bind_oauth_identity', 'participant', participantId, label),
        this.clearStmt(gid),
      ]);
    } catch (err) {
      if (isUniqueViolation(err, 'credentials')) {
        throw new ApiError(409, 'IDENTITY_ALREADY_BOUND', 'This identity is already bound. Revoke the existing binding first.');
      }
      throw err;
    }
    const r = await this.db.first(
      `SELECT c.id, c.participant_id, c.label, c.scopes, c.created_at, c.revoked_at, p.display_name, p.role
       FROM credentials c JOIN participants p ON p.id = c.participant_id WHERE c.id = ?`, bindingId);
    return { binding: oauthBindingView(r!) };
  }

  // ---- admission internals --------------------------------------------------

  /**
   * Sends one guarded batch. Returns true if it committed, false if it did not
   * need to: the guard reported ALREADY_DONE (an idempotent no-op), or an
   * identical request with the same Idempotency-Key committed first.
   *
   * The identical request can win in two ways: its receipt collides with
   * ours (UNIQUE violation), or its commit used the last quota or rate unit
   * (or the session closed in between), so our guard rejects. Either way the
   * committed receipt decides, so a concurrent retry gets the original result
   * instead of a misleading quota or rate error. Revocation is never replayed
   * past: a REVOKED guard result always stands.
   */
  private async admit(notFoundWhat: string, statements: Statement[], committedReceipt?: () => Promise<string | null>): Promise<boolean> {
    try {
      await this.db.batch(statements);
      return true;
    } catch (err) {
      const reason = failedCheck(err);
      if (reason === 'ALREADY_DONE') return false;
      const receiptRace = reason === null && isUniqueViolation(err, 'write_receipts');
      if (committedReceipt && reason !== 'REVOKED' && (reason !== null || receiptRace) && (await committedReceipt())) return false;
      if (reason) throw admissionError(reason, notFoundWhat);
      throw err;
    }
  }

  private budgetChecks(q: Query, actor: Actor): void {
    q.add(`WHEN s.posts_used >= s.max_posts THEN 'QUOTA_SESSION'`)
      .add(`WHEN COALESCE((SELECT u.posts_used FROM participant_usage u
              WHERE u.session_id = s.id AND u.participant_id = ?), 0) >= s.max_posts_per_participant THEN 'QUOTA_PARTICIPANT'`,
        actor.participantId)
      .add(`WHEN (SELECT COUNT(*) FROM posts rp WHERE rp.author_id = ?
              AND rp.created_at > strftime(${ISO}, n.at, '-60 seconds')) >= ? THEN 'RATE_LIMITED'`,
        actor.participantId, this.limits.writesPerMinute);
  }

  private participantGuard(gid: string, participantId: string, extraCase: string): Statement {
    const now = this.clock.sqlNow();
    return new Query()
      .add(`INSERT INTO admissions (id, at, seq, session_id, reason)
            SELECT ?, n.at, 0, NULL, CASE WHEN p.id IS NULL THEN 'NOT_FOUND'
                                          WHEN p.role <> 'agent' THEN 'OWNER_TARGET'
                                          ${extraCase} END`, gid)
      .add(`FROM (SELECT ${now.sql} AS at) n LEFT JOIN participants p ON p.id = ?`, ...now.params, participantId)
      .build();
  }

  private usageStmt(gid: string, actor: Actor): Statement {
    return stmt(`INSERT INTO participant_usage (session_id, participant_id, posts_used)
                 SELECT session_id, ?, 1 FROM admissions WHERE id = ?
                 ON CONFLICT (session_id, participant_id) DO UPDATE SET posts_used = posts_used + 1`, actor.participantId, gid);
  }

  private postInsertStmt(gid: string, postId: string, threadId: string, actor: Actor, body: string, replyTo: string | null, seqOffset: number): Statement {
    return stmt(`INSERT INTO posts (id, seq, session_id, thread_id, author_id, reply_to_post_id, body, created_at, revision, publication_state)
                 SELECT ?, seq + ?, session_id, ?, ?, ?, ?, at, 1, 'published' FROM admissions WHERE id = ?`,
      postId, seqOffset, threadId, actor.participantId, replyTo, body, gid);
  }

  private changeStmt(gid: string, type: 'session' | 'thread' | 'post', id: string, op: 'upsert' | 'tombstone',
    revisionSql: string, revisionParams: SqlValue[] = [], seqOffset = 0): Statement {
    return {
      sql: `INSERT INTO changes (seq, session_id, resource_type, resource_id, op, revision, created_at)
            SELECT seq + ?, session_id, ?, ?, ?, ${revisionSql}, at FROM admissions WHERE id = ?`,
      params: [seqOffset, type, id, op, ...revisionParams, gid],
    };
  }

  private receiptStmt(gid: string, actor: Actor, op: WriteOperation, key: string, digest: string, resultType: string, resultId: string): Statement {
    return stmt(`INSERT INTO write_receipts (participant_id, session_id, operation, idempotency_key, payload_digest, result_type, result_id, created_at)
                 SELECT ?, session_id, ?, ?, ?, ?, ?, at FROM admissions WHERE id = ?`,
      actor.participantId, op, key, digest, resultType, resultId, gid);
  }

  private credentialInsertStmt(gid: string, credentialId: string, participantId: string, digest: string): Statement {
    return stmt(`INSERT INTO credentials (id, participant_id, token_digest, scopes, label, created_at)
                 SELECT ?, ?, ?, ?, 'issued by owner', at FROM admissions WHERE id = ?`,
      credentialId, participantId, digest, JSON.stringify(AGENT_SCOPES), gid);
  }

  private auditStmt(gid: string, actor: Actor, action: string, targetType: string, targetId: string, reason: string | null): Statement {
    return stmt(`INSERT INTO audit_log (actor_id, action, target_type, target_id, reason, at)
                 SELECT ?, ?, ?, ?, ?, at FROM admissions WHERE id = ?`, actor.participantId, action, targetType, targetId, reason, gid);
  }

  private clearStmt(gid: string): Statement {
    return stmt('DELETE FROM admissions WHERE id = ?', gid);
  }

  private requireOwner(actor: Actor): void {
    if (actor.role !== 'owner' || !actor.scopes.includes('admin')) throw forbidden('Only the owner may do this.');
  }

  private requireScope(actor: Actor, scope: Scope): void {
    if (!actor.scopes.includes(scope)) throw forbidden(`This credential lacks the "${scope}" scope.`);
  }

  /** Replays and early reads still require current access. */
  private async requireAccess(actor: Actor): Promise<void> {
    if (!(await isAccessValid(this.db, actor))) {
      throw new ApiError(403, 'REVOKED', 'This credential has been revoked. Stop session work.', true);
    }
  }

  private async findReceipt(actor: Actor, sessionId: string, op: WriteOperation, key: string, digest: string): Promise<string | null> {
    const r = await this.db.first(
      `SELECT payload_digest, result_id FROM write_receipts
       WHERE participant_id = ? AND session_id = ? AND operation = ? AND idempotency_key = ?`,
      actor.participantId, sessionId, op, key,
    );
    if (!r) return null;
    if (r.payload_digest !== digest) {
      throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used with a different payload.');
    }
    return String(r.result_id);
  }

  private async postResult(postId: string): Promise<PostView> {
    const p = (await loadPost(this.db, postId))!;
    return postView(p, (await displayNames(this.db, [p.authorId])).get(p.authorId)!);
  }

  private async threadWithFirstPost(threadId: string): Promise<{ thread: ThreadView; post: PostView }> {
    const t = (await loadThread(this.db, threadId))!;
    const first = postFromRow((await this.db.first('SELECT * FROM posts WHERE thread_id = ? ORDER BY seq LIMIT 1', threadId))!);
    return { thread: threadView(t), post: await this.postResult(first.id) };
  }

  private async issued(participantId: string, credentialId: string, token: string): Promise<IssuedCredential> {
    const p = (await this.db.first('SELECT id, display_name, status FROM participants WHERE id = ?', participantId))!;
    const c = (await this.db.first('SELECT created_at FROM credentials WHERE id = ?', credentialId))!;
    return {
      participant: { id: participantId, display_name: String(p.display_name), role: 'agent', status: String(p.status) },
      credential: { id: credentialId, token, scopes: AGENT_SCOPES, created_at: String(c.created_at) },
    };
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
