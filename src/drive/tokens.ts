// Account-scoped OAuth access tokens for the Drive HTTP adapter.
//
// Each configured owner account has its own refresh token (a Worker secret).
// Access tokens are obtained with the OAuth refresh-token grant at a fixed
// Google endpoint, cached in memory per account until shortly before they
// expire, and never stored in D1, logged, or put in an error message.
// Nothing here creates a client, grant, or credential: it only uses ones the
// owner configured.

import { DriveError } from './client.ts';
import { readCapped } from './http-body.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface AccessTokenProvider {
  /** An access token for this account. `forceRefresh` skips the cache (after a 401). */
  token(accountId: string, opts?: { forceRefresh?: boolean }): Promise<string>;
}

/** Google's OAuth token endpoint. Fixed: credentials are never sent anywhere else. */
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
  /** Refresh token per configured account id. */
  refreshTokens: Record<string, string>;
}

const REFRESH_MARGIN_MS = 60_000;
const TOKEN_RESPONSE_CAP = 16 * 1024;

export class RefreshTokenProvider implements AccessTokenProvider {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<string>>();

  private readonly creds: OAuthClientCredentials;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(creds: OAuthClientCredentials, fetchFn: FetchLike, now: () => number = Date.now, timeoutMs = 10_000) {
    this.creds = creds;
    this.fetchFn = fetchFn;
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  async token(accountId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
    const cached = this.cache.get(accountId);
    if (!opts.forceRefresh && cached && cached.expiresAt - REFRESH_MARGIN_MS > this.now()) return cached.token;
    if (opts.forceRefresh) this.cache.delete(accountId);
    // One refresh per account at a time; concurrent callers share it.
    const running = this.inflight.get(accountId);
    if (running) return running;
    const p = this.refresh(accountId).finally(() => this.inflight.delete(accountId));
    this.inflight.set(accountId, p);
    return p;
  }

  private async refresh(accountId: string): Promise<string> {
    const refreshToken = this.creds.refreshTokens[accountId];
    // An account without a configured grant is an access problem, held like a revoked one.
    if (!refreshToken) throw new DriveError('auth', 'no_grant_for_account');
    const body = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.creds.clientId, client_secret: this.creds.clientSecret,
    });
    let res: Response;
    try {
      res = await this.fetchFn(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DriveError(isTimeout(err) ? 'timeout' : 'transient', 'token_endpoint_unreachable');
    }
    const text = await readCapped(res, TOKEN_RESPONSE_CAP).catch(() => null);
    let json: Record<string, unknown> | null = null;
    try {
      json = text === null ? null : JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    if (res.status >= 300 && res.status < 400) throw new DriveError('permanent', 'token_redirect_refused');
    if (!res.ok) {
      // invalid_grant: revoked or expired grant. invalid_client: the client itself is wrong. Both need the owner.
      const code = typeof json?.error === 'string' ? json.error : '';
      if (res.status === 400 || res.status === 401) throw new DriveError('auth', code === 'invalid_client' ? 'invalid_client' : 'invalid_grant');
      if (res.status === 429) throw new DriveError('rate_limited', 'token_rate_limited');
      throw new DriveError('transient', `token_http_${res.status >= 500 ? '5xx' : res.status}`);
    }
    const token = json?.access_token;
    const expiresIn = json?.expires_in;
    if (typeof token !== 'string' || token === '' || typeof expiresIn !== 'number' || !(expiresIn > 0)) {
      throw new DriveError('transient', 'token_malformed_response');
    }
    this.cache.set(accountId, { token, expiresAt: this.now() + expiresIn * 1000 });
    return token;
  }
}

export function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}
