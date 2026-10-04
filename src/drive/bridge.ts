// Google Drive message bridge: ordinary program code, no model in the loop.
//
//   outbox file ──changes.list──▶ drive_files (pending) ──ledger──▶ post
//   post ──changes feed──▶ drive_deliveries (per recipient) ──files.create──▶ inbox file
//
// Durability rules:
// - A page of changes is recorded as pending file jobs, and the account's
//   cursor advances, in one D1 batch. A crash before the batch re-reads the
//   page; after it, nothing is lost. Recording is idempotent per file ID.
// - A file job pins its parsed request before calling the ledger, and posts
//   with an idempotency key derived from the message ID. A crash after
//   posting replays the pinned request (never a reread, possibly edited,
//   source), so it returns the original receipt instead of posting twice.
// - Fan-out to recipients advances its own cursor in the same batch that
//   creates the delivery rows.
// - A delivery that may have been written (timeout, 5xx) is marked
//   'uncertain'; every retry first looks for the file carrying its delivery
//   ID before writing. That avoids most duplicates, but it is not
//   exactly-once: Drive offers no conditional create, search may lag, and a
//   create still in flight when its claim expires can land after another
//   worker's write. Every created file is logged, so such duplicates are
//   visible to the owner rather than silent.
//
// Webhooks only wake the bridge. Their content is never message data.

import { ApiError } from '../domain/errors.ts';
import { effectiveStatus, type Actor } from '../domain/model.ts';
import { hmacHex, sha256Hex, timingSafeEqual, base64url, randomBytes } from '../infra/crypto.ts';
import { stmt, type Row, type SqlDb, type Statement } from '../infra/sql.ts';
import type { Clock } from '../infra/clock.ts';
import { loadPost, loadSession, loadThread } from '../store/rows.ts';
import { DRIVE_CREDENTIAL_PREFIX } from '../store/auth.ts';
import type { Ledger } from '../store/ledger.ts';
import type { DriveBridgeConfig } from './config.ts';
import { DriveError, GOOGLE_DOC, PLAIN_TEXT, type DriveClient, type DriveFile } from './client.ts';
import { MAX_MESSAGE_BYTES, parseMessage, renderDelivery } from './message.ts';

export const LIMITS = {
  pagesPerRun: 5,
  changesPerPage: 100,
  filesPerRun: 25,
  postsPerFanOut: 50,
  deliveriesPerRun: 50,
  maxAttempts: 8,
  baseBackoffMs: 60_000,
  maxBackoffMs: 60 * 60_000,
  /** How long a worker may hold an account, file, or delivery before another may take over. */
  claimMs: 2 * 60_000,
  /** Requested channel lifetime and renewal margin. The Drive maximum is unverified here. */
  channelTtlMs: 6 * 24 * 60 * 60_000,
  renewBeforeMs: 24 * 60 * 60_000,
} as const;

/** Ledger errors that end a file's processing for good. Anything else is retried. */
const TERMINAL_CODES = new Set(['SESSION_CLOSED', 'STALE_SESSION', 'QUOTA_EXHAUSTED', 'REVOKED', 'INVALID_REPLY_TARGET',
  'TOO_LARGE', 'INVALID_INPUT', 'NOT_FOUND', 'IDEMPOTENCY_CONFLICT', 'FORBIDDEN']);

export type ClientFactory = (accountId: string) => DriveClient;

export interface BridgeHooks {
  /** Test hook: runs after a page is fetched and before it is checkpointed. */
  beforeCheckpoint?: (accountId: string) => void | Promise<void>;
  /** Test hook: runs after the ledger accepted a message and before the file job is marked done. */
  afterPost?: (fileId: string) => void | Promise<void>;
}

/** The exact ledger request a file job replays on every retry once pinned. */
type PinnedRequest =
  | { kind: 'thread'; messageId: string; sessionId: string; generation: number; title: string; tags: string[]; body: string }
  | { kind: 'post'; messageId: string; threadId: string; raw: Record<string, unknown> }
  /** Left by a redaction (src/drive/pins.ts): admitted, text discarded; complete from the receipt. */
  | { kind: 'admitted'; messageId: string };

const iso = (ms: number) => new Date(ms).toISOString();

export class DriveBridge {
  private readonly db: SqlDb;
  private readonly clock: Clock;
  private readonly ledger: Ledger;
  private readonly config: DriveBridgeConfig;
  private readonly client: ClientFactory;
  private readonly secret: string;
  readonly hooks: BridgeHooks;

  constructor(opts: { db: SqlDb; clock: Clock; ledger: Ledger; config: DriveBridgeConfig; client: ClientFactory; secret: string; hooks?: BridgeHooks }) {
    this.db = opts.db;
    this.clock = opts.clock;
    this.ledger = opts.ledger;
    this.config = opts.config;
    this.client = opts.client;
    this.secret = opts.secret;
    this.hooks = opts.hooks ?? {};
  }

  private now(): string {
    return iso(this.clock.now());
  }

  // ---- configuration ----------------------------------------------------------

  /**
   * Makes the database match the configuration: account rows, one agent
   * participant per configured outbox (created on first sight), inbox
   * updates, and disabling mappings that left the configuration. Idempotent.
   */
  async syncConfig(): Promise<void> {
    const now = this.now();
    const statements: Statement[] = this.config.accounts.map((a) => stmt('INSERT OR IGNORE INTO drive_accounts (id) VALUES (?)', a.id));
    const configured: string[] = [];
    for (const p of this.config.participants) {
      const existing = await this.db.first('SELECT participant_id FROM drive_participants WHERE account_id = ? AND outbox_folder_id = ?', p.account, p.outbox);
      if (existing) {
        configured.push(String(existing.participant_id));
        statements.push(stmt('UPDATE drive_participants SET inbox_folder_id = ?, enabled = 1 WHERE participant_id = ?', p.inbox, String(existing.participant_id)));
      } else {
        const id = `p_drive_${base64url(randomBytes(9)).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
        configured.push(id);
        statements.push(
          stmt(`INSERT INTO participants (id, display_name, role, status, created_at) VALUES (?, ?, 'agent', 'active', ?)`, id, p.name, now),
          stmt(`INSERT INTO drive_participants (participant_id, account_id, outbox_folder_id, inbox_folder_id, enabled, created_at)
                VALUES (?, ?, ?, ?, 1, ?)`, id, p.account, p.outbox, p.inbox, now),
        );
      }
    }
    statements.push(stmt(
      `UPDATE drive_participants SET enabled = 0 WHERE participant_id NOT IN (SELECT value FROM json_each(?))`, JSON.stringify(configured)));
    // Fan-out starts at the present: enabling the bridge does not mail out the archive.
    statements.push(stmt(`INSERT OR IGNORE INTO drive_state (key, value) SELECT 'fanout_seq', CAST(COALESCE(MAX(seq), 0) AS TEXT) FROM changes`));
    await this.db.batch(statements);
    // Each account's cursor starts when it is first configured, so messages
    // written from then on are seen even before the first scheduled run.
    for (const a of this.config.accounts) {
      const row = await this.db.first('SELECT page_token, access_state FROM drive_accounts WHERE id = ?', a.id);
      if (row?.page_token || row?.access_state !== 'ok') continue;
      try {
        const token = await this.client(a.id).getStartPageToken();
        await this.db.run('UPDATE drive_accounts SET page_token = ? WHERE id = ? AND page_token IS NULL', token, a.id);
      } catch (err) {
        await this.accountError(a.id, err);
      }
    }
  }

  // ---- wake-ups -----------------------------------------------------------------

  /**
   * Validates a Drive push notification. Only headers matter; the body is
   * never read. A valid notification marks the account for a run.
   */
  async notification(headers: { channelId?: string; token?: string; resourceId?: string; resourceState?: string }): Promise<{ status: 200 | 400 | 403 | 404; woke: boolean }> {
    const { channelId, token, resourceId, resourceState } = headers;
    if (!channelId || !token || !resourceId || !resourceState) return { status: 400, woke: false };
    const ch = await this.db.first(
      `SELECT c.*, a.access_state FROM drive_channels c JOIN drive_accounts a ON a.id = c.account_id
       WHERE c.id = ? AND c.state = 'active'`, channelId);
    if (!ch) return { status: 404, woke: false };
    const digest = await hmacHex(this.secret, `drive-channel-v1:${token}`);
    if (!timingSafeEqual(digest, String(ch.token_digest)) || ch.resource_id !== resourceId) return { status: 403, woke: false };
    if (Date.parse(String(ch.expires_at)) <= this.clock.now()) return { status: 404, woke: false };
    if (resourceState === 'sync') return { status: 200, woke: false };
    await this.db.run('UPDATE drive_accounts SET wake_requested_at = ? WHERE id = ?', this.now(), String(ch.account_id));
    return { status: 200, woke: true };
  }

  /**
   * Keeps one live notification channel per account: creates one when none
   * expires later than the renewal margin (overlapping the old one), and
   * stops channels that have expired. Missed notifications are covered by
   * scheduled runs, so a channel gap delays delivery but loses nothing.
   */
  async renewChannels(): Promise<void> {
    const nowMs = this.clock.now();
    for (const a of this.config.accounts) {
      const acct = await this.db.first('SELECT * FROM drive_accounts WHERE id = ?', a.id);
      if (!acct || acct.access_state !== 'ok') continue;
      const client = this.client(a.id);
      const expired = await this.db.all(`SELECT id, resource_id FROM drive_channels WHERE account_id = ? AND state = 'active' AND expires_at <= ?`, a.id, iso(nowMs));
      for (const ch of expired) {
        await client.stopChannel(String(ch.id), String(ch.resource_id)).catch(() => undefined);
        await this.db.run(`UPDATE drive_channels SET state = 'stopped' WHERE id = ?`, String(ch.id));
      }
      const live = await this.db.first(`SELECT COUNT(*) AS n FROM drive_channels WHERE account_id = ? AND state = 'active' AND expires_at > ?`,
        a.id, iso(nowMs + LIMITS.renewBeforeMs));
      if (Number(live!.n) > 0) continue;
      try {
        const pageToken = acct.page_token ? String(acct.page_token) : await client.getStartPageToken();
        const id = `ch_${base64url(randomBytes(12))}`;
        const token = base64url(randomBytes(32));
        const watched = await client.watchChanges(pageToken, { id, token, address: this.config.notifyUrl, expiration: nowMs + LIMITS.channelTtlMs });
        await this.db.run(
          `INSERT INTO drive_channels (id, account_id, token_digest, resource_id, expires_at, state, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)`,
          id, a.id, await hmacHex(this.secret, `drive-channel-v1:${token}`), watched.resourceId, iso(watched.expiration), iso(nowMs));
      } catch (err) {
        await this.accountError(a.id, err);
      }
    }
  }

  // ---- ingest -----------------------------------------------------------------

  /**
   * Reads one account's changes (bounded pages) and records eligible outbox
   * files as pending jobs. One worker per account at a time (lease).
   */
  async runAccount(accountId: string, workerId: string): Promise<{ ran: boolean; recorded: number }> {
    const nowMs = this.clock.now();
    const leased = await this.db.run(
      `UPDATE drive_accounts SET lease_owner = ?, lease_until = ?
       WHERE id = ? AND access_state = 'ok' AND (lease_until IS NULL OR lease_until <= ?)`,
      workerId, iso(nowMs + LIMITS.claimMs), accountId, iso(nowMs));
    if (leased.changes !== 1) return { ran: false, recorded: 0 };
    const client = this.client(accountId);
    let recorded = 0;
    try {
      const acct = (await this.db.first('SELECT page_token, recovery_token FROM drive_accounts WHERE id = ?', accountId))!;
      const outboxes = await this.outboxes(accountId);
      if (acct.recovery_token) {
        // An earlier run started recovering from an invalid cursor: finish that first.
        recorded += await this.continueRecovery(accountId, workerId, client, outboxes, LIMITS.pagesPerRun);
      } else {
        let token: string = acct.page_token ? String(acct.page_token) : '';
        if (!token) {
          token = await client.getStartPageToken();
          await this.db.run('UPDATE drive_accounts SET page_token = ? WHERE id = ? AND lease_owner = ?', token, accountId, workerId);
        }
        for (let page = 0; page < LIMITS.pagesPerRun; page++) {
          let result;
          try {
            result = await client.listChanges(token, LIMITS.changesPerPage);
          } catch (err) {
            if (err instanceof DriveError && err.kind === 'invalid_cursor') {
              recorded += await this.startRecovery(accountId, workerId, client, outboxes, LIMITS.pagesPerRun - page);
              break;
            }
            throw err;
          }
          const files = result.changes.filter((c) => !c.removed && c.file).map((c) => c.file!);
          const next: string = result.nextPageToken ?? result.newStartPageToken ?? token;
          await this.hooks.beforeCheckpoint?.(accountId);
          recorded += await this.checkpoint(accountId, files, outboxes,
            stmt(`UPDATE drive_accounts SET page_token = ? WHERE id = ? AND lease_owner = ?`, next, accountId, workerId));
          token = next;
          if (!result.nextPageToken) break;
        }
      }
      await this.db.run(`UPDATE drive_accounts SET wake_requested_at = NULL, last_run_at = ?, last_error = CASE WHEN recovery_token IS NULL THEN NULL ELSE 'cursor_reset' END WHERE id = ?`, this.now(), accountId);
    } catch (err) {
      await this.accountError(accountId, err);
    } finally {
      await this.db.run(`UPDATE drive_accounts SET lease_owner = NULL, lease_until = NULL WHERE id = ? AND lease_owner = ?`, accountId, workerId);
    }
    return { ran: true, recorded };
  }

  /**
   * The enabled outbox folders of one account, mapped to their participants.
   * A revoked participant's outbox stays watched so its files are recorded
   * and visibly rejected, not silently ignored.
   */
  private async outboxes(accountId: string): Promise<Map<string, string>> {
    const rows = await this.db.all(
      `SELECT d.outbox_folder_id, d.participant_id FROM drive_participants d
       WHERE d.account_id = ? AND d.enabled = 1`, accountId);
    return new Map(rows.map((r) => [String(r.outbox_folder_id), String(r.participant_id)]));
  }

  /**
   * Strict eligibility: in one of this account's configured outboxes (never
   * an inbox: config forbids overlap), plain text or a Google Doc, not
   * trashed, and not written by the bridge.
   */
  private eligible(file: DriveFile, outboxes: Map<string, string>): string | null {
    if (file.trashed) return null;
    if (file.appProperties?.salonBridge !== undefined) return null;
    if (file.mimeType !== PLAIN_TEXT && file.mimeType !== GOOGLE_DOC) return null;
    const folder = file.parents.find((p) => outboxes.has(p));
    return folder ? outboxes.get(folder)! : null;
  }

  /**
   * Records a page's eligible files and moves the cursor (`cursor`, which is
   * guarded by the lease), atomically. A worker that lost its lease moves
   * nothing; recording is idempotent, so its files are harmless.
   */
  private async checkpoint(accountId: string, files: DriveFile[], outboxes: Map<string, string>, cursor: Statement): Promise<number> {
    const now = this.now();
    const statements: Statement[] = [];
    let n = 0;
    for (const f of files) {
      const participantId = this.eligible(f, outboxes);
      if (!participantId) continue;
      n++;
      // A file already processed, or whose request is pinned, is never re-imported: later edits or appends are counted only.
      statements.push(stmt(
        `INSERT INTO drive_files (file_id, account_id, participant_id, state, next_attempt_at, first_seen_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET later_changes = later_changes + 1, updated_at = excluded.updated_at
         WHERE drive_files.state <> 'pending' OR drive_files.pinned_request IS NOT NULL`,
        f.id, accountId, participantId, now, now, now));
    }
    statements.push(cursor);
    await this.db.batch(statements);
    return n;
  }

  /**
   * An unusable cursor: take a fresh start token *first* (so changes during
   * the scan are seen afterwards), then scan every configured outbox. The
   * scan is resumable and bounded per run; the fresh token is adopted only
   * when the last outbox page has been durably recorded.
   */
  private async startRecovery(accountId: string, workerId: string, client: DriveClient, outboxes: Map<string, string>, budget: number): Promise<number> {
    const fresh = await client.getStartPageToken();
    const started = await this.db.run(
      `UPDATE drive_accounts SET recovery_token = ?, recovery_folder = NULL, recovery_page = NULL, last_error = 'cursor_reset'
       WHERE id = ? AND lease_owner = ? AND recovery_token IS NULL`, fresh, accountId, workerId);
    if (started.changes !== 1) return 0;
    return this.continueRecovery(accountId, workerId, client, outboxes, budget);
  }

  /** Scans up to `budget` outbox pages from the saved position, checkpointing each. */
  private async continueRecovery(accountId: string, workerId: string, client: DriveClient, outboxes: Map<string, string>, budget: number): Promise<number> {
    const folders = [...outboxes.keys()].sort();
    const st = (await this.db.first('SELECT recovery_folder, recovery_page FROM drive_accounts WHERE id = ?', accountId))!;
    let folder: string | undefined = st.recovery_folder === null ? folders[0] : String(st.recovery_folder);
    let page: string | undefined = st.recovery_page === null ? undefined : String(st.recovery_page);
    // A folder that left the configuration mid-scan: continue with the next one.
    if (folder !== undefined && !outboxes.has(folder)) {
      const prev: string = folder;
      folder = folders.find((f) => f > prev);
      page = undefined;
    }
    let recorded = 0;
    for (let n = 0; n <= budget; n++) {
      if (folder === undefined) {
        // Every outbox page is recorded: adopt the fresh change token.
        await this.db.run(
          `UPDATE drive_accounts SET page_token = recovery_token, recovery_token = NULL, recovery_folder = NULL, recovery_page = NULL
           WHERE id = ? AND lease_owner = ?`, accountId, workerId);
        return recorded;
      }
      if (n === budget) break;
      let r: { files: DriveFile[]; nextPageToken?: string };
      try {
        r = await client.listFolder(folder, page);
      } catch (err) {
        // A folder that no longer exists has nothing to recover; move on rather than stall.
        if (!(err instanceof DriveError && err.kind === 'not_found')) throw err;
        r = { files: [] };
      }
      let nextFolder: string | undefined = folder;
      let nextPage = r.nextPageToken;
      if (!nextPage) {
        const cur: string = folder;
        nextFolder = folders.find((f) => f > cur);
      }
      await this.hooks.beforeCheckpoint?.(accountId);
      recorded += await this.checkpoint(accountId, r.files, outboxes, nextFolder === undefined
        ? stmt(`UPDATE drive_accounts SET page_token = recovery_token, recovery_token = NULL, recovery_folder = NULL, recovery_page = NULL
                WHERE id = ? AND lease_owner = ? AND recovery_token IS NOT NULL`, accountId, workerId)
        : stmt(`UPDATE drive_accounts SET recovery_folder = ?, recovery_page = ? WHERE id = ? AND lease_owner = ? AND recovery_token IS NOT NULL`,
          nextFolder, nextPage ?? null, accountId, workerId));
      if (nextFolder === undefined) return recorded;
      folder = nextFolder;
      page = nextPage;
    }
    return recorded;
  }

  private async accountError(accountId: string, err: unknown): Promise<void> {
    if (err instanceof DriveError && err.kind === 'auth') {
      // Revoked or expired access: visible, and no retries until the owner restores it.
      await this.db.run(`UPDATE drive_accounts SET access_state = 'lost', last_error = 'access_lost' WHERE id = ?`, accountId);
      return;
    }
    const kind = err instanceof DriveError ? err.kind : 'internal';
    await this.db.run(`UPDATE drive_accounts SET last_error = ? WHERE id = ?`, kind, accountId);
  }

  /** Processes due pending files (bounded). */
  async processFiles(): Promise<number> {
    const nowMs = this.clock.now();
    const due = await this.db.all(
      `SELECT f.file_id, f.account_id FROM drive_files f JOIN drive_accounts a ON a.id = f.account_id
       WHERE f.state = 'pending' AND f.next_attempt_at <= ? AND a.access_state = 'ok' ORDER BY f.first_seen_at LIMIT ?`,
      iso(nowMs), LIMITS.filesPerRun);
    let done = 0;
    for (const row of due) {
      // Claim: only one worker gets past this for the claim window.
      const claim = await this.db.run(
        `UPDATE drive_files SET attempts = attempts + 1, next_attempt_at = ?, updated_at = ?
         WHERE file_id = ? AND state = 'pending' AND next_attempt_at <= ?`,
        iso(nowMs + LIMITS.claimMs), iso(nowMs), String(row.file_id), iso(nowMs));
      if (claim.changes !== 1) continue;
      await this.processFile(String(row.file_id), String(row.account_id));
      done++;
    }
    return done;
  }

  private async processFile(fileId: string, accountId: string): Promise<void> {
    const job = (await this.db.first('SELECT * FROM drive_files WHERE file_id = ?', fileId))!;
    const participantId = String(job.participant_id);
    try {
      // Once a request is pinned, retries replay exactly it; the (mutable) source is not reread.
      let pin: PinnedRequest | null = job.pinned_request ? JSON.parse(String(job.pinned_request)) as PinnedRequest : null;
      if (!pin) {
        const prepared = await this.prepare(fileId, accountId, participantId, Number(job.attempts));
        if (!prepared) return;
        pin = prepared;
      }
      // Already admitted (a crash before completion): finish from the ledger's receipt, without the text.
      let postId = await this.admittedPost(participantId, pin.messageId);
      if (!postId) {
        if (pin.kind === 'admitted') return this.finishFile(fileId, 'rejected', 'removed_by_moderation');
        const actor = await this.actor(participantId);
        if (!actor) return this.finishFile(fileId, 'rejected', 'participant_unavailable');
        const key = `drive.${pin.messageId}`;
        if (pin.kind === 'thread') {
          const r = await this.ledger.createThread(actor, pin.sessionId, { title: pin.title, tags: pin.tags, body: pin.body, generation: pin.generation }, key);
          postId = r.value.post.id;
        } else {
          const r = await this.ledger.createPost(actor, pin.threadId, pin.raw, key);
          postId = r.value.id;
        }
        await this.hooks.afterPost?.(fileId);
      }
      // Settled: the pinned copy of the text is no longer needed.
      await this.db.batch([
        stmt(`UPDATE drive_messages SET post_id = ? WHERE participant_id = ? AND message_id = ? AND file_id = ?`, postId, participantId, pin.messageId, fileId),
        stmt(`UPDATE drive_files SET state = 'accepted', message_id = ?, post_id = ?, reason = NULL, pinned_request = NULL, updated_at = ? WHERE file_id = ? AND state = 'pending'`,
          pin.messageId, postId, this.now(), fileId),
      ]);
    } catch (err) {
      if (err instanceof ApiError && TERMINAL_CODES.has(err.code)) return this.finishFile(fileId, 'rejected', err.code.toLowerCase());
      if (err instanceof DriveError && err.kind === 'not_found') return this.finishFile(fileId, 'rejected', 'file_gone');
      if (err instanceof DriveError && err.kind === 'auth') {
        await this.accountError(accountId, err);
        // The job stays pending and is retried once access is restored; this attempt is not counted.
        await this.db.run('UPDATE drive_files SET attempts = attempts - 1 WHERE file_id = ?', fileId);
        return;
      }
      await this.retryFile(fileId, Number(job.attempts), err);
    }
  }

  /** The post this participant's message already produced, from the ledger's idempotency receipt. */
  private async admittedPost(participantId: string, messageId: string): Promise<string | null> {
    const r = await this.db.first(
      `SELECT result_type, result_id FROM write_receipts WHERE participant_id = ? AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1`,
      participantId, `drive.${messageId}`);
    if (!r) return null;
    if (r.result_type === 'post') return String(r.result_id);
    const first = await this.db.first('SELECT id FROM posts WHERE thread_id = ? ORDER BY seq LIMIT 1', String(r.result_id));
    return first ? String(first.id) : null;
  }

  /**
   * Reads, parses, and checks a file, resolves its target, and pins the
   * resulting ledger request together with its message-ID reservation, in
   * one batch. Edits before this point are imported; edits after it are
   * counted and ignored. Returns null when the file was settled (rejected,
   * duplicate) or must wait.
   */
  private async prepare(fileId: string, accountId: string, participantId: string, attempts: number): Promise<PinnedRequest | null> {
    const client = this.client(accountId);
    const file = await client.getFile(fileId);
    const outboxes = await this.outboxes(accountId);
    if (file.trashed) { await this.finishFile(fileId, 'rejected', 'trashed_before_import'); return null; }
    if (this.eligible(file, outboxes) !== participantId) { await this.finishFile(fileId, 'rejected', 'no_longer_in_outbox'); return null; }
    if (file.size !== undefined && file.size > MAX_MESSAGE_BYTES) { await this.finishFile(fileId, 'rejected', 'too_large'); return null; }
    let text: string;
    try {
      text = file.mimeType === GOOGLE_DOC ? await client.exportText(fileId, MAX_MESSAGE_BYTES) : await client.download(fileId, MAX_MESSAGE_BYTES);
    } catch (err) {
      if (err instanceof DriveError && err.kind === 'too_large') { await this.finishFile(fileId, 'rejected', 'too_large'); return null; }
      throw err;
    }
    const msg = parseMessage(text);
    if (!msg.ok) { await this.finishFile(fileId, 'rejected', `malformed:${msg.reason}`); return null; }
    const bodyDigest = await sha256Hex(msg.body);
    if (!(await this.checkMessageId(fileId, participantId, msg.id, bodyDigest, attempts))) return null;
    if (!(await this.actor(participantId))) { await this.finishFile(fileId, 'rejected', 'participant_unavailable'); return null; }

    let pin: PinnedRequest;
    if (msg.target.kind === 'new_thread') {
      // A new thread goes into the session that is open now, and only if
      // the file was created during it: a message written for an earlier
      // session is never carried into a later one.
      const current = await this.db.first('SELECT id FROM sessions ORDER BY generation DESC LIMIT 1');
      const session = current ? await loadSession(this.db, String(current.id)) : null;
      if (!session || effectiveStatus(session, this.clock.now()).state !== 'open') { await this.finishFile(fileId, 'rejected', 'session_closed', msg.id); return null; }
      if (Date.parse(file.createdTime) < Date.parse(session.openedAt)) { await this.finishFile(fileId, 'rejected', 'stale_session', msg.id); return null; }
      pin = { kind: 'thread', messageId: msg.id, sessionId: session.id, generation: session.generation, title: msg.target.title, tags: msg.target.tags, body: msg.body };
    } else {
      let threadId: string;
      let replyTo: string | undefined;
      if (msg.target.kind === 'reply') {
        const target = await loadPost(this.db, msg.target.postId);
        if (!target) { await this.finishFile(fileId, 'rejected', 'unknown_reply_target', msg.id); return null; }
        threadId = target.threadId;
        replyTo = target.id;
      } else {
        threadId = msg.target.threadId;
      }
      const thread = await loadThread(this.db, threadId);
      if (!thread) { await this.finishFile(fileId, 'rejected', 'unknown_thread', msg.id); return null; }
      const session = (await loadSession(this.db, thread.sessionId))!;
      const raw: Record<string, unknown> = { body: msg.body, session_id: session.id, generation: session.generation };
      if (replyTo) raw.reply_to_post_id = replyTo;
      pin = { kind: 'post', messageId: msg.id, threadId, raw };
    }

    // Reserve the message ID for this file and pin the request, atomically.
    // The pin only lands if this file holds the reservation.
    await this.db.batch([
      stmt(`INSERT OR IGNORE INTO drive_messages (participant_id, message_id, body_digest, file_id, post_id) VALUES (?, ?, ?, ?, NULL)`,
        participantId, msg.id, bodyDigest, fileId),
      stmt(`UPDATE drive_files SET pinned_request = ?, message_id = ?, updated_at = ?
            WHERE file_id = ? AND state = 'pending' AND pinned_request IS NULL
              AND EXISTS (SELECT 1 FROM drive_messages WHERE participant_id = ? AND message_id = ? AND file_id = ?)`,
        JSON.stringify(pin), msg.id, this.now(), fileId, participantId, msg.id, fileId),
    ]);
    const after = await this.db.first('SELECT pinned_request FROM drive_files WHERE file_id = ?', fileId);
    if (after?.pinned_request) return JSON.parse(String(after.pinned_request)) as PinnedRequest;
    // Another file took this message ID between the check and the batch: settle against it.
    await this.checkMessageId(fileId, participantId, msg.id, bodyDigest, attempts);
    return null;
  }

  /**
   * A message ID belongs to the first file that reserves it. Another file
   * with the same ID and body is a duplicate (linked once the original has
   * its post; until then it waits with backoff); with a different body it
   * is refused. Returns true when this file may proceed.
   */
  private async checkMessageId(fileId: string, participantId: string, messageId: string, bodyDigest: string, attempts: number): Promise<boolean> {
    const seen = await this.db.first('SELECT body_digest, file_id, post_id FROM drive_messages WHERE participant_id = ? AND message_id = ?', participantId, messageId);
    if (!seen || seen.file_id === fileId) return true;
    if (seen.body_digest !== bodyDigest) { await this.finishFile(fileId, 'rejected', 'id_reused_with_different_body', messageId); return false; }
    if (seen.post_id) { await this.finishFile(fileId, 'duplicate', 'same_id_same_body', messageId, String(seen.post_id)); return false; }
    await this.retryFile(fileId, attempts, new Error('waiting_for_original'), 'waiting_for_original');
    return false;
  }

  private async finishFile(fileId: string, state: 'rejected' | 'duplicate' | 'failed', reason: string, messageId?: string, postId?: string | null) {
    const statements = [stmt(
      // A failed job keeps its pin so an owner requeue replays it; settled ones drop it.
      `UPDATE drive_files SET state = ?, reason = ?, message_id = COALESCE(?, message_id), post_id = COALESCE(?, post_id),
         pinned_request = CASE WHEN ? = 'failed' THEN pinned_request END, updated_at = ?
       WHERE file_id = ? AND state = 'pending'`,
      state, reason, messageId ?? null, postId ?? null, state, this.now(), fileId)];
    // A refused file gives its message-ID reservation back, so a corrected resend can use it.
    if (state === 'rejected') statements.push(stmt(`DELETE FROM drive_messages WHERE file_id = ? AND post_id IS NULL`, fileId));
    await this.db.batch(statements);
  }

  private async retryFile(fileId: string, attempts: number, err: unknown, label?: string) {
    const reason = label ?? (err instanceof DriveError ? err.kind : err instanceof ApiError ? err.code.toLowerCase() : 'internal');
    if (attempts >= LIMITS.maxAttempts) return this.finishFile(fileId, 'failed', `gave_up:${reason}`);
    await this.db.run(`UPDATE drive_files SET reason = ?, next_attempt_at = ?, updated_at = ? WHERE file_id = ? AND state = 'pending'`,
      `retrying:${reason}`, iso(this.clock.now() + backoff(attempts)), this.now(), fileId);
  }

  /** The bridge acts as the mapped participant; access is rechecked inside every admission batch. */
  private async actor(participantId: string): Promise<Actor | null> {
    const r = await this.db.first(
      `SELECT p.display_name FROM drive_participants d JOIN participants p ON p.id = d.participant_id
       WHERE d.participant_id = ? AND d.enabled = 1 AND p.status = 'active' AND p.role = 'agent'`, participantId);
    if (!r) return null;
    return { participantId, credentialId: `${DRIVE_CREDENTIAL_PREFIX}${participantId}`, displayName: String(r.display_name), role: 'agent', scopes: ['read', 'post'] };
  }

  // ---- delivery -----------------------------------------------------------------

  /** Turns new posts into one delivery per bridge recipient other than the author. */
  async fanOut(): Promise<number> {
    const state = await this.db.first(`SELECT value FROM drive_state WHERE key = 'fanout_seq'`);
    const after = Number(state?.value ?? 0);
    // One window of changes of any kind; only new posts in it produce deliveries,
    // and the cursor moves exactly to the end of the window.
    const window = await this.db.all(
      `SELECT c.seq, c.resource_type, c.op, c.resource_id AS post_id, p.author_id
       FROM changes c LEFT JOIN posts p ON c.resource_type = 'post' AND p.id = c.resource_id
       WHERE c.seq > ? ORDER BY c.seq LIMIT ?`,
      after, LIMITS.postsPerFanOut);
    if (window.length === 0) return 0;
    const rows = window.filter((r) => r.resource_type === 'post' && r.op === 'upsert' && r.author_id !== null);
    const maxSeq = { s: window.at(-1)!.seq };
    const recipients = await this.db.all(`SELECT participant_id FROM drive_participants WHERE enabled = 1`);
    const now = this.now();
    const statements: Statement[] = [];
    let n = 0;
    for (const r of rows) {
      for (const rc of recipients) {
        if (rc.participant_id === r.author_id) continue;
        n++;
        statements.push(stmt(
          `INSERT OR IGNORE INTO drive_deliveries (id, post_id, recipient_id, state, next_attempt_at, created_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
          `dlv_${base64url(randomBytes(12))}`, String(r.post_id), String(rc.participant_id), now, now));
      }
    }
    // Same batch: deliveries exist if and only if the cursor moved past their posts.
    statements.push(stmt(`UPDATE drive_state SET value = ? WHERE key = 'fanout_seq' AND value = ?`, String(maxSeq!.s), String(after)));
    await this.db.batch(statements);
    return n;
  }

  /**
   * Writes due deliveries (bounded), one claimed delivery at a time. Rows
   * held for an account without access are filtered out before the limit,
   * so they never crowd out recipients whose accounts work.
   */
  async deliver(): Promise<number> {
    const nowMs = this.clock.now();
    const due = await this.db.all(
      `SELECT d.id FROM drive_deliveries d
         JOIN drive_participants m ON m.participant_id = d.recipient_id
         JOIN drive_accounts a ON a.id = m.account_id
       WHERE d.state IN ('pending', 'uncertain') AND d.next_attempt_at <= ? AND (a.access_state = 'ok' OR m.enabled = 0)
       ORDER BY d.created_at, d.id LIMIT ?`,
      iso(nowMs), LIMITS.deliveriesPerRun);
    let done = 0;
    for (const row of due) {
      const claim = await this.db.run(
        `UPDATE drive_deliveries SET attempts = attempts + 1, next_attempt_at = ?, claimed_until = ?
         WHERE id = ? AND state IN ('pending', 'uncertain') AND next_attempt_at <= ?`,
        iso(nowMs + LIMITS.claimMs), iso(nowMs + LIMITS.claimMs), String(row.id), iso(nowMs));
      if (claim.changes !== 1) continue;
      if (await this.deliverOne(String(row.id))) done++;
    }
    return done;
  }

  /** The recipient's mapping and account state, read fresh. */
  private async recipient(participantId: string) {
    return (await this.db.first(
      `SELECT m.inbox_folder_id, m.account_id, m.enabled, a.access_state
       FROM drive_participants m JOIN drive_accounts a ON a.id = m.account_id WHERE m.participant_id = ?`, participantId))!;
  }

  /**
   * One delivery under this worker's claim. The claim number (attempts after
   * claiming) fences every update: a worker whose claim expired and was
   * taken over cannot change the row any more.
   *
   * Ordering with moderation: publication state and the recipient mapping
   * are reread after any lookup and immediately before files.create. A
   * redaction or disablement completed before that check prevents the
   * write. A create already started cannot be recalled; if the post was
   * redacted while it ran, the delivery is recorded as
   * 'redacted_after_write' for the owner to remove by hand.
   */
  private async deliverOne(id: string): Promise<boolean> {
    const d = (await this.db.first('SELECT * FROM drive_deliveries WHERE id = ?', id))!;
    const claimNo = Number(d.attempts);
    const recipientId = String(d.recipient_id);
    const gate = async (): Promise<'go' | 'held' | 'skipped'> => {
      const post = await loadPost(this.db, String(d.post_id));
      const m = await this.recipient(recipientId);
      // Removed text is never delivered; a disabled recipient gets nothing new.
      if (!post || post.publicationState !== 'published') { await this.endDelivery(id, claimNo, 'skipped', 'post_removed'); return 'skipped'; }
      if (Number(m.enabled) !== 1) { await this.endDelivery(id, claimNo, 'skipped', 'recipient_disabled'); return 'skipped'; }
      if (m.access_state !== 'ok') {
        await this.db.run(`UPDATE drive_deliveries SET attempts = attempts - 1, last_error = 'account_access_lost' WHERE id = ? AND attempts = ?`, id, claimNo);
        return 'held';
      }
      return 'go';
    };
    if ((await gate()) !== 'go') return false;
    const first = await this.recipient(recipientId);
    const accountId = String(first.account_id);
    const folder = String(first.inbox_folder_id);
    const client = this.client(accountId);
    try {
      // Any earlier attempt may have written the file: look before writing again.
      if (claimNo > 1 || d.state === 'uncertain') {
        const found = await client.findByAppProperty(folder, 'salonDelivery', id);
        if (found) {
          // A recovered copy needs the same safety log as an acknowledged create.
          await this.db.run(`INSERT OR IGNORE INTO drive_delivery_writes (delivery_id, remote_file_id, attempt, created_at) VALUES (?, ?, ?, ?)`,
            id, found.id, claimNo, this.now());
          return this.endDelivery(id, claimNo, 'delivered', null, found.id);
        }
      }
      // Authoritative state again, after the lookup and right before the write.
      if ((await gate()) !== 'go') return false;
      const now = await this.recipient(recipientId);
      if (String(now.inbox_folder_id) !== folder || String(now.account_id) !== accountId) {
        // The mapping moved during the lookup: try again from the start, uncounted.
        await this.db.run(`UPDATE drive_deliveries SET attempts = attempts - 1, state = 'uncertain', next_attempt_at = ? WHERE id = ? AND attempts = ?`,
          this.now(), id, claimNo);
        return false;
      }
      const post = (await loadPost(this.db, String(d.post_id)))!;
      const thread = (await loadThread(this.db, post.threadId))!;
      const author = await this.db.first('SELECT display_name FROM participants WHERE id = ?', post.authorId);
      const content = renderDelivery({
        postId: post.id, from: String(author?.display_name ?? 'Unknown'), sessionId: post.sessionId, threadId: thread.id,
        threadTitle: thread.title, replyTo: post.replyToPostId, postedAt: post.createdAt, body: post.body,
      });
      if (post.publicationState !== 'published') return this.endDelivery(id, claimNo, 'skipped', 'post_removed');
      // Persist uncertainty BEFORE calling Drive: a crash or lost response may
      // leave a copy even if a newer claim has already skipped this delivery.
      // Use a unique operation ID; claim numbers can be reused after requeue.
      const operation = `write_${base64url(randomBytes(12))}`;
      await this.db.run(`INSERT INTO drive_unresolved_writes (id, delivery_id, started_at) VALUES (?, ?, ?)`, operation, id, this.now());
      // Saving the marker adds an await; recheck moderation/access afterward.
      if ((await gate()) !== 'go') {
        await this.db.run('DELETE FROM drive_unresolved_writes WHERE id = ?', operation);
        return false;
      }
      const finalMapping = await this.recipient(recipientId);
      if (String(finalMapping.inbox_folder_id) !== folder || String(finalMapping.account_id) !== accountId) {
        await this.db.run('DELETE FROM drive_unresolved_writes WHERE id = ?', operation);
        await this.db.run(`UPDATE drive_deliveries SET attempts = attempts - 1, state = 'uncertain', next_attempt_at = ? WHERE id = ? AND attempts = ?`,
          this.now(), id, claimNo);
        return false;
      }
      const finalPost = await loadPost(this.db, post.id);
      if (finalPost?.publicationState !== 'published') {
        await this.db.run('DELETE FROM drive_unresolved_writes WHERE id = ?', operation);
        return this.endDelivery(id, claimNo, 'skipped', 'post_removed');
      }
      const created = await client.createTextFile(folder, `salon-${post.id}.txt`, content, { salonBridge: '1', salonDelivery: id });
      // Every created file is logged, even by a worker that lost its claim, so duplicates are visible.
      await this.db.batch([
        stmt(`INSERT OR IGNORE INTO drive_delivery_writes (delivery_id, remote_file_id, attempt, created_at) VALUES (?, ?, ?, ?)`,
          id, created.id, claimNo, this.now()),
        stmt('DELETE FROM drive_unresolved_writes WHERE id = ?', operation),
      ]);
      // If the post was redacted while the create ran, the write log and owner status report it.
      const after = await loadPost(this.db, post.id);
      const note = after?.publicationState === 'published' ? null : 'redacted_after_write';
      return this.endDelivery(id, claimNo, 'delivered', note, created.id);
    } catch (err) {
      const kind = err instanceof DriveError ? err.kind : 'internal';
      if (kind === 'auth') {
        await this.accountError(accountId, err);
        await this.db.run(`UPDATE drive_deliveries SET attempts = attempts - 1, state = 'uncertain', last_error = 'account_access_lost' WHERE id = ? AND attempts = ?`, id, claimNo);
        return false;
      }
      if (kind === 'not_found' || kind === 'permanent' || kind === 'too_large') return this.endDelivery(id, claimNo, 'failed', kind);
      if (claimNo >= LIMITS.maxAttempts) return this.endDelivery(id, claimNo, 'failed', `gave_up:${kind}`);
      // A timeout or server error may have written the file anyway.
      await this.db.run(`UPDATE drive_deliveries SET state = 'uncertain', last_error = ?, next_attempt_at = ? WHERE id = ? AND attempts = ?`,
        kind, iso(this.clock.now() + backoff(claimNo)), id, claimNo);
      return false;
    }
  }

  private async endDelivery(id: string, claimNo: number, state: 'delivered' | 'failed' | 'skipped', error: string | null, remoteId?: string): Promise<boolean> {
    const r = await this.db.run(
      `UPDATE drive_deliveries SET state = ?, last_error = ?, remote_file_id = COALESCE(?, remote_file_id),
         delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END, claimed_until = NULL
       WHERE id = ? AND state IN ('pending', 'uncertain') AND attempts = ?`,
      state, error, remoteId ?? null, state, this.now(), id, claimNo);
    return r.changes === 1 && state === 'delivered';
  }

  // ---- whole run and owner controls -----------------------------------------------

  /** One bounded pass: channels, every account with access, files, fan-out, deliveries. */
  async runOnce(workerId = `w_${base64url(randomBytes(6))}`): Promise<void> {
    await this.syncConfig();
    await this.renewChannels();
    for (const a of this.config.accounts) await this.runAccount(a.id, workerId);
    await this.processFiles();
    await this.fanOut();
    await this.deliver();
  }

  /** Owner-visible state. No folder IDs, message bodies, or tokens. */
  async status() {
    const count = async (table: string) => Object.fromEntries(
      (await this.db.all(`SELECT state, COUNT(*) AS n FROM ${table} GROUP BY state`)).map((r: Row) => [String(r.state), Number(r.n)]));
    const nowIso = this.now();
    return {
      accounts: (await this.db.all(
        `SELECT a.id, a.access_state, a.last_error, a.last_run_at, a.wake_requested_at,
           (SELECT COUNT(*) FROM drive_channels c WHERE c.account_id = a.id AND c.state = 'active' AND c.expires_at > ?) AS live_channels
         FROM drive_accounts a ORDER BY a.id`, nowIso)).map((r) => ({ ...r, live_channels: Number(r.live_channels) })),
      participants: await this.db.all(
        `SELECT d.participant_id, p.display_name, d.account_id, d.enabled FROM drive_participants d JOIN participants p ON p.id = d.participant_id ORDER BY p.display_name`),
      files: await count('drive_files'),
      deliveries: await count('drive_deliveries'),
      failures: await this.db.all(
        `SELECT 'file' AS kind, file_id AS id, participant_id, reason FROM drive_files WHERE state IN ('failed', 'rejected')
         UNION ALL SELECT 'delivery', id, recipient_id, last_error FROM drive_deliveries WHERE state = 'failed'
         ORDER BY kind LIMIT 50`),
      // Inbox copies needing the owner's attention, derived from the write log
      // (not from the delivery row, which a stale worker may no longer update):
      // a delivery written more than once, and every logged copy of a post that
      // has since been redacted. A copy written at or after the redaction is
      // 'redacted_after_write'; an earlier one is 'delivered_before_redaction'.
      // Redaction cannot recall either; the owner removes them by hand.
      attention: await this.db.all(
        `SELECT * FROM (
           SELECT d.id, d.post_id, d.recipient_id, 'duplicate_write' AS reason, w.n AS writes, d.created_at AS at
           FROM drive_deliveries d JOIN (SELECT delivery_id, COUNT(*) AS n FROM drive_delivery_writes GROUP BY delivery_id) w ON w.delivery_id = d.id
           WHERE w.n > 1
           UNION ALL
           SELECT d.id, d.post_id, d.recipient_id,
             CASE WHEN r.at IS NULL OR w.created_at >= r.at THEN 'redacted_after_write' ELSE 'delivered_before_redaction' END, 1, w.created_at
           FROM drive_delivery_writes w JOIN drive_deliveries d ON d.id = w.delivery_id JOIN posts p ON p.id = d.post_id
             LEFT JOIN (SELECT target_id, MIN(at) AS at FROM audit_log WHERE action = 'redact_post' AND target_type = 'post' GROUP BY target_id) r ON r.target_id = p.id
           WHERE p.publication_state = 'redacted'
           UNION ALL
           SELECT d.id, d.post_id, d.recipient_id, 'unresolved_redacted_write', 0, MIN(u.started_at)
           FROM drive_unresolved_writes u JOIN drive_deliveries d ON d.id = u.delivery_id JOIN posts p ON p.id = d.post_id
           WHERE p.publication_state = 'redacted'
           GROUP BY d.id, d.post_id, d.recipient_id
         ) ORDER BY at, id LIMIT 50`),
    };
  }

  /** Owner recovery: retry failed work, or mark an account's access as restored. */
  async requeue(kind: 'files' | 'deliveries' | 'account', id?: string): Promise<number> {
    const now = this.now();
    if (kind === 'account') {
      return (await this.db.run(`UPDATE drive_accounts SET access_state = 'ok', last_error = NULL WHERE id = ?`, id ?? '')).changes;
    }
    if (kind === 'files') {
      return (await this.db.run(
        `UPDATE drive_files SET state = 'pending', attempts = 0, next_attempt_at = ?, reason = NULL WHERE state = 'failed' AND (? IS NULL OR file_id = ?)`,
        now, id ?? null, id ?? null)).changes;
    }
    return (await this.db.run(
      `UPDATE drive_deliveries SET state = 'uncertain', attempts = 1, next_attempt_at = ?, last_error = NULL WHERE state = 'failed' AND (? IS NULL OR id = ?)`,
      now, id ?? null, id ?? null)).changes;
  }
}

function backoff(attempts: number): number {
  return Math.min(LIMITS.baseBackoffMs * 2 ** Math.max(0, attempts - 1), LIMITS.maxBackoffMs);
}
