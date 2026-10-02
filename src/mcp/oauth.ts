// OAuth 2.1 resource server for the MCP endpoint. Salon Nocturne never issues
// tokens or logs anyone in: an external authorization server does that (a
// synthetic one locally, a provider chosen by the owner in production). This
// module only advertises where to get a token (RFC 9728 protected resource
// metadata and WWW-Authenticate challenges) and validates tokens it receives:
// signature against the issuer's keys, exact issuer, audience bound to this
// resource (RFC 8707), expiry, and scopes. Which participant a valid token
// speaks for is decided afterwards by a server-side binding, never by the
// token's claims about names or roles.

import { createLocalJWKSet, createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { McpConfig } from '../config.ts';
import type { Scope } from '../domain/model.ts';
import { isOAuthSubject } from '../domain/content.ts';

/** OAuth scopes this resource understands, and the salon scope each grants. */
export const OAUTH_SCOPES = { 'salon:read': 'read', 'salon:post': 'post' } as const satisfies Record<string, Scope>;
export const SCOPES_SUPPORTED = Object.keys(OAUTH_SCOPES);
export const READ_SCOPES = ['salon:read'];
export const POST_SCOPES = ['salon:read', 'salon:post'];

/** Asymmetric algorithms only: a shared-secret (HS*) or unsigned token is refused. */
const ALGORITHMS = ['RS256', 'PS256', 'ES256', 'EdDSA'];
const MAX_TOKEN_CHARS = 8192;
const CLOCK_TOLERANCE_SECONDS = 30;

/** RFC 9728: the metadata URL inserts the well-known segment before the resource path. */
export function metadataUrl(cfg: McpConfig): string {
  const u = new URL(cfg.resource);
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`;
}

export function protectedResourceMetadata(cfg: McpConfig) {
  return {
    resource: cfg.resource,
    authorization_servers: cfg.authorizationServers,
    scopes_supported: SCOPES_SUPPORTED,
    bearer_methods_supported: ['header'],
    resource_name: 'Salon Nocturne',
  };
}

/** A `WWW-Authenticate: Bearer …` value pointing clients at the metadata. */
export function challenge(cfg: McpConfig, opts: { error?: 'invalid_token' | 'insufficient_scope'; description?: string; scopes?: string[] } = {}): string {
  const parts = [`resource_metadata="${metadataUrl(cfg)}"`];
  if (opts.error) parts.push(`error="${opts.error}"`);
  if (opts.description) parts.push(`error_description="${opts.description.replace(/["\\]/g, '')}"`);
  // Ask for every salon scope up front; the server-side binding still caps
  // what the connection can do, so requesting more never grants more.
  parts.push(`scope="${(opts.scopes ?? SCOPES_SUPPORTED).join(' ')}"`);
  return `Bearer ${parts.join(', ')}`;
}

export type Verified = { ok: true; issuer: string; subject: string; scopes: Scope[] } | { ok: false; description: string };

export class TokenVerifier {
  private readonly cfg: McpConfig;
  private readonly keys: JWTVerifyGetKey;

  constructor(cfg: McpConfig) {
    this.cfg = cfg;
    this.keys = 'url' in cfg.jwks
      ? createRemoteJWKSet(new URL(cfg.jwks.url), { timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 })
      : createLocalJWKSet(cfg.jwks.inline as Parameters<typeof createLocalJWKSet>[0]);
  }

  /** Never throws for a bad token; the description is safe to return to the client. */
  async verify(token: string): Promise<Verified> {
    if (token.length > MAX_TOKEN_CHARS) return { ok: false, description: 'The access token is too large.' };
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.cfg.issuer,
        audience: this.cfg.resource,
        algorithms: ALGORITHMS,
        requiredClaims: ['exp', 'sub'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      });
      // Same exact-match rule as enrollment: the subject is used unchanged.
      const subject = payload.sub;
      if (!isOAuthSubject(subject)) return { ok: false, description: 'The access token has no usable subject.' };
      return { ok: true, issuer: this.cfg.issuer, subject, scopes: grantedScopes(payload) };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) return { ok: false, description: 'The access token has expired.' };
      if (err instanceof joseErrors.JWTClaimValidationFailed) {
        if (err.claim === 'aud') return { ok: false, description: 'The access token was not issued for this resource.' };
        if (err.claim === 'iss') return { ok: false, description: 'The access token comes from an untrusted issuer.' };
      }
      // Bad signatures, unknown keys, disallowed algorithms, key-fetch
      // failures, and anything unexpected all fail closed the same way.
      return { ok: false, description: 'The access token is invalid.' };
    }
  }
}

/** Space-separated `scope` (RFC 8693/9068) or a `scp` array; unknown scopes are ignored. */
function grantedScopes(payload: Record<string, unknown>): Scope[] {
  const raw = typeof payload.scope === 'string' ? payload.scope.split(' ') : Array.isArray(payload.scp) ? payload.scp : [];
  const out = new Set<Scope>();
  for (const s of raw) {
    if (typeof s === 'string' && Object.hasOwn(OAUTH_SCOPES, s)) out.add(OAUTH_SCOPES[s as keyof typeof OAUTH_SCOPES]);
  }
  return [...out];
}
