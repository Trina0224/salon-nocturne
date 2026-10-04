// Recovery after a D1 Time Travel restore. Restores overwrite the database in
// place and bring back the state of the restore point, including text that was
// redacted later, credentials and participants that were revoked later, and
// sessions that were closed later. The owner captures the live state before
// restoring, then runs the SQL generated here against the restored database
// while the Worker is in maintenance mode. See docs/deployment.md.
//
// Ops tooling only: nothing in the Worker imports this file.

/** Run against the live database before restoring; returns one row, one column. */
export const CAPTURE_SQL = `SELECT json_object(
  'captured_at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'max_seq', (SELECT COALESCE(MAX(seq), 0) FROM changes),
  'redacted_posts', (SELECT json_group_array(id) FROM posts WHERE publication_state = 'redacted'),
  'revoked_participants', (SELECT json_group_array(json_object('id', id, 'revoked_at', revoked_at)) FROM participants WHERE status = 'revoked'),
  'revoked_credentials', (SELECT json_group_array(json_object('id', id, 'revoked_at', revoked_at)) FROM credentials WHERE revoked_at IS NOT NULL),
  'closed_sessions', (SELECT json_group_array(json_object('id', id, 'closed_at', closed_at, 'close_reason', close_reason)) FROM sessions WHERE state = 'closed')
) AS capture`;

export interface RecoveryCapture {
  captured_at: string;
  /** Highest change sequence before the restore; new writes must land above it. */
  max_seq: number;
  redacted_posts: string[];
  revoked_participants: { id: string; revoked_at: string }[];
  revoked_credentials: { id: string; revoked_at: string }[];
  closed_sessions: { id: string; closed_at: string; close_reason: 'owner' | 'deadline' }[];
}

/** Run against the restored database after reapplying; every count must be 0. */
export function verifySql(c: RecoveryCapture): string {
  const ids = (xs: { id: string }[] | string[]) => list(xs.map((x) => (typeof x === 'string' ? x : x.id)));
  return `SELECT
  (SELECT COUNT(*) FROM posts WHERE publication_state <> 'redacted' AND id IN (${ids(c.redacted_posts)})) AS unredacted_posts,
  (SELECT COUNT(*) FROM post_search WHERE post_id IN (${ids(c.redacted_posts)})) AS searchable_redacted_posts,
  (SELECT COUNT(*) FROM participants WHERE status <> 'revoked' AND id IN (${ids(c.revoked_participants)})) AS active_revoked_participants,
  (SELECT COUNT(*) FROM credentials WHERE revoked_at IS NULL AND (id IN (${ids(c.revoked_credentials)}) OR participant_id IN (${ids(c.revoked_participants)}))) AS live_revoked_credentials,
  (SELECT COUNT(*) FROM sessions WHERE state <> 'closed' AND id IN (${ids(c.closed_sessions)})) AS reopened_sessions,
  (SELECT CASE WHEN COALESCE(MAX(seq), 0) >= ${c.max_seq} THEN 0 ELSE 1 END FROM changes) AS sequence_behind,
  (SELECT COUNT(*) FROM admin_operations WHERE state IN ('proposed', 'approved')) AS open_admin_operations`;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
const NEXT_SEQ = `(SELECT COALESCE(MAX(seq), 0) + 1 FROM changes)`;

// Values are validated against strict patterns first, so these literals can
// never contain a quote; quoting is still applied.
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const list = (xs: string[]) => (xs.length ? xs.map(lit).join(', ') : `''`);

function fail(msg: string): never {
  throw new Error(`Invalid recovery capture: ${msg}`);
}

function arr(v: unknown, name: string): unknown[] {
  // json_group_array may arrive as a JSON string inside the outer object.
  const parsed = typeof v === 'string' ? JSON.parse(v) : v;
  if (!Array.isArray(parsed)) fail(`${name} must be an array`);
  return parsed;
}

function id(v: unknown, name: string): string {
  if (typeof v !== 'string' || !ID.test(v)) fail(`${name} has a malformed id`);
  return v;
}

function ts(v: unknown, name: string): string {
  if (typeof v !== 'string' || !TS.test(v)) fail(`${name} has a malformed timestamp`);
  return v;
}

/**
 * Accepts the capture object itself, its JSON text, or the output of
 * `wrangler d1 execute --json --command "<CAPTURE_SQL>"`.
 */
export function parseCapture(input: unknown): RecoveryCapture {
  let v: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  if (Array.isArray(v)) v = (v[0] as { results?: unknown[] } | undefined)?.results?.[0];
  if (v && typeof v === 'object' && 'capture' in v) v = (v as { capture: unknown }).capture;
  if (typeof v === 'string') v = JSON.parse(v);
  if (!v || typeof v !== 'object') fail('expected one captured object');
  const o = v as Record<string, unknown>;
  if (!Number.isSafeInteger(o.max_seq) || (o.max_seq as number) < 0) fail('max_seq must be a non-negative integer');
  return {
    captured_at: ts(o.captured_at, 'captured_at'),
    max_seq: o.max_seq as number,
    redacted_posts: arr(o.redacted_posts, 'redacted_posts').map((x) => id(x, 'redacted_posts')),
    revoked_participants: arr(o.revoked_participants, 'revoked_participants').map((x) => {
      const r = x as Record<string, unknown>;
      return { id: id(r?.id, 'revoked_participants'), revoked_at: ts(r?.revoked_at, 'revoked_participants') };
    }),
    revoked_credentials: arr(o.revoked_credentials, 'revoked_credentials').map((x) => {
      const r = x as Record<string, unknown>;
      return { id: id(r?.id, 'revoked_credentials'), revoked_at: ts(r?.revoked_at, 'revoked_credentials') };
    }),
    closed_sessions: arr(o.closed_sessions, 'closed_sessions').map((x) => {
      const r = x as Record<string, unknown>;
      if (r?.close_reason !== 'owner' && r?.close_reason !== 'deadline') fail('closed_sessions has a bad close_reason');
      return { id: id(r.id, 'closed_sessions'), closed_at: ts(r.closed_at, 'closed_sessions'), close_reason: r.close_reason };
    }),
  };
}

/**
 * SQL that reapplies the captured state to a restored database. Every
 * statement is conditional, so running it twice changes nothing the second
 * time. No BEGIN/COMMIT: `wrangler d1 execute --file` runs the file itself.
 */
export function reapplySql(c: RecoveryCapture): string {
  const out: string[] = [
    '-- Generated by scripts/recovery-sql.ts. Run only on the restored database, in maintenance mode.',
    `-- Capture taken ${c.captured_at}.`,
    '',
    '-- 1. Move the change sequence past every value issued before the restore, so cursors',
    '--    handed out after the restore point cannot skip new changes. The marker is a',
    '--    harmless upsert of the latest session, which readers simply re-fetch.',
    `INSERT INTO changes (seq, session_id, resource_type, resource_id, op, revision, created_at)
  SELECT ${c.max_seq}, id, 'session', id, 'upsert', revision, ${NOW}
  FROM (SELECT id, revision FROM sessions ORDER BY generation DESC LIMIT 1)
  WHERE (SELECT COALESCE(MAX(seq), 0) FROM changes) < ${c.max_seq};`,
    '',
    '-- 2. Redactions: discard the text again, drop it from search, and emit a tombstone.',
  ];
  for (const p of c.redacted_posts) {
    const live = `id = ${lit(p)} AND publication_state = 'published'`;
    out.push(
      `DELETE FROM post_search WHERE rowid = (SELECT seq FROM posts WHERE ${live});`,
      `INSERT INTO changes (seq, session_id, resource_type, resource_id, op, revision, created_at)
  SELECT ${NEXT_SEQ}, session_id, 'post', id, 'tombstone', revision + 1, ${NOW} FROM posts WHERE ${live};`,
      `UPDATE posts SET body = '', publication_state = 'redacted', revision = revision + 1 WHERE ${live};`,
    );
  }
  out.push('', '-- 3. Revocations: participants (with all their credentials), then single credentials.');
  for (const r of c.revoked_participants) {
    out.push(
      `UPDATE participants SET status = 'revoked', revoked_at = ${lit(r.revoked_at)} WHERE id = ${lit(r.id)} AND status <> 'revoked';`,
      `UPDATE credentials SET revoked_at = ${lit(r.revoked_at)} WHERE participant_id = ${lit(r.id)} AND revoked_at IS NULL;`,
    );
  }
  for (const r of c.revoked_credentials) {
    out.push(`UPDATE credentials SET revoked_at = ${lit(r.revoked_at)} WHERE id = ${lit(r.id)} AND revoked_at IS NULL;`);
  }
  out.push('', '-- 4. Sessions closed after the restore point stay closed.');
  for (const s of c.closed_sessions) {
    const open = `id = ${lit(s.id)} AND state = 'open'`;
    out.push(
      `INSERT INTO changes (seq, session_id, resource_type, resource_id, op, revision, created_at)
  SELECT ${NEXT_SEQ}, id, 'session', id, 'upsert', revision + 1, ${NOW} FROM sessions WHERE ${open};`,
      `UPDATE sessions SET state = 'closed', closed_at = ${lit(s.closed_at)}, close_reason = ${lit(s.close_reason)}, revision = revision + 1 WHERE ${open};`,
    );
  }
  out.push(
    '',
    '-- 5. Administrative approvals: a restored approval may already have been used or',
    '--    revoked after the restore point, so none survives. Proposals must be made again.',
    `UPDATE admin_operations SET state = 'revoked', decided_at = ${NOW}, decision_reason = 'withdrawn by restore'
  WHERE state = 'approved';`,
    `UPDATE admin_operations SET state = 'rejected', decided_at = ${NOW}, decision_reason = 'withdrawn by restore'
  WHERE state = 'proposed';`,
    '',
    '-- 6. Record the reapply in the audit log.',
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, reason, at)
  VALUES ('p_host', 'restore_reapply', 'database', 'DB', ${lit(`capture ${c.captured_at}`)}, ${NOW});`,
    '',
  );
  return out.join('\n');
}
