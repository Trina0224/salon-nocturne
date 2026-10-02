// Row loaders shared by the write ledger and read model.

import type { Db } from '../infra/db.ts';
import type { Post, Session, Thread } from '../domain/model.ts';

type Row = Record<string, unknown>;

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

export function loadSession(db: Db, id: string): Session | null {
  const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return r ? sessionFromRow(r) : null;
}

export function loadThread(db: Db, id: string): Thread | null {
  const r = db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
  return r ? threadFromRow(r) : null;
}

export function loadPost(db: Db, id: string): Post | null {
  const r = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  return r ? postFromRow(r) : null;
}

export function displayNames(db: Db, ids: Iterable<string>): Map<string, string> {
  const names = new Map<string, string>();
  const stmt = db.prepare('SELECT display_name FROM participants WHERE id = ?');
  for (const id of new Set(ids)) {
    const r = stmt.get(id);
    names.set(id, r ? String(r.display_name) : 'Unknown');
  }
  return names;
}
