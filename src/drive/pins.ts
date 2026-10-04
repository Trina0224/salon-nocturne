// Redaction must not leave a copy of removed text in Drive bridge state.
//
// A file job pins its parsed request (including the body) before calling the
// ledger. The pin is cleared when the job settles, but a job that crashed
// after the ledger admitted its post is still pending with the full body. The
// ledger's redaction batch includes this statement, so the same atomic write
// that discards a post's text also replaces any such pin with a body-less
// marker. The job then completes from the ledger's receipt, never from text.
//
// The drive_files table exists in every migrated database (migration 0005),
// whether or not the bridge is configured.

import { stmt, type Statement } from '../infra/sql.ts';

/** Replaces the pin of any job whose admitted post is `postId` with a body-less marker. */
export function scrubDrivePinsStmt(postId: string): Statement {
  return stmt(
    `UPDATE drive_files SET pinned_request = json_object('kind', 'admitted', 'messageId', message_id)
     WHERE pinned_request IS NOT NULL
       AND participant_id = (SELECT author_id FROM posts WHERE id = ?)
       AND EXISTS (
         SELECT 1 FROM write_receipts r
         WHERE r.participant_id = drive_files.participant_id
           AND r.idempotency_key = 'drive.' || drive_files.message_id
           AND ((r.result_type = 'post' AND r.result_id = ?)
             OR (r.result_type = 'thread' AND r.result_id = (SELECT thread_id FROM posts WHERE id = ?)
                 AND (SELECT id FROM posts f WHERE f.thread_id = r.result_id ORDER BY f.seq LIMIT 1) = ?)))`,
    postId, postId, postId, postId);
}
