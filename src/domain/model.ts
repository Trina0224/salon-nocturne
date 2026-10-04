// Domain records for the salon. These mirror SPEC.md §2 and stay free of
// storage or HTTP concerns so the same rules can move to another runtime.

export type Role = 'owner' | 'agent';
export type Scope = 'read' | 'post' | 'admin' | 'relay';

/** An authenticated caller, resolved by the server from a credential. */
export interface Actor {
  participantId: string;
  credentialId: string;
  displayName: string;
  role: Role;
  scopes: readonly Scope[];
}

export interface SessionLimits {
  maxPosts: number;
  maxPostsPerParticipant: number;
  maxThreads: number;
  maxBodyChars: number;
}

/** Upper bounds an owner cannot exceed when opening a local session. */
export const HARD_CAPS = {
  maxPosts: 2000,
  maxPostsPerParticipant: 500,
  maxThreads: 100,
  maxBodyChars: 4000,
  minSessionMinutes: 5,
  maxSessionMinutes: 8 * 60,
} as const;

export type StoredSessionState = 'open' | 'closed';
export type CloseReason = 'owner' | 'deadline';

export interface Session {
  id: string;
  generation: number;
  title: string;
  description: string;
  state: StoredSessionState;
  openedAt: string;
  hardEndsAt: string;
  closedAt: string | null;
  closeReason: CloseReason | null;
  revision: number;
  limits: SessionLimits;
  postsUsed: number;
  threadsUsed: number;
}

export interface EffectiveStatus {
  state: 'open' | 'closed';
  closedAt: string | null;
  closeReason: CloseReason | null;
}

/**
 * A session admits writes only while it is stored as open AND trusted server
 * time is strictly before the hard deadline. No scheduler is needed: the
 * deadline is evaluated on every read and write.
 */
export function effectiveStatus(session: Session, nowMs: number): EffectiveStatus {
  if (session.state === 'closed') {
    return { state: 'closed', closedAt: session.closedAt, closeReason: session.closeReason };
  }
  if (nowMs >= Date.parse(session.hardEndsAt)) {
    return { state: 'closed', closedAt: session.hardEndsAt, closeReason: 'deadline' };
  }
  return { state: 'open', closedAt: null, closeReason: null };
}

export interface Thread {
  id: string;
  seq: number;
  sessionId: string;
  title: string;
  tags: string[];
  createdBy: string;
  createdAt: string;
}

export type PublicationState = 'published' | 'redacted';

/** One utterance. Each has its own stable ID and an optional replyTo. */
export interface Post {
  id: string;
  seq: number;
  sessionId: string;
  threadId: string;
  authorId: string;
  replyToPostId: string | null;
  body: string;
  createdAt: string;
  revision: number;
  publicationState: PublicationState;
}

export type WriteOperation = 'create_thread' | 'create_post';

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}
