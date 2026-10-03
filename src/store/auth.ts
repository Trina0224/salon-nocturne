// Authentication. The owner authenticates with a configured secret token
// (only its SHA-256 is configured; several hashes allow rotation). Agents use
// separately revocable credentials stored as HMAC digests with a secret
// pepper. Identity and scopes always come from the server, never the request.

import type { SqlDb } from '../infra/sql.ts';
import { hmacHex, sha256Hex, timingSafeEqual } from '../infra/crypto.ts';
import type { Actor, Role, Scope } from '../domain/model.ts';

export const OWNER_PARTICIPANT_ID = 'p_host';
export const OWNER_CREDENTIAL_ID = 'owner-secret';
/** Credential IDs of Drive bridge actors; stored credentials are always 'cred_…'. */
export const DRIVE_CREDENTIAL_PREFIX = 'drive:';
export const AGENT_SCOPES: Scope[] = ['read', 'post'];

export interface AuthConfig {
  /** Lowercase hex SHA-256 digests of accepted owner tokens. */
  ownerTokenHashes: string[];
  /** Secret used to digest agent tokens. */
  tokenPepper: string;
}

export type Resolution = { kind: 'ok'; actor: Actor } | { kind: 'revoked' } | { kind: 'unknown' };

/** An OAuth connection resolved through its server-side binding. */
export type OAuthResolution = { kind: 'ok'; actor: Actor; label: string } | { kind: 'revoked' } | { kind: 'unknown' };

/** Scopes a posting binding carries. Admin authority never travels over OAuth. */
export const OAUTH_BINDING_SCOPES: Scope[] = ['read', 'post'];
/**
 * Scopes a relay binding carries: it can propose administrative operations
 * and execute ones the owner approved for it, and nothing else. It cannot
 * read the feed, post, or approve.
 */
export const RELAY_BINDING_SCOPES: Scope[] = ['relay'];
const ANY_OAUTH_SCOPE: Scope[] = ['read', 'post', 'relay'];

export class Authenticator {
  private readonly db: SqlDb;
  private readonly config: AuthConfig;

  constructor(db: SqlDb, config: AuthConfig) {
    this.db = db;
    this.config = config;
  }

  credentialDigest(token: string): Promise<string> {
    return hmacHex(this.config.tokenPepper, `agent-token-v1:${token}`);
  }

  /**
   * Digest of a validated OAuth identity. Issuer and subject are external
   * account identifiers, so only this keyed digest is stored.
   */
  oauthIdentityDigest(issuer: string, subject: string): Promise<string> {
    return hmacHex(this.config.tokenPepper, `oauth-identity-v1:${issuer}\n${subject}`);
  }

  async resolve(token: string): Promise<Resolution> {
    const owner = await this.owner(token);
    return owner ? { kind: 'ok', actor: owner } : this.resolveAgent(token);
  }

  /** Cheap owner check: one SHA-256 and constant-time compares, no database. */
  async owner(token: string): Promise<Actor | null> {
    const tokenHash = await sha256Hex(token);
    if (!this.config.ownerTokenHashes.some((h) => timingSafeEqual(h, tokenHash))) return null;
    return {
      participantId: OWNER_PARTICIPANT_ID,
      credentialId: OWNER_CREDENTIAL_ID,
      displayName: 'Host',
      role: 'owner',
      scopes: ['read', 'post', 'admin'],
    };
  }

  /** Agent credential lookup: one database read. Callers rate-limit first. */
  async resolveAgent(token: string): Promise<Resolution> {
    const r = await this.db.first(
      `SELECT c.id AS credential_id, c.scopes, c.revoked_at, p.id, p.display_name, p.role, p.status
       FROM credentials c JOIN participants p ON p.id = c.participant_id
       WHERE c.token_digest = ? AND c.kind = 'token'`,
      await this.credentialDigest(token),
    );
    // Stored credentials are agent-only: an owner row in the table is ignored.
    if (!r || r.role !== 'agent') return { kind: 'unknown' };
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
}

/**
 * Resolves an OAuth identity whose token has already been validated (issuer,
 * audience, expiry, signature). The participant and role come only from the
 * server-side binding. Effective scopes are the binding's scopes intersected
 * with the scopes the token grants, so a token can narrow access but never
 * widen it, and never to admin.
 */
export async function resolveOAuthBinding(
  db: SqlDb, auth: Authenticator, issuer: string, subject: string, grantedScopes: readonly Scope[],
): Promise<OAuthResolution> {
  const r = await db.first(
    `SELECT c.id AS credential_id, c.scopes, c.label, c.revoked_at, p.id, p.display_name, p.role, p.status
     FROM credentials c JOIN participants p ON p.id = c.participant_id
     WHERE c.token_digest = ? AND c.kind = 'oauth'`,
    await auth.oauthIdentityDigest(issuer, subject),
  );
  if (!r) return { kind: 'unknown' };
  if (r.revoked_at !== null || r.status !== 'active') return { kind: 'revoked' };
  const stored = JSON.parse(String(r.scopes)) as Scope[];
  const scopes = ANY_OAUTH_SCOPE.filter((s) => stored.includes(s) && grantedScopes.includes(s));
  return {
    kind: 'ok',
    label: String(r.label),
    actor: {
      participantId: String(r.id),
      credentialId: String(r.credential_id),
      displayName: String(r.display_name),
      role: r.role as Role,
      scopes,
    },
  };
}

/**
 * SQL that is true while the actor's access is still valid, evaluated inside
 * the admission statement. The owner's secret was checked for this request.
 */
export function accessStillValidSql(actor: Actor): { sql: string; params: string[] } {
  if (actor.role === 'owner' && actor.credentialId === OWNER_CREDENTIAL_ID) return { sql: '1', params: [] };
  // Drive bridge actors hold no credential: access is the participant's
  // enabled outbox mapping plus an active agent participant.
  if (actor.credentialId.startsWith(DRIVE_CREDENTIAL_PREFIX)) {
    return {
      sql: `EXISTS (SELECT 1 FROM drive_participants d JOIN participants p ON p.id = d.participant_id
              WHERE d.participant_id = ? AND d.enabled = 1 AND p.status = 'active' AND p.role = 'agent')`,
      params: [actor.participantId],
    };
  }
  return {
    sql: `EXISTS (SELECT 1 FROM credentials c JOIN participants p ON p.id = c.participant_id
            WHERE c.id = ? AND p.id = ? AND c.revoked_at IS NULL AND p.status = 'active')`,
    params: [actor.credentialId, actor.participantId],
  };
}

export async function isAccessValid(db: SqlDb, actor: Actor): Promise<boolean> {
  const check = accessStillValidSql(actor);
  const r = await db.first(`SELECT ${check.sql} AS ok`, ...check.params);
  return Number(r?.ok) === 1;
}

export interface IdentityFixture {
  id: string;
  display_name: string;
  role: Role;
  token: string;
  scopes: Scope[];
}

/**
 * Local-only: seeds synthetic agent credentials from dev/identities.json.
 * Existing participants keep their status, so a revoked fixture stays revoked.
 * Never called by the Worker.
 */
export async function seedFixtures(db: SqlDb, auth: Authenticator, fixtures: IdentityFixture[], nowIso: string): Promise<void> {
  for (const f of fixtures) {
    if (f.role !== 'agent') continue;
    await db.run(
      `INSERT OR IGNORE INTO participants (id, display_name, role, status, created_at) VALUES (?, ?, 'agent', 'active', ?)`,
      f.id, f.display_name, nowIso,
    );
    const digest = await auth.credentialDigest(f.token);
    await db.run(
      `INSERT OR IGNORE INTO credentials (id, participant_id, token_digest, scopes, label, created_at)
       VALUES (?, ?, ?, ?, 'local fixture', ?)`,
      `cred_fixture_${f.id}`, f.id, digest, JSON.stringify(f.scopes), nowIso,
    );
  }
}
