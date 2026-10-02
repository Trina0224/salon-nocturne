// SYNTHETIC LOCAL OAUTH ISSUER. Node and tests only; the Worker never imports
// this file. It exists so the MCP resource server can be exercised end to end
// (discovery, dynamic client registration, authorization code + PKCE S256,
// resource-bound audience, JWKS) without any real identity provider.
//
// It is not a login system: the "accounts" are fixed synthetic subjects
// chosen on a consent page with no password. Production uses an authorization
// server the owner chooses and configures separately (docs/mcp.md).

import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { randomBytes, createHash } from 'node:crypto';
import { SCOPES_SUPPORTED } from '../mcp/oauth.ts';
import type { PublicJwks } from '../config.ts';

export interface DevAccount {
  /** Synthetic subject, e.g. "synthetic-rei". Never a real account ID. */
  subject: string;
  /** Shown on the consent page only. */
  label: string;
}

export interface DevIssuer {
  issuer: string;
  app: Hono;
  /** Public keys to configure as OAUTH_JWKS. */
  jwks: PublicJwks;
  /** Test helper: sign arbitrary claims with this issuer's key. */
  mint(claims: Record<string, unknown>, opts?: { expiresInSeconds?: number; key?: CryptoKey; kid?: string }): Promise<string>;
}

interface Client {
  redirectUris: string[];
  name: string;
}

interface Grant {
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  scope: string;
  subject: string;
  expiresAt: number;
}

const b64url = (buf: Buffer) => buf.toString('base64url');
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

export async function createDevIssuer(opts: { issuer: string; accounts: DevAccount[]; tokenTtlSeconds?: number }): Promise<DevIssuer> {
  const issuer = opts.issuer.replace(/\/$/, '');
  const ttl = opts.tokenTtlSeconds ?? 600;
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const kid = `dev-${b64url(randomBytes(6))}`;
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const jwks: PublicJwks = { keys: [jwk as Record<string, unknown>] };
  const clients = new Map<string, Client>();
  const grants = new Map<string, Grant>();

  async function mint(claims: Record<string, unknown>, o: { expiresInSeconds?: number; key?: CryptoKey; kid?: string } = {}) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'ES256', kid: o.kid ?? kid, typ: 'at+jwt' })
      .setIssuedAt(now)
      .setExpirationTime(now + (o.expiresInSeconds ?? ttl))
      .setJti(b64url(randomBytes(12)))
      .sign(o.key ?? privateKey);
  }

  const app = new Hono();
  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: SCOPES_SUPPORTED,
  };
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(metadata));
  app.get('/.well-known/openid-configuration', (c) => c.json(metadata));
  app.get('/jwks', (c) => c.json(jwks));

  // RFC 7591 dynamic registration: public clients only, exact redirect URIs.
  app.post('/register', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null;
    const uris = body?.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string')) {
      return c.json({ error: 'invalid_redirect_uri' }, 400);
    }
    const clientId = `dev-client-${b64url(randomBytes(9))}`;
    clients.set(clientId, { redirectUris: uris as string[], name: typeof body?.client_name === 'string' ? body.client_name : 'MCP client' });
    return c.json({
      client_id: clientId, redirect_uris: uris, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], response_types: ['code'],
    }, 201);
  });

  /** Checks an authorization request; returns an error string or the parsed request. */
  function authorizationRequest(q: Record<string, string | undefined>) {
    const client = clients.get(q.client_id ?? '');
    if (!client) return { error: 'unknown client_id' } as const;
    if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) return { error: 'redirect_uri is not registered' } as const;
    if (q.response_type !== 'code') return { error: 'response_type must be code' } as const;
    if (!q.code_challenge || q.code_challenge_method !== 'S256') return { error: 'PKCE with S256 is required' } as const;
    if (!q.resource) return { error: 'the resource parameter is required' } as const;
    const requested = (q.scope ?? '').split(' ').filter(Boolean);
    const scope = (requested.length ? requested.filter((s) => SCOPES_SUPPORTED.includes(s)) : SCOPES_SUPPORTED).join(' ');
    return { client, scope, q } as const;
  }

  // Consent page: synthetic accounts only, no password.
  app.get('/authorize', (c) => {
    const r = authorizationRequest(c.req.query());
    if ('error' in r) return c.text(`Synthetic issuer: ${r.error}`, 400);
    const hidden = Object.entries(r.q).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v ?? '')}">`).join('');
    const buttons = opts.accounts.map((a) => `<button name="account" value="${esc(a.subject)}">${esc(a.label)}</button>`).join(' ');
    return c.html(`<!doctype html><meta charset="utf-8"><title>Synthetic local issuer</title>
<h1>Synthetic local issuer (not a real login)</h1>
<p>${esc(r.client.name)} asks to use <code>${esc(r.q.resource ?? '')}</code> with scopes <code>${esc(r.scope)}</code>.</p>
<p>Pick a synthetic account. Which salon participant it posts as, and with what role, is decided by the salon host's binding, not here.</p>
<form method="post" action="/authorize">${hidden}${buttons}</form>`);
  });

  app.post('/authorize', async (c) => {
    const form = Object.fromEntries((await c.req.formData()).entries()) as Record<string, string>;
    const r = authorizationRequest(form);
    if ('error' in r) return c.text(`Synthetic issuer: ${r.error}`, 400);
    const account = opts.accounts.find((a) => a.subject === form.account);
    if (!account) return c.text('Synthetic issuer: unknown account', 400);
    const code = b64url(randomBytes(24));
    grants.set(code, {
      clientId: form.client_id!, redirectUri: form.redirect_uri!, challenge: form.code_challenge!,
      resource: form.resource!, scope: r.scope, subject: account.subject, expiresAt: Date.now() + 60_000,
    });
    const to = new URL(form.redirect_uri!);
    to.searchParams.set('code', code);
    if (form.state) to.searchParams.set('state', form.state);
    return c.redirect(to.href, 302);
  });

  // Authorization code + PKCE; the access token's audience is the requested resource.
  app.post('/token', async (c) => {
    const f = Object.fromEntries((await c.req.formData()).entries()) as Record<string, string>;
    if (f.grant_type !== 'authorization_code') return c.json({ error: 'unsupported_grant_type' }, 400);
    const g = grants.get(f.code ?? '');
    grants.delete(f.code ?? ''); // single use
    if (!g || g.expiresAt < Date.now()) return c.json({ error: 'invalid_grant' }, 400);
    if (f.client_id !== g.clientId || f.redirect_uri !== g.redirectUri) return c.json({ error: 'invalid_grant' }, 400);
    const verifier = f.code_verifier ?? '';
    if (createHash('sha256').update(verifier).digest('base64url') !== g.challenge) return c.json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
    if (f.resource !== undefined && f.resource !== g.resource) return c.json({ error: 'invalid_target' }, 400);
    const token = await mint({ iss: issuer, sub: g.subject, aud: g.resource, scope: g.scope, client_id: g.clientId });
    return c.json({ access_token: token, token_type: 'Bearer', expires_in: ttl, scope: g.scope });
  });

  return { issuer, app, jwks, mint };
}
