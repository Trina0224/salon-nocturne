// Versioned public representations. Allowlisted fields only: no credentials,
// audit data, or redacted text ever leave through these.

import { effectiveStatus, type Post, type Scope, type Session, type Thread } from '../domain/model.ts';
import type { Row } from '../infra/sql.ts';

export const SCHEMA_VERSION = 1;

export interface SessionView {
  id: string;
  generation: number;
  title: string;
  description: string;
  state: 'open' | 'closed';
  close_reason: 'owner' | 'deadline' | null;
  opened_at: string;
  hard_ends_at: string;
  closed_at: string | null;
  revision: number;
  limits: {
    max_posts: number;
    max_posts_per_participant: number;
    max_threads: number;
    max_body_chars: number;
  };
  usage: { posts_used: number; threads_used: number };
}

export function sessionView(s: Session, nowMs: number): SessionView {
  const status = effectiveStatus(s, nowMs);
  return {
    id: s.id,
    generation: s.generation,
    title: s.title,
    description: s.description,
    state: status.state,
    close_reason: status.closeReason,
    opened_at: s.openedAt,
    hard_ends_at: s.hardEndsAt,
    closed_at: status.closedAt,
    revision: s.revision,
    limits: {
      max_posts: s.limits.maxPosts,
      max_posts_per_participant: s.limits.maxPostsPerParticipant,
      max_threads: s.limits.maxThreads,
      max_body_chars: s.limits.maxBodyChars,
    },
    usage: { posts_used: s.postsUsed, threads_used: s.threadsUsed },
  };
}

export interface ThreadView {
  id: string;
  session_id: string;
  title: string;
  tags: string[];
  created_by: string;
  created_at: string;
}

export function threadView(t: Thread): ThreadView {
  return {
    id: t.id,
    session_id: t.sessionId,
    title: t.title,
    tags: t.tags,
    created_by: t.createdBy,
    created_at: t.createdAt,
  };
}

export interface PostView {
  id: string;
  session_id: string;
  thread_id: string;
  author: { id: string; display_name: string };
  reply_to_post_id: string | null;
  created_at: string;
  revision: number;
  state: 'published' | 'redacted';
  body: string | null;
}

export function postView(p: Post, authorName: string): PostView {
  const published = p.publicationState === 'published';
  return {
    id: p.id,
    session_id: p.sessionId,
    thread_id: p.threadId,
    author: { id: p.authorId, display_name: authorName },
    reply_to_post_id: p.replyToPostId,
    created_at: p.createdAt,
    revision: p.revision,
    state: p.publicationState,
    body: published ? p.body : null,
  };
}

export interface OAuthBindingView {
  id: string;
  participant: { id: string; display_name: string; role: string };
  label: string;
  scopes: Scope[];
  created_at: string;
  revoked_at: string | null;
}

/** Public shape of a binding: never the digest, issuer, or subject. */
export function oauthBindingView(r: Row): OAuthBindingView {
  return {
    id: String(r.id),
    participant: { id: String(r.participant_id), display_name: String(r.display_name), role: String(r.role) },
    label: String(r.label),
    scopes: JSON.parse(String(r.scopes)) as Scope[],
    created_at: String(r.created_at),
    revoked_at: r.revoked_at === null || r.revoked_at === undefined ? null : String(r.revoked_at),
  };
}
