// A fake of Google's OAuth token endpoint and the Drive v3 REST surface the
// adapter uses, backed by the in-memory MockDrive. It lets the real
// DriveHttpClient (and the Worker) run end to end without any network.
// Synthetic credentials only. Faults injected into MockDrive become HTTP
// errors in Google's error shape; a write whose response is "lost" becomes a
// network failure after the file was created.
import { DriveError, GOOGLE_DOC } from '../src/drive/client.ts';
import type { MockDrive } from './drive-mock.ts';

export const SYNTHETIC_OAUTH = {
  clientId: 'synthetic-client-id.apps.local',
  clientSecret: 'synthetic-client-secret-0123456789',
  refreshTokens: { 'account-a': 'synthetic-refresh-token-account-a', 'account-b': 'synthetic-refresh-token-account-b' } as Record<string, string>,
};

export interface FakeCall { host: string; path: string; method: string; account?: string; authorization?: string; query: URLSearchParams }

export function googleError(status: number, reason: string, location?: string): Response {
  return new Response(JSON.stringify({ error: { code: status, message: 'synthetic', errors: [{ reason, ...(location ? { location } : {}) }] } }),
    { status, headers: { 'Content-Type': 'application/json' } });
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'Content-Type': 'application/json' } });

function unquote(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

export class FakeGoogle {
  readonly calls: FakeCall[] = [];
  private readonly tokens = new Map<string, string>(); // access token -> account
  private issued = 0;
  /** Token endpoint failures to serve next: an HTTP status with an OAuth error code. */
  tokenFailures: { status: number; error: string }[] = [];
  /** Drive responses to serve next for a path suffix (before reaching the mock). */
  overrides: { match: (c: FakeCall) => boolean; respond: () => Response | Promise<Response> }[] = [];
  /** If set, watch grants this lifetime (shorter than requested), as Drive may. */
  grantedWatchMs: number | null = null;
  now: () => number = () => Date.now();
  readonly mock: MockDrive;

  constructor(mock: MockDrive) {
    this.mock = mock;
  }

  /** Revokes every access token issued so far (the next request gets 401). */
  expireAccessTokens() {
    this.tokens.clear();
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const call: FakeCall = { host: url.host, path: url.pathname, method: init.method ?? 'GET', authorization: headers.get('authorization') ?? undefined, query: url.searchParams };
    if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
      this.calls.push(call);
      return this.token(String(init.body ?? ''));
    }
    if (url.origin !== 'https://www.googleapis.com') throw new Error(`unexpected host ${url.host}`);
    const bearer = (call.authorization ?? '').replace(/^Bearer /, '');
    call.account = this.tokens.get(bearer);
    this.calls.push(call);
    if (!call.account) return googleError(401, 'authError');
    for (let i = 0; i < this.overrides.length; i++) {
      if (this.overrides[i]!.match(call)) {
        const o = this.overrides.splice(i, 1)[0]!;
        return o.respond();
      }
    }
    try {
      return await this.drive(call, url, init);
    } catch (err) {
      if (err instanceof DriveError) {
        switch (err.kind) {
          case 'invalid_cursor': return googleError(400, 'invalid', 'pageToken');
          case 'auth': return googleError(403, 'insufficientPermissions');
          case 'not_found': return googleError(404, 'notFound', 'fileId');
          case 'rate_limited': return googleError(403, 'userRateLimitExceeded');
          case 'permanent': return googleError(403, 'insufficientFilePermissions');
          case 'timeout': throw new TypeError('network connection lost'); // the response never arrives
          default: return googleError(503, 'backendError');
        }
      }
      throw err;
    }
  };

  private token(body: string): Response {
    const p = new URLSearchParams(body);
    const fail = this.tokenFailures.shift();
    if (fail) return json({ error: fail.error }, fail.status);
    if (p.get('grant_type') !== 'refresh_token' || p.get('client_id') !== SYNTHETIC_OAUTH.clientId || p.get('client_secret') !== SYNTHETIC_OAUTH.clientSecret) {
      return json({ error: 'invalid_client' }, 401);
    }
    const account = Object.entries(SYNTHETIC_OAUTH.refreshTokens).find(([, t]) => t === p.get('refresh_token'))?.[0];
    if (!account) return json({ error: 'invalid_grant' }, 400);
    const token = `synthetic-access-${account}-${++this.issued}`;
    this.tokens.set(token, account);
    return json({ access_token: token, expires_in: 3600, token_type: 'Bearer' });
  }

  private async drive(call: FakeCall, url: URL, init: RequestInit): Promise<Response> {
    const c = this.mock.client(call.account!);
    const q = url.searchParams;
    const p = url.pathname;
    const meta = (f: { size?: number } & Record<string, unknown>) => ({ ...f, ...(f.size === undefined ? {} : { size: String(f.size) }) });
    if (p === '/drive/v3/changes/startPageToken') return json({ startPageToken: await c.getStartPageToken() });
    if (p === '/drive/v3/changes' && call.method === 'GET') {
      const r = await c.listChanges(q.get('pageToken')!, Number(q.get('pageSize')));
      return json({ ...r, changes: r.changes.map((ch) => ({ ...ch, file: ch.file ? meta(ch.file as never) : undefined })) });
    }
    if (p === '/drive/v3/changes/watch') {
      const b = JSON.parse(String(init.body));
      const requested = Number(b.expiration);
      const granted = this.grantedWatchMs === null ? requested : Math.min(requested, this.now() + this.grantedWatchMs);
      const r = await c.watchChanges(q.get('pageToken')!, { id: b.id, token: b.token, address: b.address, expiration: granted });
      return json({ kind: 'api#channel', id: b.id, resourceId: r.resourceId, expiration: String(granted) });
    }
    if (p === '/drive/v3/channels/stop') {
      const b = JSON.parse(String(init.body));
      await c.stopChannel(b.id, b.resourceId);
      return new Response(null, { status: 204 });
    }
    if (p === '/drive/v3/files' && call.method === 'GET') {
      const query = q.get('q') ?? '';
      const app = /^appProperties has \{ key='((?:\\.|[^'])*)' and value='((?:\\.|[^'])*)' \} and '((?:\\.|[^'])*)' in parents and trashed = false$/.exec(query);
      if (app) {
        const found = await c.findByAppProperty(unquote(app[3]!), unquote(app[1]!), unquote(app[2]!));
        return json({ files: found ? [{ id: found.id }] : [] });
      }
      const folder = /^'((?:\\.|[^'])*)' in parents and trashed = false$/.exec(query);
      if (folder) {
        const r = await c.listFolder(unquote(folder[1]!), q.get('pageToken') ?? undefined);
        return json({ ...r, files: r.files.filter((f) => !f.trashed).map((f) => meta(f as never)) });
      }
      return googleError(400, 'invalid', 'q');
    }
    const media = /^\/drive\/v3\/files\/([^/]+)$/.exec(p);
    if (media && q.get('alt') === 'media') {
      return new Response(await c.download(decodeURIComponent(media[1]!), Number.MAX_SAFE_INTEGER), { headers: { 'Content-Type': 'text/plain' } });
    }
    if (media) return json(meta((await c.getFile(decodeURIComponent(media[1]!))) as never));
    const exp = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(p);
    if (exp) {
      if (q.get('mimeType') !== 'text/plain') return googleError(400, 'badRequest');
      return new Response(await c.exportText(decodeURIComponent(exp[1]!), Number.MAX_SAFE_INTEGER), { headers: { 'Content-Type': 'text/plain' } });
    }
    if (p === '/upload/drive/v3/files' && q.get('uploadType') === 'multipart') {
      const ct = new Headers(init.headers).get('content-type') ?? '';
      const boundary = /boundary=(.+)$/.exec(ct)?.[1];
      if (!boundary) return googleError(400, 'badRequest');
      const parts = String(init.body).split(`--${boundary}`).slice(1, -1).map((part) => {
        const at = part.indexOf('\r\n\r\n');
        return { head: part.slice(0, at), body: part.slice(at + 4, -2) };
      });
      if (parts.length !== 2 || !/application\/json/.test(parts[0]!.head) || !/text\/plain/.test(parts[1]!.head)) return googleError(400, 'badRequest');
      const m = JSON.parse(parts[0]!.body);
      const r = await c.createTextFile(m.parents[0], m.name, parts[1]!.body, m.appProperties);
      return json({ id: r.id });
    }
    return googleError(404, 'notFound');
  }
}

export { GOOGLE_DOC };
