-- Version 5: Google Drive message bridge (state only; configuration lives in
-- the DRIVE_BRIDGE_CONFIG secret, so private folder IDs are never in the
-- repository). Numbered 0005 so it never collides with the unmerged
-- administration relay's 0004.
--
-- Transport: participant outbox (Drive) -> Salon ledger -> other participants'
-- inboxes (Drive). Ordinary program code; no model in the loop.

-- Who a Drive outbox speaks for. Attribution comes only from this mapping
-- (owner account + outbox folder ID), never from message content.
CREATE TABLE drive_participants (
  participant_id TEXT PRIMARY KEY REFERENCES participants(id),
  account_id TEXT NOT NULL,
  outbox_folder_id TEXT NOT NULL,
  inbox_folder_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (account_id, outbox_folder_id)
);

-- Per-account change cursor, access state, and a lease so one worker at a
-- time processes an account.
CREATE TABLE drive_accounts (
  id TEXT PRIMARY KEY,
  page_token TEXT,
  access_state TEXT NOT NULL DEFAULT 'ok' CHECK (access_state IN ('ok', 'lost')),
  last_error TEXT,
  wake_requested_at TEXT,
  lease_owner TEXT,
  lease_until TEXT,
  last_run_at TEXT
);

-- Notification channels (changes.watch). Only a digest of each channel token
-- is stored. Several channels may overlap during renewal.
CREATE TABLE drive_channels (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES drive_accounts(id),
  token_digest TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'stopped')),
  created_at TEXT NOT NULL
);

-- One row per outbox file ever seen. A file is processed once; later edits
-- or appends to it are counted and ignored, never re-imported.
CREATE TABLE drive_files (
  file_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'duplicate', 'rejected', 'failed')),
  reason TEXT,
  message_id TEXT,
  post_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  later_changes INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX drive_files_due ON drive_files(state, next_attempt_at);

-- Message IDs are unique per participant; the body digest detects a reused
-- ID with a changed body.
CREATE TABLE drive_messages (
  participant_id TEXT NOT NULL REFERENCES participants(id),
  message_id TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  file_id TEXT NOT NULL,
  post_id TEXT,
  PRIMARY KEY (participant_id, message_id)
);

-- One delivery per (post, recipient). 'uncertain' means a write may have
-- happened; the next attempt looks for the marked file before writing again.
CREATE TABLE drive_deliveries (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  recipient_id TEXT NOT NULL REFERENCES participants(id),
  state TEXT NOT NULL CHECK (state IN ('pending', 'uncertain', 'delivered', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  claimed_until TEXT,
  remote_file_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (post_id, recipient_id)
);
CREATE INDEX drive_deliveries_due ON drive_deliveries(state, next_attempt_at);

-- Small key/value state, e.g. the change sequence fan-out has reached.
CREATE TABLE drive_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
