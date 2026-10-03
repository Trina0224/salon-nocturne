// Owner-approved administration relay.
//
//   relay (Rei's relay binding)        owner (owner secret, REST only)
//   ───────────────────────────        ───────────────────────────────
//   propose(op, target, params) ──▶ proposed
//                                       approve(id, digest, ttl) ──▶ approved
//   execute(id, same request, key) ──▶ executed (approval consumed)
//                                       reject / revoke ──▶ rejected / revoked
//
// The approval is a server-side record, not a bearer artifact. It binds the
// digest of the canonical request (operation, target, parameters, service
// context), the executing relay binding, and an expiry. Execution is one
// guarded batch: the guard rechecks the relay binding, the approval state,
// the expiry, the digest, and the target, then the operation's writes and
// the approval's consumption commit together or not at all. A retry with the
// same idempotency key returns the stored result without re-executing.

import { ApiError, invalid, notFound } from '../domain/errors.ts';
import type { Actor } from '../domain/model.ts';
import { validateIdempotencyKey, validateTitle } from '../domain/content.ts';
import { canonicalString, parseAdminRequest, storedParams, type AdminRequest } from '../domain/admin-ops.ts';
import { sha256Hex } from '../infra/crypto.ts';
import { newId } from '../infra/ids.ts';
import { stmt, type Row, type SqlDb, type Statement } from '../infra/sql.ts';
import type { Clock } from '../infra/clock.ts';
import { OAUTH_BINDING_SCOPES, accessStillValidSql, type Authenticator } from './auth.ts';
import type { Ledger } from './ledger.ts';

const MAX_PENDING_PER_RELAY = 20;
const DEFAULT_TTL_MINUTES = 15;
const MAX_TTL_MINUTES = 60;

type Body = Record<string, unknown>;

export interface AdminOperationView {
  id: string;
  operation: string;
  target: string;
  /** Canonical parameters; an OAuth subject appears only as a fingerprint. */
  params: Record<string, string>;
  subject_fingerprint: string | null;
  summary: string;
  digest: string;
  state: 'proposed' | 'approved' | 'expired' | 'executed' | 'rejected' | 'revoked';
  proposed_by: { binding_id: string; participant: string };
  proposed_at: string;
  decided_at: string | null;
  approval_expires_at: string | null;
  executed_at: string | null;
  result: unknown;
}

export class AdminRelay {
  private readonly db: SqlDb;
  private readonly clock: Clock;
  private readonly auth: Authenticator;
  private readonly ledger: Ledger;
  /** The OAuth issuer whose subjects bindings use. */
  private readonly issuer: string;
  /** Service context bound into every digest (the MCP resource URL). */
  readonly context: string;

  constructor(opts: { db: SqlDb; clock: Clock; auth: Authenticator; ledger: Ledger; issuer: string; context: string }) {
    this.db = opts.db;
    this.clock = opts.clock;
    this.auth = opts.auth;
    this.ledger = opts.ledger;
    this.issuer = opts.issuer;
    this.context = opts.context;
  }

  // ---- relay ----------------------------------------------------------------

  /** A relay proposes one operation. It has no effect until the owner approves it. */
  async propose(actor: Actor, raw: Body): Promise<AdminOperationView> {
    this.ledger.requireScope(actor, 'relay');
    const req = parseAdminRequest(raw);
    const summary = await this.describe(req);
    const canon = await this.canonical(req);
    const id = newId('aop');
    const gid = newId('adm');
    const now = this.clock.sqlNow();
    const access = accessStillValidSql(actor);
    await this.ledger.admit('Operation', [
      {
        sql: `INSERT INTO admissions (id, at, seq, session_id, reason)
              SELECT ?, n.at, 0, NULL, CASE
                WHEN NOT (${access.sql}) THEN 'REVOKED'
                WHEN (SELECT COUNT(*) FROM admin_operations WHERE proposed_by = ? AND state = 'proposed') >= ? THEN 'RATE_LIMITED'
              END FROM (SELECT ${now.sql} AS at) n`,
        params: [gid, ...access.params, actor.credentialId, MAX_PENDING_PER_RELAY, ...now.params],
      },
      stmt(`INSERT INTO admin_operations (id, operation, target, params, subject_fingerprint, context, digest, summary, proposed_by, proposed_at, state)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, at, 'proposed' FROM admissions WHERE id = ?`,
        id, req.operation, req.target, JSON.stringify(canon.params), canon.fingerprint, this.context, canon.digest, summary, actor.credentialId, gid),
      this.ledger.auditStmt(gid, actor, 'propose_admin_operation', 'admin_operation', id, req.operation),
      this.ledger.clearStmt(gid),
    ]);
    return this.view(id);
  }

  /** The proposing relay may read its own operations; nobody else's. */
  async getForRelay(actor: Actor, id: string): Promise<AdminOperationView> {
    this.ledger.requireScope(actor, 'relay');
    const row = await this.db.first('SELECT proposed_by FROM admin_operations WHERE id = ?', id);
    if (!row || row.proposed_by !== actor.credentialId) throw notFound('Operation');
    return this.view(id);
  }

  /**
   * Executes an approved operation. The request must be resubmitted and must
   * reduce to exactly the approved digest; a different operation, target,
   * or parameter is refused without consuming the approval.
   */
  async execute(actor: Actor, id: string, raw: Body, rawKey: string | undefined): Promise<{ status: 200 | 201; replayed: boolean; operation: AdminOperationView }> {
    this.ledger.requireScope(actor, 'relay');
    const key = validateIdempotencyKey(rawKey);
    const req = parseAdminRequest(raw);
    const canon = await this.canonical(req);
    const row = await this.db.first('SELECT * FROM admin_operations WHERE id = ?', id);
    if (!row || row.proposed_by !== actor.credentialId) throw notFound('Operation');
    if (row.digest !== canon.digest) {
      await this.auditDirect(actor, 'relay_request_mismatch', id, String(row.operation));
      throw new ApiError(409, 'APPROVAL_MISMATCH', 'This request differs from the approved operation (operation, target, or parameters). Nothing was executed.');
    }
    if (row.state === 'executed') return this.replay(actor, id, row, key);

    const gid = newId('adm');
    const now = this.clock.sqlNow();
    const access = accessStillValidSql(actor);
    const { writes, result } = this.operationWrites(gid, req, canon.subjectDigest);
    await this.ledger.hooks.beforeAdmission?.();
    try {
      await this.ledger.admit('Operation', [
        {
          sql: `INSERT INTO admissions (id, at, seq, session_id, reason)
                SELECT ?, n.at, 0, NULL, CASE
                  WHEN o.id IS NULL THEN 'NOT_FOUND'
                  WHEN NOT (${access.sql}) THEN 'REVOKED'
                  WHEN o.proposed_by <> ? THEN 'WRONG_EXECUTOR'
                  WHEN o.state = 'executed' THEN 'APPROVAL_USED'
                  WHEN o.state = 'revoked' THEN 'APPROVAL_REVOKED'
                  WHEN o.state <> 'approved' THEN 'NOT_APPROVED'
                  WHEN n.at >= o.approval_expires_at THEN 'APPROVAL_EXPIRED'
                  WHEN o.digest <> ? THEN 'NOT_APPROVED'
                  WHEN o.operation IN ('bind_identity', 'revoke_participant') AND tp.id IS NULL THEN 'NOT_FOUND'
                  WHEN o.operation IN ('bind_identity', 'revoke_participant') AND tp.role <> 'agent' THEN 'OWNER_TARGET'
                  WHEN o.operation = 'bind_identity' AND tp.status = 'revoked' THEN 'PARTICIPANT_REVOKED'
                  WHEN o.operation = 'revoke_binding' AND tc.id IS NULL THEN 'NOT_FOUND'
                  WHEN o.operation = 'revoke_binding' AND tcp.role <> 'agent' THEN 'OWNER_TARGET'
                END
                FROM (SELECT ${now.sql} AS at) n
                LEFT JOIN admin_operations o ON o.id = ?
                LEFT JOIN participants tp ON tp.id = o.target
                LEFT JOIN credentials tc ON tc.id = o.target AND tc.kind = 'oauth'
                LEFT JOIN participants tcp ON tcp.id = tc.participant_id`,
          params: [gid, ...access.params, actor.credentialId, canon.digest, ...now.params, id],
        },
        ...writes,
        stmt(`UPDATE admin_operations SET state = 'executed', executed_at = a.at, idempotency_key = ?, result = ?
              FROM (SELECT at FROM admissions WHERE id = ?) a WHERE admin_operations.id = ? AND admin_operations.state = 'approved'`,
          key, JSON.stringify(result), gid, id),
        this.ledger.auditStmt(gid, actor, 'relay_execute_admin_operation', 'admin_operation', id, req.operation),
        this.ledger.clearStmt(gid),
      ]);
    } catch (err) {
      // A concurrent identical retry may have consumed the approval first.
      if (err instanceof ApiError && err.code === 'APPROVAL_USED') {
        const fresh = await this.db.first('SELECT * FROM admin_operations WHERE id = ?', id);
        if (fresh) return this.replay(actor, id, fresh, key);
      }
      if (err instanceof ApiError) throw err;
      throw alreadyBound(err);
    }
    return { status: 201, replayed: false, operation: await this.view(id) };
  }

  // ---- owner ----------------------------------------------------------------

  /**
   * The owner approves exactly what she reviewed: she must send the digest
   * shown with the operation. The approval expires after ttl_minutes.
   */
  async approve(owner: Actor, id: string, raw: Body): Promise<AdminOperationView> {
    this.ledger.requireOwner(owner);
    const digest = raw.digest;
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw invalid('digest must be the 64-character digest shown with the operation.');
    const ttl = raw.ttl_minutes === undefined ? DEFAULT_TTL_MINUTES : raw.ttl_minutes;
    if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_MINUTES) {
      throw invalid(`ttl_minutes must be an integer from 1 to ${MAX_TTL_MINUTES}.`);
    }
    const row = await this.db.first('SELECT digest, state FROM admin_operations WHERE id = ?', id);
    if (!row) throw notFound('Operation');
    if (row.digest !== digest) throw new ApiError(409, 'APPROVAL_MISMATCH', 'The digest does not match this operation. Re-read it before approving.');
    await this.ownerTransition(owner, id, 'proposed', 'approved', 'approve_admin_operation', null, ttl);
    return this.view(id);
  }

  async reject(owner: Actor, id: string, raw: Body): Promise<AdminOperationView> {
    this.ledger.requireOwner(owner);
    const reason = raw.reason === undefined ? null : validateTitle(raw.reason, 'reason', 200);
    await this.ownerTransition(owner, id, 'proposed', 'rejected', 'reject_admin_operation', reason, null);
    return this.view(id);
  }

  /** Withdraws an approval that has not been used. It takes effect even for an execution already in flight. */
  async revoke(owner: Actor, id: string): Promise<AdminOperationView> {
    this.ledger.requireOwner(owner);
    await this.ownerTransition(owner, id, 'approved', 'revoked', 'revoke_admin_approval', null, null);
    return this.view(id);
  }

  async list(owner: Actor, state: string | undefined): Promise<AdminOperationView[]> {
    this.ledger.requireOwner(owner);
    const states = ['proposed', 'approved', 'executed', 'rejected', 'revoked'];
    if (state !== undefined && !states.includes(state)) throw invalid(`state must be one of: ${states.join(', ')}.`);
    const rows = await this.db.all(
      `SELECT id FROM admin_operations ${state ? 'WHERE state = ?' : ''} ORDER BY proposed_at DESC, id LIMIT 100`,
      ...(state ? [state] : []),
    );
    return Promise.all(rows.map((r) => this.view(String(r.id))));
  }

  async getForOwner(owner: Actor, id: string): Promise<AdminOperationView> {
    this.ledger.requireOwner(owner);
    return this.view(id);
  }

  // ---- internals ------------------------------------------------------------

  private async ownerTransition(owner: Actor, id: string, from: string, to: string, action: string, reason: string | null, ttl: number | null) {
    const gid = newId('adm');
    const now = this.clock.sqlNow();
    const committed = await this.ledger.admit('Operation', [
      {
        sql: `INSERT INTO admissions (id, at, seq, session_id, reason)
              SELECT ?, n.at, 0, NULL, CASE
                WHEN o.id IS NULL THEN 'NOT_FOUND'
                WHEN o.state = ? THEN 'ALREADY_DONE'
                WHEN o.state = 'executed' THEN 'APPROVAL_USED'
                WHEN o.state <> ? THEN 'REVISION_CONFLICT'
              END
              FROM (SELECT ${now.sql} AS at) n LEFT JOIN admin_operations o ON o.id = ?`,
        params: [gid, to, from, ...now.params, id],
      },
      ttl === null
        ? stmt(`UPDATE admin_operations SET state = ?, decided_at = a.at, decision_reason = COALESCE(?, decision_reason)
                FROM (SELECT at FROM admissions WHERE id = ?) a WHERE admin_operations.id = ? AND admin_operations.state = ?`,
            to, reason, gid, id, from)
        : stmt(`UPDATE admin_operations SET state = ?, decided_at = a.at,
                  approval_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', a.at, '+' || ? || ' minutes')
                FROM (SELECT at FROM admissions WHERE id = ?) a WHERE admin_operations.id = ? AND admin_operations.state = ?`,
            to, ttl, gid, id, from),
      this.ledger.auditStmt(gid, owner, action, 'admin_operation', id, reason),
      this.ledger.clearStmt(gid),
    ]);
    // ALREADY_DONE: the operation is already in the requested state (an idempotent repeat).
    void committed;
  }

  private async replay(actor: Actor, id: string, row: Row, key: string) {
    if (row.idempotency_key !== key) {
      throw new ApiError(409, 'APPROVAL_USED', 'This approval has already been used by a different request.');
    }
    // A replay still requires the relay binding to be valid now.
    await this.ledger.requireAccess(actor);
    return { status: 200 as const, replayed: true, operation: await this.view(id) };
  }

  /** Canonical parameters and digest for a request in this service context. */
  private async canonical(req: AdminRequest) {
    const subjectDigest = req.params.subject !== undefined ? await this.auth.oauthIdentityDigest(this.issuer, req.params.subject) : null;
    const params = storedParams(req, subjectDigest);
    const digest = await sha256Hex(canonicalString(this.context, req.operation, req.target, params));
    const fingerprint = req.params.subject !== undefined ? (await sha256Hex(req.params.subject)).slice(0, 16) : null;
    return { params, digest, fingerprint, subjectDigest };
  }

  /** Checks the target now (it is checked again at execution) and writes the owner-facing summary. */
  private async describe(req: AdminRequest): Promise<string> {
    const p = req.params;
    const agent = async (id: string) => {
      const r = await this.db.first('SELECT display_name, role, status FROM participants WHERE id = ?', id);
      if (!r) throw notFound('Participant');
      if (r.role !== 'agent') throw invalid('The relay cannot act on the owner. Use the owner API directly.');
      return r;
    };
    switch (req.operation) {
      case 'enroll_participant':
        return `Enroll a new agent participant "${p.participant_name}" with OAuth sign-in only (binding label "${p.label}"). No REST token is created.`;
      case 'bind_identity': {
        const r = await agent(req.target);
        if (r.status !== 'active') throw new ApiError(409, 'REVOKED', 'This participant is revoked.');
        return `Bind an OAuth identity (binding label "${p.label}") to agent "${r.display_name}" (${req.target}) with posting scopes only.`;
      }
      case 'revoke_binding': {
        const r = await this.db.first(
          `SELECT c.label, p.display_name, p.role FROM credentials c JOIN participants p ON p.id = c.participant_id
           WHERE c.id = ? AND c.kind = 'oauth'`, req.target);
        if (!r) throw notFound('Binding');
        if (r.role !== 'agent') throw invalid('The relay cannot act on the owner. Use the owner API directly.');
        return `Revoke OAuth binding ${req.target} ("${r.label}") of agent "${r.display_name}".`;
      }
      case 'revoke_participant': {
        const r = await agent(req.target);
        return `Revoke agent "${r.display_name}" (${req.target}) and all of its credentials and bindings. Reason: ${p.reason}`;
      }
    }
  }

  /** The operation's own writes, and the result to store (never a credential). */
  private operationWrites(gid: string, req: AdminRequest, subjectDigest: string | null): { writes: Statement[]; result: unknown } {
    const at = `(SELECT at FROM admissions WHERE id = ?)`;
    switch (req.operation) {
      case 'enroll_participant': {
        const participantId = newId('p');
        const bindingId = newId('cred');
        return {
          writes: [
            this.ledger.participantInsertStmt(gid, participantId, req.params.participant_name!),
            ...this.ledger.bindingStmts(gid, bindingId, participantId, subjectDigest!, OAUTH_BINDING_SCOPES, req.params.label!),
          ],
          result: { participant: { id: participantId, display_name: req.params.participant_name }, binding: { id: bindingId, label: req.params.label, scopes: OAUTH_BINDING_SCOPES } },
        };
      }
      case 'bind_identity': {
        const bindingId = newId('cred');
        return {
          writes: this.ledger.bindingStmts(gid, bindingId, req.target, subjectDigest!, OAUTH_BINDING_SCOPES, req.params.label!),
          result: { binding: { id: bindingId, participant_id: req.target, label: req.params.label, scopes: OAUTH_BINDING_SCOPES } },
        };
      }
      case 'revoke_binding':
        return {
          writes: [stmt(`UPDATE credentials SET revoked_at = ${at} WHERE id = ? AND revoked_at IS NULL`, gid, req.target)],
          result: { binding_id: req.target, revoked: true },
        };
      case 'revoke_participant':
        return {
          writes: [
            stmt(`UPDATE participants SET status = 'revoked', revoked_at = ${at} WHERE id = ? AND status = 'active'`, gid, req.target),
            stmt(`UPDATE credentials SET revoked_at = ${at} WHERE participant_id = ? AND revoked_at IS NULL`, gid, req.target),
          ],
          result: { participant_id: req.target, revoked: true },
        };
    }
  }

  private async auditDirect(actor: Actor, action: string, id: string, reason: string) {
    const now = this.clock.sqlNow();
    await this.db.run(
      `INSERT INTO audit_log (actor_id, action, target_type, target_id, reason, at) SELECT ?, ?, 'admin_operation', ?, ?, ${now.sql}`,
      actor.participantId, action, id, reason, ...now.params,
    );
  }

  private async view(id: string): Promise<AdminOperationView> {
    const r = await this.db.first(
      `SELECT o.*, p.display_name AS proposer FROM admin_operations o
       JOIN credentials c ON c.id = o.proposed_by JOIN participants p ON p.id = c.participant_id WHERE o.id = ?`, id);
    if (!r) throw notFound('Operation');
    const params = JSON.parse(String(r.params)) as Record<string, string>;
    delete params.subject_digest;
    let state = String(r.state) as AdminOperationView['state'];
    if (state === 'approved' && Date.parse(String(r.approval_expires_at)) <= this.clock.now()) state = 'expired';
    return {
      id: String(r.id),
      operation: String(r.operation),
      target: String(r.target),
      params,
      subject_fingerprint: r.subject_fingerprint === null ? null : String(r.subject_fingerprint),
      summary: String(r.summary),
      digest: String(r.digest),
      state,
      proposed_by: { binding_id: String(r.proposed_by), participant: String(r.proposer) },
      proposed_at: String(r.proposed_at),
      decided_at: r.decided_at === null ? null : String(r.decided_at),
      approval_expires_at: r.approval_expires_at === null ? null : String(r.approval_expires_at),
      executed_at: r.executed_at === null ? null : String(r.executed_at),
      result: r.result === null ? null : JSON.parse(String(r.result)),
    };
  }
}

function alreadyBound(err: unknown): unknown {
  if (String((err as Error)?.message ?? err).includes('UNIQUE constraint failed: credentials.')) {
    return new ApiError(409, 'IDENTITY_ALREADY_BOUND', 'This identity has an active binding. The owner must revoke it first.');
  }
  return err;
}
