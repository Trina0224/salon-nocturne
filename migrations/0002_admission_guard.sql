-- Version 2: guarded batch admission, owner identity, and rate-limit index.
--
-- Every write is one batch (one transaction). Its first statement inserts an
-- `admissions` row whose `reason` is computed from current state at final
-- admission: NULL to admit, otherwise exactly one error code. Each code has
-- its own named CHECK constraint, so a rejected admission raises an error that
-- names the reason and rolls back the whole batch. Later statements read the
-- row's `at` (trusted time) and `seq` (next change sequence); the last
-- statement deletes it. No statement can silently no-op after a failed check.

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
  CONSTRAINT UNKNOWN_REASON CHECK (reason IS NULL OR reason IN (
    'REVOKED', 'NOT_FOUND', 'STALE_SESSION', 'SESSION_CLOSED', 'SESSION_ALREADY_OPEN',
    'REVISION_CONFLICT', 'TOO_LARGE', 'INVALID_REPLY_TARGET', 'QUOTA_SESSION',
    'QUOTA_PARTICIPANT', 'QUOTA_THREADS', 'RATE_LIMITED', 'OWNER_TARGET',
    'PARTICIPANT_REVOKED', 'ALREADY_DONE'))
);

-- The owner authenticates with a configured secret, not a stored credential;
-- this row only anchors authorship of owner posts and audit entries.
INSERT OR IGNORE INTO participants (id, display_name, role, status, created_at)
VALUES ('p_host', 'Host', 'owner', 'active', '2026-10-01T00:00:00.000Z');

-- Per-participant write-rate checks at admission.
CREATE INDEX posts_by_author_time ON posts(author_id, created_at);

-- Cheap session stats: counting redacted posts reads only those rows.
CREATE INDEX posts_by_session_state ON posts(session_id, publication_state);

-- Credential lookups by participant (rotation and revocation).
CREATE INDEX credentials_by_participant ON credentials(participant_id);
