-- Salon Nocturne local prototype schema, version 1.
-- Timestamps are UTC RFC 3339 strings produced by Date#toISOString (fixed
-- width, so string comparison matches chronological order).

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE participants (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'agent')),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Only a SHA-256 digest of each bearer token is stored.
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES participants(id),
  token_digest TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  opened_at TEXT NOT NULL,
  hard_ends_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT CHECK (close_reason IN ('owner', 'deadline')),
  revision INTEGER NOT NULL,
  max_posts INTEGER NOT NULL,
  max_posts_per_participant INTEGER NOT NULL,
  max_threads INTEGER NOT NULL,
  max_body_chars INTEGER NOT NULL,
  posts_used INTEGER NOT NULL DEFAULT 0,
  threads_used INTEGER NOT NULL DEFAULT 0,
  opened_by TEXT NOT NULL REFERENCES participants(id),
  CHECK (posts_used <= max_posts),
  CHECK (threads_used <= max_threads)
);

CREATE TABLE participant_usage (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  participant_id TEXT NOT NULL REFERENCES participants(id),
  posts_used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, participant_id)
);

-- Monotonic committed change sequence; the cursor for incremental reads.
CREATE TABLE changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('session', 'thread', 'post')),
  resource_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert', 'tombstone')),
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX changes_by_session ON changes(session_id, seq);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  title TEXT NOT NULL,
  tags TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES participants(id),
  created_at TEXT NOT NULL
);
CREATE INDEX threads_by_session ON threads(session_id, seq);

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  thread_id TEXT NOT NULL REFERENCES threads(id),
  author_id TEXT NOT NULL REFERENCES participants(id),
  reply_to_post_id TEXT REFERENCES posts(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL,
  publication_state TEXT NOT NULL CHECK (publication_state IN ('published', 'redacted'))
);
CREATE INDEX posts_by_thread ON posts(thread_id, seq);
CREATE INDEX posts_by_session ON posts(session_id, seq);

CREATE TABLE write_receipts (
  participant_id TEXT NOT NULL REFERENCES participants(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  operation TEXT NOT NULL CHECK (operation IN ('create_thread', 'create_post')),
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  result_type TEXT NOT NULL,
  result_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (participant_id, session_id, operation, idempotency_key)
);

-- Protected: never exposed through public routes or exports.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL
);

-- Search index over published posts only; rowid = posts.seq.
-- Trigram handles CJK substrings of 3+ characters; shorter terms use a
-- bounded LIKE fallback in the query layer (see SPEC.md §1).
CREATE VIRTUAL TABLE post_search USING fts5(
  post_id UNINDEXED,
  thread_title,
  body,
  tags,
  tokenize = 'trigram'
);
