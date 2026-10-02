// Row loaders shared by the write ledger and read model.

import type { Row, SqlDb } from '../infra/sql.ts';
import type { Post, Session, Thread } from '../domain/model.ts';

const str = (v: unknown) => v as string;
const num = (v: unknown) => Number(v);
const strOrNull = (v: unknown) => (v === null || v === undefined ? null : String(v));

export function sessionFromRow(r: Row): Session {
  return {
    id: str(r.id),
    generation: num(r.generation),
    title: str(r.title),
    description: str(r.description),
    state: r.state as Session['state'],
    openedAt: str(r.opened_at),
    hardEndsAt: str(r.hard_ends_at),
    closedAt: strOrNull(r.closed_at),
    closeReason: strOrNull(r.close_reason) as Session['closeReason'],
    revision: num(r.revision),
    limits: {
      maxPosts: num(r.max_posts),
      maxPostsPerParticipant: num(r.max_posts_per_participant),
      maxThreads: num(r.max_threads),
      maxBodyChars: num(r.max_body_chars),
    },
    postsUsed: num(r.posts_used),
    threadsUsed: num(r.threads_used),
  };
}

export function threadFromRow(r: Row): Thread {
  return {
    id: str(r.id),
    seq: num(r.seq),
    sessionId: str(r.session_id),
    title: str(r.title),
    tags: JSON.parse(str(r.tags)) as string[],
    createdBy: str(r.created_by),
    createdAt: str(r.created_at),
  };
}

export function postFromRow(r: Row): Post {
  return {
    id: str(r.id),
    seq: num(r.seq),
    sessionId: str(r.session_id),
    threadId: str(r.thread_id),
    authorId: str(r.author_id),
    replyToPostId: strOrNull(r.reply_to_post_id),
    body: str(r.body),
    createdAt: str(r.created_at),
    revision: num(r.revision),
    publicationState: r.publication_state as Post['publicationState'],
  };
}

export async function loadSession(db: SqlDb, id: string): Promise<Session | null> {
  const r = await db.first('SELECT * FROM sessions WHERE id = ?', id);
  return r ? sessionFromRow(r) : null;
}

export async function loadThread(db: SqlDb, id: string): Promise<Thread | null> {
  const r = await db.first('SELECT * FROM threads WHERE id = ?', id);
  return r ? threadFromRow(r) : null;
}

export async function loadPost(db: SqlDb, id: string): Promise<Post | null> {
  const r = await db.first('SELECT * FROM posts WHERE id = ?', id);
  return r ? postFromRow(r) : null;
}

/** Display names for participant IDs, in chunks below D1's bound-parameter limit. */
export async function displayNames(db: SqlDb, ids: Iterable<string>): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const names = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 90) {
    const chunk = unique.slice(i, i + 90);
    const rows = await db.all(
      `SELECT id, display_name FROM participants WHERE id IN (${chunk.map(() => '?').join(', ')})`,
      ...chunk,
    );
    for (const r of rows) names.set(String(r.id), String(r.display_name));
  }
  for (const id of unique) if (!names.has(id)) names.set(id, 'Unknown');
  return names;
}
