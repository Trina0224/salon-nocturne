import type { Db } from '../infra/db.ts';
import { immediate } from '../infra/db.ts';
import { newId, sha256 } from '../infra/ids.ts';
import type { Actor, Role, Scope } from '../domain/model.ts';

export interface IdentityFixture {
  id: string;
  display_name: string;
  role: Role;
  token: string;
  scopes: Scope[];
}

/**
 * Seeds local fixture identities. Existing participants keep their current
 * status, so a revoked fixture stays revoked across restarts.
 */
export function seedIdentities(db: Db, fixtures: IdentityFixture[], nowIso: string): void {
  immediate(db, () => {
    for (const f of fixtures) {
      db.prepare(
        `INSERT OR IGNORE INTO participants (id, display_name, role, status, created_at)
         VALUES (?, ?, ?, 'active', ?)`,
      ).run(f.id, f.display_name, f.role, nowIso);
      const digest = sha256(f.token);
      const exists = db.prepare('SELECT 1 FROM credentials WHERE token_digest = ?').get(digest);
      if (!exists) {
        db.prepare(
          `INSERT INTO credentials (id, participant_id, token_digest, scopes, label, created_at)
           VALUES (?, ?, ?, ?, 'local fixture', ?)`,
        ).run(newId('cred'), f.id, digest, JSON.stringify(f.scopes), nowIso);
      }
    }
  });
}

export type Resolution = { kind: 'ok'; actor: Actor } | { kind: 'revoked' } | { kind: 'unknown' };

export function resolveToken(db: Db, token: string): Resolution {
  const r = db
    .prepare(
      `SELECT c.id AS credential_id, c.scopes, c.revoked_at, p.id, p.display_name, p.role, p.status
       FROM credentials c JOIN participants p ON p.id = c.participant_id
       WHERE c.token_digest = ?`,
    )
    .get(sha256(token));
  if (!r) return { kind: 'unknown' };
  if (r.revoked_at !== null || r.status !== 'active') return { kind: 'revoked' };
  return {
    kind: 'ok',
    actor: {
      participantId: String(r.id),
      credentialId: String(r.credential_id),
      displayName: String(r.display_name),
      role: r.role as Role,
      scopes: JSON.parse(String(r.scopes)) as Scope[],
    },
  };
}

/** Re-reads access state; used inside write transactions at final admission. */
export function isCredentialActive(db: Db, actor: Actor): boolean {
  const r = db
    .prepare(
      `SELECT c.revoked_at, p.status FROM credentials c JOIN participants p ON p.id = c.participant_id
       WHERE c.id = ? AND p.id = ?`,
    )
    .get(actor.credentialId, actor.participantId);
  return !!r && r.revoked_at === null && r.status === 'active';
}
