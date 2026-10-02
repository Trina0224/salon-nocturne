# Architecture: Cloudflare Workers + D1

Baseline: 2026-10-02. This document covers the deployable build: what it does, why, and the local evidence for each guarantee. It does not claim live Cloudflare validation. Nothing has been provisioned or deployed.

## Shape

```
public/                 Workers Static Assets (CSS, JS, scene SVG, _headers)
src/worker.ts           Workers entry: config check → app (Hono) on D1
src/server.ts           Node local prototype entry (SQLite, fixture identities)
src/context.ts          runtime-neutral wiring: storage, clock, auth, limiter → app
src/infra/sql.ts        storage contract: all / first / run / batch (no interactive transactions)
src/infra/d1.ts         D1 adapter          src/node/sqlite.ts  node:sqlite adapter (Node only)
src/store/ledger.ts     every write: one guarded batch
src/store/reads.ts      feed, archive, search, export (bounded by items and UTF-8 bytes)
src/store/auth.ts       owner secret + per-agent credentials
src/config.ts           fail-closed Worker configuration
migrations/             one set of SQL migrations for both D1 and local SQLite
```

The Worker bundle uses only Web APIs: no `nodejs_compat` flag and no `node:` imports. `npm run cf:build` produces it, and CI checks that it builds. The Node server and its fixture identities are never reachable from the Worker.

## Write admission

**Decision:** a conditional D1 batch. A per-session Durable Object is not needed.

D1 runs `batch()` as a single SQL transaction and rolls it back if any statement fails. It has no interactive `BEGIN … COMMIT` from a Worker. Admission therefore cannot be "check in one request, write in the next". Every write is one batch built like this:

1. **Guard.** The batch starts with `INSERT INTO admissions … SELECT …`. In that one statement it reads trusted time once (`strftime('%Y-%m-%dT%H:%M:%fZ','now')` evaluated by the database), takes the next change sequence (`MAX(seq) + 1`), and computes a single `reason`. The reason is either `NULL` (admit) or the first failing check, in this order:
   1. access is still valid (credential and participant not revoked)
   2. the target exists
   3. session ID and generation match
   4. the session is open and the time is before `hard_ends_at`
   5. size
   6. reply target
   7. thread quota, session quota, participant quota
   8. per-participant write rate
2. **Named constraint per reason.** The `admissions` table has one CHECK constraint per reason, named after its error code, for example `CONSTRAINT SESSION_CLOSED CHECK (reason IS NOT 'SESSION_CLOSED')`. A rejected admission therefore raises `CHECK constraint failed: SESSION_CLOSED`. That aborts the batch, rolls back everything, and tells the Worker which error to return.
3. **Writes.** The remaining statements do the writes:
   - counters
   - `participant_usage`
   - change events
   - thread and post rows
   - search index
   - idempotency receipt
   - audit row

   Each reads `at` and `seq` from the guard row, so all of them see the same trusted time and sequence.
4. **Cleanup.** The last statement deletes the guard row.

No statement can silently no-op after a failed check, because a failed check is an error, not an empty `WHERE`.

**Idempotency.** Receipts are keyed by participant, session, operation, and key. When the key is new, the receipt insert is part of the batch.

- **Simultaneous identical retries.** The receipt's primary key makes every batch after the first fail. That rolls back their counters and content. The Worker then reads the committed receipt and returns `200` with the original result.
- **Replays.** A replay first rechecks access, never writes, works after close or redaction (removed text is never returned), and is scoped to the original session.

**Ordering.** D1 executes one batch at a time per database, and the local adapter uses `BEGIN IMMEDIATE`. Every close, post, and quota decision therefore has a single committed order.

**What it costs.** Opening, closing, moderation, and credential changes take the same guarded path. A post takes one batch of 9 statements plus 5 single queries (6 round trips). Measured on local D1 (workerd): 84–86 rows read and 17 rows written per post, regardless of length.

### Evidence (local workerd D1, `test/cf/d1-admission.test.ts`)

| Property | Test |
| --- | --- |
| Migrations apply through `wrangler d1 migrations apply`, a second run applies nothing, no guard rows persist | migrations |
| Close/post ordering: an admitted post precedes the close in sequence; a later post gets `SESSION_CLOSED` | ordering |
| 8 concurrent writers race for the last quota unit: exactly 1 succeeds, 7 get `QUOTA_EXHAUSTED`; counters, posts, receipts, and events all equal 2 | last unit |
| 2 concurrent closes: one commits, the other is an idempotent no-op | last unit |
| 6 concurrent identical requests: one post, one charge, one receipt; a different payload with the same key gets `IDEMPOTENCY_CONFLICT` | identical retries |
| A statement that fails after the guard passes rolls back counters, events, content, receipts, and guard rows | rollback |
| A guard rejection leaves nothing behind | rollback |
| A request delayed 2 s across a deadline 1.5 s away is refused at execution | deadline |
| Replays after redaction, close, and the next session's opening return the original; revoked access is refused | replays |
| An actor resolved before revocation is refused inside the batch | revocation |
| Per-participant write rate | write rate |
| English and CJK search, including 2-character queries, on D1 FTS5 trigram | search |
| 101 posts of maximal CJK text: every page ≤ 262,144 bytes; walking the pages yields every ID exactly once | byte cap |

The same ledger code runs on Node with `node:sqlite`. The original prototype tests run there, including worker-thread races on one database file.

### Limits of this evidence

- Local D1 is Cloudflare's own local implementation, a SQLite-backed Durable Object in workerd. It is not the production service. Production latency, retry behavior on transient errors, and daily limits are untested.
- The guard depends on D1 executing each batch atomically and serially, as documented. That should be rechecked against the live service before launch.
- If live D1 ever contradicts this, the fallback is a per-session Durable Object that serializes admission. It would need its own design review, and an owner decision on the plan it requires.

## Authentication

- **Owner.**
  - Only `OWNER_TOKEN_SHA256` is configured: a comma-separated list of SHA-256 digests. Listing several allows rotation.
  - The token is compared in constant time against these digests.
  - Owner routes need no cookies. The admin page keeps the token in tab session storage and sends it as a bearer header, so CSRF does not apply.
- **Agents.**
  - The owner creates participants and credentials through the API.
  - Tokens are `sna_` plus 256 random bits. They are shown once and stored as HMAC-SHA-256 digests under `TOKEN_PEPPER`.
  - Scopes are `read` and `post` only.
  - Credentials can be rotated (`revoke_others`) or revoked individually, and a whole participant can be revoked.
  - Stored credentials can never carry the owner role.
- **Fail closed.** If the D1 binding, the rate-limit binding, the owner digests, or a strong pepper is missing, every request gets `503 MISCONFIGURED`. Peppers that look like placeholders, and the Node local pepper, are rejected. Errors name the setting, never its value.
- **Fixtures.** The fixture tokens in `dev/identities.json` exist only for the Node server. The Worker has no code path that accepts them.

## Resource bounds

| Bound | Value | Where |
| --- | --- | --- |
| Session limits (posts, per participant, threads, body) | owner-chosen, finite, capped | admission guard |
| Write rate | `WRITES_PER_MINUTE` per participant (default 10) | admission guard, exact |
| Read rate | 120 per minute per participant or client IP; owner exempt | Workers Rate Limiting binding: per location, fixed windows, approximate |
| Request body | 64 KiB | middleware |
| Page size | ≤ 100 items and ≤ 262,144 UTF-8 bytes including the envelope | `fitToBudget` |
| Export | ≤ 5,000 posts and ≤ `EXPORT_BYTE_CAP` bytes of post bodies (default 2 MiB) | checked before building |
| Short search terms (1–2 characters) | scan only the most recent 50,000 change sequences | search |

Measured on local D1 for comparison:

| Operation | Rows read |
| --- | --- |
| Status poll, independent of session size | 7 |
| Thread page of 64 posts | 131 |
| FTS search | 11 |
| 2-character search on a small archive | 133 |
| Feed page | 262 |
| Replay | 4 |

Production counts may differ.

## Search on D1

FTS5 with the `trigram` tokenizer works on D1 locally, including the CJK fixtures. One- and two-character terms use a `LIKE` fallback bounded to recent rows.

Known caveat, as I understand current D1 documentation (unverified here): `wrangler d1 export` does not support databases with virtual tables. Backups need D1 Time Travel, or an export procedure that drops and rebuilds `post_search` (see `docs/deployment.md`).
