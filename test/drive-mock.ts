// In-memory Drive for two synthetic owner accounts. Each account has its own
// change log (page tokens are positions in it). Files are visible to their
// owner account and to any account they are shared with. Faults can be
// injected per method and account. Synthetic data only.
import { DriveError, GOOGLE_DOC, PLAIN_TEXT, type DriveClient, type DriveErrorKind, type DriveFile } from '../src/drive/client.ts';

interface StoredFile {
  meta: DriveFile;
  content: string;
  owner: string;
  sharedWith: Set<string>;
}

type Fault = { method: string; account?: string; kind: DriveErrorKind | 'timeout_after_write'; times: number };

export class MockDrive {
  readonly files = new Map<string, StoredFile>();
  private readonly logs = new Map<string, string[]>();
  /** Tokens below this position are rejected as invalid, per account. */
  private readonly validFrom = new Map<string, number>();
  private faults: Fault[] = [];
  private seq = 0;
  readonly calls: { account: string; method: string; arg?: string }[] = [];
  readonly channels = new Map<string, { account: string; resourceId: string; token: string; address: string; stopped: boolean }>();
  now: () => number = () => Date.now();
  /** Files per listFolder page (tokens are offsets), so recovery really paginates. */
  folderPageSize = 100;
  private gates: { method: string; account?: string; reached: () => void; wait: Promise<DriveErrorKind | undefined> }[] = [];

  constructor(accounts: string[]) {
    for (const a of accounts) this.logs.set(a, []);
  }

  fail(method: string, kind: Fault['kind'], opts: { account?: string; times?: number } = {}) {
    this.faults.push({ method, account: opts.account, kind, times: opts.times ?? 1 });
  }

  /**
   * Holds the next call of `method` (for `account`, if given) until
   * release() is called. `reached` resolves once a call is waiting.
   * release(kind) makes the held call fail with that error instead.
   */
  block(method: string, opts: { account?: string } = {}): { reached: Promise<void>; release: (fail?: DriveErrorKind) => void } {
    let reached!: () => void;
    let release!: (fail?: DriveErrorKind) => void;
    const reachedP = new Promise<void>((r) => { reached = r; });
    const wait = new Promise<DriveErrorKind | undefined>((r) => { release = r; });
    this.gates.push({ method, account: opts.account, reached, wait });
    return { reached: reachedP, release };
  }

  private async gate(account: string, method: string): Promise<void> {
    const i = this.gates.findIndex((g) => g.method === method && (!g.account || g.account === account));
    if (i < 0) return;
    const [g] = this.gates.splice(i, 1);
    g!.reached();
    const fail = await g!.wait;
    if (fail) throw new DriveError(fail);
  }

  private maybeFail(account: string, method: string): Fault['kind'] | null {
    const f = this.faults.find((x) => x.method === method && (!x.account || x.account === account) && x.times > 0);
    if (!f) return null;
    f.times--;
    return f.kind;
  }

  private log(fileId: string) {
    const f = this.files.get(fileId)!;
    for (const a of [f.owner, ...f.sharedWith]) this.logs.get(a)?.push(fileId);
  }

  /** An agent (or the bridge) writes a new file. Returns the file ID. */
  addFile(account: string, folder: string, opts: { content: string; name?: string; mimeType?: string; createdTime?: string; appProperties?: Record<string, string>; sharedWith?: string[] }): string {
    const id = `file${++this.seq}`;
    const at = opts.createdTime ?? new Date(this.now()).toISOString();
    const mimeType = opts.mimeType ?? PLAIN_TEXT;
    this.files.set(id, {
      owner: account,
      sharedWith: new Set(opts.sharedWith ?? []),
      content: opts.content,
      meta: {
        id, name: opts.name ?? `${id}.txt`, mimeType, parents: [folder], trashed: false,
        size: mimeType === GOOGLE_DOC ? undefined : new TextEncoder().encode(opts.content).length,
        appProperties: opts.appProperties, createdTime: at, modifiedTime: at,
      },
    });
    this.log(id);
    return id;
  }

  edit(fileId: string, content: string) {
    const f = this.files.get(fileId)!;
    f.content = content;
    if (f.meta.size !== undefined) f.meta.size = new TextEncoder().encode(content).length;
    f.meta.modifiedTime = new Date(this.now()).toISOString();
    this.log(fileId);
  }

  trash(fileId: string) {
    this.files.get(fileId)!.meta.trashed = true;
    this.log(fileId);
  }

  /** Make every token issued so far invalid for an account (as if it expired). */
  invalidateTokens(account: string) {
    this.validFrom.set(account, this.logs.get(account)!.length);
  }

  filesIn(folder: string): StoredFile[] {
    return [...this.files.values()].filter((f) => f.meta.parents.includes(folder) && !f.meta.trashed);
  }

  private visible(account: string, fileId: string): StoredFile {
    const f = this.files.get(fileId);
    if (!f || (f.owner !== account && !f.sharedWith.has(account))) throw new DriveError('not_found');
    return f;
  }

  client(account: string): DriveClient {
    const call = (method: string, arg?: string) => {
      this.calls.push({ account, method, arg });
      const kind = this.maybeFail(account, method);
      if (kind && kind !== 'timeout_after_write') throw new DriveError(kind);
      return kind;
    };
    const capped = (text: string, max: number) => {
      if (new TextEncoder().encode(text).length > max) throw new DriveError('too_large');
      return text;
    };
    return {
      getStartPageToken: async () => {
        call('getStartPageToken');
        return String(this.logs.get(account)!.length);
      },
      listChanges: async (pageToken, pageSize) => {
        call('listChanges', pageToken);
        const pos = Number(pageToken);
        if (!Number.isInteger(pos) || pos < (this.validFrom.get(account) ?? 0) || pos > this.logs.get(account)!.length) {
          throw new DriveError('invalid_cursor');
        }
        const log = this.logs.get(account)!;
        const slice = log.slice(pos, pos + pageSize);
        const changes = slice.map((fileId) => ({ fileId, removed: false, file: structuredClone(this.files.get(fileId)!.meta) }));
        const end = pos + slice.length;
        return end < log.length ? { changes, nextPageToken: String(end) } : { changes, newStartPageToken: String(end) };
      },
      getFile: async (fileId) => {
        call('getFile', fileId);
        return structuredClone(this.visible(account, fileId).meta);
      },
      download: async (fileId, max) => {
        call('download', fileId);
        const f = this.visible(account, fileId);
        if (f.meta.mimeType === GOOGLE_DOC) throw new DriveError('permanent');
        return capped(f.content, max);
      },
      exportText: async (fileId, max) => {
        call('exportText', fileId);
        const f = this.visible(account, fileId);
        if (f.meta.mimeType !== GOOGLE_DOC) throw new DriveError('permanent');
        // Docs exports start with a byte-order mark.
        return capped(`﻿${f.content}`, max);
      },
      listFolder: async (folderId, pageToken) => {
        call('listFolder', folderId);
        const all = [...this.files.values()].filter((f) => f.meta.parents.includes(folderId) && (f.owner === account || f.sharedWith.has(account)));
        const from = pageToken ? Number(pageToken) : 0;
        const end = from + this.folderPageSize;
        return { files: all.slice(from, end).map((f) => structuredClone(f.meta)), ...(end < all.length ? { nextPageToken: String(end) } : {}) };
      },
      createTextFile: async (folderId, name, content, appProperties) => {
        const kind = call('createTextFile', folderId);
        await this.gate(account, 'createTextFile');
        const id = this.addFile(account, folderId, { content, name, appProperties });
        if (kind === 'timeout_after_write') throw new DriveError('timeout');
        return { id };
      },
      findByAppProperty: async (folderId, key, value) => {
        call('findByAppProperty', folderId);
        await this.gate(account, 'findByAppProperty');
        const f = [...this.files.values()].find((x) => x.meta.parents.includes(folderId) && x.meta.appProperties?.[key] === value);
        return f ? { id: f.meta.id } : null;
      },
      watchChanges: async (_pageToken, ch) => {
        call('watchChanges');
        const resourceId = `res_${ch.id}`;
        this.channels.set(ch.id, { account, resourceId, token: ch.token, address: ch.address, stopped: false });
        return { resourceId, expiration: ch.expiration };
      },
      stopChannel: async (id) => {
        call('stopChannel', id);
        const c = this.channels.get(id);
        if (c) c.stopped = true;
      },
    };
  }
}
