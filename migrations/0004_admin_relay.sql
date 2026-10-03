-- Version 4: owner-approved administration relay.
--
-- A relay (for example the agent Rei, through a dedicated relay binding)
-- proposes one administrative operation. Only the owner, authenticated by the
-- owner secret over the REST API, can approve it, and the approval binds the
-- exact operation, target, canonical parameters, service context, executor,
-- and an expiry. The relay then executes it once; execution is one guarded
-- batch that consumes the approval atomically.
--
-- New admission reasons need new named CHECK constraints. `admissions` only
-- ever holds rows inside an uncommitted batch (the last statement of every
-- batch deletes its row), so it is empty here and can be rebuilt safely.

DROP TABLE admissions;
CREATE TABLE admissions (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  seq INTEGER NOT NULL,
  session_id TEXT,
  reason TEXT,
  CONSTRAINT REVOKED CHECK (reason IS NOT 'REVOKED'),
  CONSTRAINT NOT_FOUND CHECK (reason IS NOT 'NOT_FOUND'),
  CONSTRAINT STALE_SESSION CHECK (reason IS NOT 'STALE_SESSION'),
  CONSTRAINT SESSION_CLOSED CHECK (reason IS NOT 'SESSION_CLOSED'),
  CONSTRAINT SESSION_ALREADY_OPEN CHECK (reason IS NOT 'SESSION_ALREADY_OPEN'),
  CONSTRAINT REVISION_CONFLICT CHECK (reason IS NOT 'REVISION_CONFLICT'),
  CONSTRAINT TOO_LARGE CHECK (reason IS NOT 'TOO_LARGE'),
  CONSTRAINT INVALID_REPLY_TARGET CHECK (reason IS NOT 'INVALID_REPLY_TARGET'),
  CONSTRAINT QUOTA_SESSION CHECK (reason IS NOT 'QUOTA_SESSION'),
  CONSTRAINT QUOTA_PARTICIPANT CHECK (reason IS NOT 'QUOTA_PARTICIPANT'),
  CONSTRAINT QUOTA_THREADS CHECK (reason IS NOT 'QUOTA_THREADS'),
  CONSTRAINT RATE_LIMITED CHECK (reason IS NOT 'RATE_LIMITED'),
  CONSTRAINT OWNER_TARGET CHECK (reason IS NOT 'OWNER_TARGET'),
  CONSTRAINT PARTICIPANT_REVOKED CHECK (reason IS NOT 'PARTICIPANT_REVOKED'),
  CONSTRAINT ALREADY_DONE CHECK (reason IS NOT 'ALREADY_DONE'),
  CONSTRAINT NOT_APPROVED CHECK (reason IS NOT 'NOT_APPROVED'),
  CONSTRAINT APPROVAL_EXPIRED CHECK (reason IS NOT 'APPROVAL_EXPIRED'),
  CONSTRAINT APPROVAL_REVOKED CHECK (reason IS NOT 'APPROVAL_REVOKED'),
  CONSTRAINT APPROVAL_USED CHECK (reason IS NOT 'APPROVAL_USED'),
  CONSTRAINT WRONG_EXECUTOR CHECK (reason IS NOT 'WRONG_EXECUTOR'),
  CONSTRAINT UNKNOWN_REASON CHECK (reason IS NULL OR reason IN (
    'REVOKED', 'NOT_FOUND', 'STALE_SESSION', 'SESSION_CLOSED', 'SESSION_ALREADY_OPEN',
    'REVISION_CONFLICT', 'TOO_LARGE', 'INVALID_REPLY_TARGET', 'QUOTA_SESSION',
    'QUOTA_PARTICIPANT', 'QUOTA_THREADS', 'RATE_LIMITED', 'OWNER_TARGET',
    'PARTICIPANT_REVOKED', 'ALREADY_DONE', 'NOT_APPROVED', 'APPROVAL_EXPIRED',
    'APPROVAL_REVOKED', 'APPROVAL_USED', 'WRONG_EXECUTOR'))
);

-- One proposed administrative operation and its approval lifecycle:
-- proposed -> approved -> executed, or proposed -> rejected, or
-- approved -> revoked. Expiry is a time check, not a stored state.
-- `params` holds canonical parameters with OAuth subjects replaced by their
-- peppered digests; no credential or external account ID is stored.
CREATE TABLE admin_operations (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL CHECK (operation IN ('enroll_participant', 'bind_identity', 'revoke_binding', 'revoke_participant')),
  target TEXT NOT NULL,
  params TEXT NOT NULL,
  -- Shown to the owner so she can check an OAuth subject without it being stored.
  subject_fingerprint TEXT,
  context TEXT NOT NULL,
  digest TEXT NOT NULL,
  summary TEXT NOT NULL,
  proposed_by TEXT NOT NULL REFERENCES credentials(id),
  proposed_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('proposed', 'approved', 'executed', 'rejected', 'revoked')),
  decided_at TEXT,
  approval_expires_at TEXT,
  decision_reason TEXT,
  executed_at TEXT,
  idempotency_key TEXT,
  result TEXT
);
CREATE INDEX admin_operations_by_state ON admin_operations(state, proposed_at);
