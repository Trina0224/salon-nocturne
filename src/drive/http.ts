// DriveClient over the Drive v3 REST API, one instance per owner account.
//
// Protocol choices (sources: Google's Drive v3 guides and reference for
// changes, push notifications, downloads, search, uploads, and errors; the
// pages could not be fetched from the build environment, so behavior beyond
// what the review quoted from them is marked "assumed" below):
// - Fixed origins only (www.googleapis.com for metadata and uploads). The
//   access token is sent only there, and redirects are refused rather than
//   followed, so a credential can never reach another URL.
// - Every request has a timeout and every body read is capped; content reads
//   use the bridge's 32 KiB message cap, far below Drive's export ceiling.
// - Errors become DriveError kinds by status and reason, never by message
//   text, and carry only a short reason code (no bodies, tokens, or IDs).
//   401 refreshes the token once and retries; 403 is classified by reason
//   (rate limit, missing scope, file-level refusal), not treated as revoked.
// - A create whose outcome is unknown (timeout, network failure, 5xx, or an
//   unreadable success response) is reported as 'timeout' or 'transient', so
//   the bridge keeps its uncertainty marker and looks before writing again.

import { DriveError, type DriveChange, type DriveClient, type DriveErrorKind, type DriveFile } from './client.ts';
import { readCapped } from './http-body.ts';
import { isTimeout, type AccessTokenProvider, type FetchLike } from './tokens.ts';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

/** The file fields the bridge uses; nothing more is requested. */
const FILE_FIELDS = 'id,name,mimeType,parents,size,trashed,appProperties,createdTime,modifiedTime';
const JSON_CAP = 1024 * 1024;
/** A deduplication search must finish within this budget or remain uncertain. */
const APP_PROPERTY_SEARCH_PAGES = 5;

/** Rate-limit reasons on 403 (Drive also uses 429). */
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'sharingRateLimitExceeded', 'dailyLimitExceeded']);
/** 403 reasons about the account's grant as a whole: hold the account until the owner acts. */
const ACCOUNT_REASONS = new Set(['insufficientPermissions', 'authError', 'domainPolicy']);
/** 403 reasons about one file or folder only (assumed list): not a loss of the account's access. */
const FILE_REASONS = new Set(['insufficientFilePermissions', 'appNotAuthorizedToFile', 'cannotAddParent', 'teamDriveFileLimitExceeded']);

/** Escapes a literal for a Drive search query (backslash and single quote). */
export function queryLiteral(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export interface DriveHttpOptions {
  accountId: string;
  tokens: AccessTokenProvider;
  fetch: FetchLike;
  timeoutMs?: number;
}

export class DriveHttpClient implements DriveClient {
  private readonly accountId: string;
  private readonly tokens: AccessTokenProvider;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: DriveHttpOptions) {
    this.accountId = opts.accountId;
    this.tokens = opts.tokens;
    this.fetchFn = opts.fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  // ---- transport ------------------------------------------------------------------

  /**
   * One authorized request. Returns the response for 2xx; throws DriveError
   * otherwise. `ambiguous` marks a request that may have taken effect even if
   * no readable answer came back (a create).
   */
  private async send(url: string, init: { method: string; headers?: Record<string, string>; body?: string }, ambiguous = false): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.token(this.accountId, { forceRefresh: attempt > 0 });
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: init.method,
          headers: { ...init.headers, Authorization: `Bearer ${token}`, Accept: 'application/json' },
          body: init.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        throw new DriveError(isTimeout(err) ? 'timeout' : 'transient', ambiguous ? 'outcome_unknown' : 'network');
      }
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel().catch(() => undefined);
        continue; // refresh once, then retry
      }
      if (res.ok) return res;
      throw await this.errorFor(res, ambiguous);
    }
  }

  private async errorFor(res: Response, ambiguous: boolean): Promise<DriveError> {
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return new DriveError('permanent', 'redirect_refused');
    }
    let reasons: string[] = [];
    let locations: string[] = [];
    try {
      const j = JSON.parse(await readCapped(res, 64 * 1024)) as { error?: { errors?: { reason?: unknown; location?: unknown }[] } };
      const errs = Array.isArray(j?.error?.errors) ? j.error!.errors! : [];
      reasons = errs.map((e) => String(e?.reason ?? ''));
      locations = errs.map((e) => String(e?.location ?? ''));
    } catch {
      /* an unreadable error body is classified by status alone */
    }
    const kind = (k: DriveErrorKind, reason: string) => new DriveError(k, reason);
    const s = res.status;
    if (s === 400) {
      // Only a refused page token means the cursor is unusable; other 400s are request errors.
      if (locations.includes('pageToken')) return kind('invalid_cursor', 'page_token_rejected');
      return kind('permanent', 'bad_request');
    }
    if (s === 401) return kind('auth', 'unauthorized');
    if (s === 403) {
      if (reasons.some((r) => RATE_REASONS.has(r))) return kind('rate_limited', 'rate_limited');
      if (reasons.some((r) => FILE_REASONS.has(r))) return kind('permanent', 'file_forbidden');
      if (reasons.some((r) => ACCOUNT_REASONS.has(r))) return kind('auth', 'account_forbidden');
      return kind('permanent', 'forbidden');
    }
    if (s === 404) return kind('not_found', 'not_found');
    if (s === 429) return kind('rate_limited', 'rate_limited');
    if (s === 408 || s >= 500) return kind('transient', ambiguous ? 'outcome_unknown' : 'server_error');
    return kind('permanent', `http_${s}`);
  }

  private async json(res: Response, ambiguous = false): Promise<Record<string, unknown>> {
    try {
      const v = JSON.parse(await readCapped(res, JSON_CAP));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* fall through */
    }
    throw new DriveError('transient', ambiguous ? 'outcome_unknown' : 'malformed_response');
  }

  private url(base: string, path: string, query: Record<string, string | undefined>): string {
    const u = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  }

  // ---- DriveClient ----------------------------------------------------------------

  async getStartPageToken(): Promise<string> {
    const j = await this.json(await this.send(this.url(DRIVE_API, '/changes/startPageToken', { fields: 'startPageToken' }), { method: 'GET' }));
    if (typeof j.startPageToken !== 'string' || !j.startPageToken) throw new DriveError('transient', 'malformed_response');
    return j.startPageToken;
  }

  async listChanges(pageToken: string, pageSize: number): Promise<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }> {
    const j = await this.json(await this.send(this.url(DRIVE_API, '/changes', {
      pageToken, pageSize: String(pageSize), spaces: 'drive', includeRemoved: 'true',
      fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
    }), { method: 'GET' }));
    const next = optString(j.nextPageToken);
    const start = optString(j.newStartPageToken);
    // A page always ends with one of the two tokens; a page with neither cannot be checkpointed safely.
    if (!next && !start) throw new DriveError('transient', 'malformed_response');
    if (!Array.isArray(j.changes)) throw new DriveError('transient', 'malformed_response');
    const changes: DriveChange[] = j.changes.map((c: Record<string, unknown>) => {
      if (!c || typeof c.fileId !== 'string') throw new DriveError('transient', 'malformed_response');
      const removed = c.removed === true;
      return { fileId: c.fileId, removed, file: c.file && !removed ? toFile(c.file) : undefined };
    });
    return { changes, ...(next ? { nextPageToken: next } : {}), ...(start ? { newStartPageToken: start } : {}) };
  }

  async getFile(fileId: string): Promise<DriveFile> {
    return toFile(await this.json(await this.send(this.url(DRIVE_API, `/files/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS }), { method: 'GET' })));
  }

  async download(fileId: string, maxBytes: number): Promise<string> {
    return readCapped(await this.send(this.url(DRIVE_API, `/files/${encodeURIComponent(fileId)}`, { alt: 'media' }), { method: 'GET' }), maxBytes);
  }

  async exportText(fileId: string, maxBytes: number): Promise<string> {
    return readCapped(await this.send(this.url(DRIVE_API, `/files/${encodeURIComponent(fileId)}/export`, { mimeType: 'text/plain' }), { method: 'GET' }), maxBytes);
  }

  async listFolder(folderId: string, pageToken?: string): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
    const j = await this.json(await this.send(this.url(DRIVE_API, '/files', {
      q: `${queryLiteral(folderId)} in parents and trashed = false`, pageSize: '100', pageToken, spaces: 'drive',
      fields: `nextPageToken,files(${FILE_FIELDS})`,
    }), { method: 'GET' }));
    if (!Array.isArray(j.files)) throw new DriveError('transient', 'malformed_response');
    const next = optString(j.nextPageToken);
    return { files: j.files.map(toFile), ...(next ? { nextPageToken: next } : {}) };
  }

  async createTextFile(folderId: string, name: string, content: string, appProperties: Record<string, string>): Promise<{ id: string }> {
    const metadata = JSON.stringify({ name, mimeType: 'text/plain', parents: [folderId], appProperties });
    let boundary: string;
    do boundary = `salon_${crypto.randomUUID().replace(/-/g, '')}`; while (content.includes(boundary) || metadata.includes(boundary));
    const body = [
      `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', metadata,
      `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', content,
      `--${boundary}--`, '',
    ].join('\r\n');
    const res = await this.send(this.url(DRIVE_UPLOAD, '/files', { uploadType: 'multipart', fields: 'id' }), {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    }, true);
    const j = await this.json(res, true);
    if (typeof j.id !== 'string' || !j.id) throw new DriveError('transient', 'outcome_unknown');
    return { id: j.id };
  }

  async findByAppProperty(folderId: string, key: string, value: string): Promise<{ id: string } | null> {
    let pageToken: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < APP_PROPERTY_SEARCH_PAGES; page++) {
      const j = await this.json(await this.send(this.url(DRIVE_API, '/files', {
        q: `appProperties has { key=${queryLiteral(key)} and value=${queryLiteral(value)} } and ${queryLiteral(folderId)} in parents and trashed = false`,
        pageSize: '10', pageToken, spaces: 'drive', fields: 'nextPageToken,incompleteSearch,files(id)',
      }), { method: 'GET' }));
      if (!Array.isArray(j.files)
        || j.files.some((f) => !f || typeof f.id !== 'string' || !f.id)
        || (j.incompleteSearch !== undefined && typeof j.incompleteSearch !== 'boolean')
        || (j.nextPageToken !== undefined && (typeof j.nextPageToken !== 'string' || !j.nextPageToken))) {
        throw new DriveError('transient', 'malformed_response');
      }
      // A positive match suffices, but an incomplete/partial search never proves absence.
      if (j.files.length) return { id: j.files[0].id };
      if (j.incompleteSearch === true) throw new DriveError('transient', 'incomplete_search');
      if (j.nextPageToken === undefined) return null;
      pageToken = j.nextPageToken as string;
      if (seen.has(pageToken)) throw new DriveError('transient', 'incomplete_search');
      seen.add(pageToken);
    }
    throw new DriveError('transient', 'incomplete_search');
  }

  async watchChanges(pageToken: string, channel: { id: string; token: string; address: string; expiration: number }): Promise<{ resourceId: string; expiration: number }> {
    const j = await this.json(await this.send(this.url(DRIVE_API, '/changes/watch', { pageToken, spaces: 'drive', includeRemoved: 'true' }), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: channel.id, type: 'web_hook', address: channel.address, token: channel.token, expiration: String(channel.expiration) }),
    }));
    if (typeof j.resourceId !== 'string' || !j.resourceId) throw new DriveError('transient', 'malformed_response');
    // Use the expiration Drive actually granted (milliseconds, as a string); it may be earlier than requested.
    const granted = Number(j.expiration);
    return { resourceId: j.resourceId, expiration: Number.isFinite(granted) && granted > 0 ? Math.min(granted, channel.expiration) : channel.expiration };
  }

  async stopChannel(channelId: string, resourceId: string): Promise<void> {
    try {
      const res = await this.send(`${DRIVE_API}/channels/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: channelId, resourceId }),
      });
      await res.body?.cancel().catch(() => undefined);
    } catch (err) {
      // Already gone is the goal.
      if (!(err instanceof DriveError && err.kind === 'not_found')) throw err;
    }
  }
}

function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** Validates a file resource; anything unexpected is a malformed response, not data. */
function toFile(raw: unknown): DriveFile {
  const f = raw as Record<string, unknown>;
  if (!f || typeof f.id !== 'string' || typeof f.mimeType !== 'string' || typeof f.createdTime !== 'string') {
    throw new DriveError('transient', 'malformed_response');
  }
  const parents = Array.isArray(f.parents) ? f.parents.filter((p): p is string => typeof p === 'string') : [];
  const size = f.size === undefined ? undefined : Number(f.size);
  if (size !== undefined && !(Number.isInteger(size) && size >= 0)) throw new DriveError('transient', 'malformed_response');
  const props = f.appProperties && typeof f.appProperties === 'object'
    ? Object.fromEntries(Object.entries(f.appProperties as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
    : undefined;
  return {
    id: f.id, name: typeof f.name === 'string' ? f.name : '', mimeType: f.mimeType, parents, size,
    trashed: f.trashed === true, appProperties: props, createdTime: f.createdTime,
    modifiedTime: typeof f.modifiedTime === 'string' ? f.modifiedTime : f.createdTime,
  };
}
