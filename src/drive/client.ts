// The narrow Drive surface the bridge uses. Tests use an in-memory mock; a
// real implementation over the Drive REST API is not part of this change
// (it needs separately approved OAuth grants for each owner account). The
// method comments name the Drive API calls such an implementation would
// make; that mapping is from memory and unverified, because the official
// documentation could not be reached from this environment.

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  /** Bytes; absent for Google Docs. */
  size?: number;
  trashed: boolean;
  appProperties?: Record<string, string>;
  createdTime: string;
  modifiedTime: string;
}

export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: DriveFile;
}

export type DriveErrorKind = 'invalid_cursor' | 'auth' | 'not_found' | 'rate_limited' | 'transient' | 'timeout' | 'too_large' | 'permanent';

export class DriveError extends Error {
  readonly kind: DriveErrorKind;
  constructor(kind: DriveErrorKind, message: string = kind) {
    super(message);
    this.kind = kind;
  }
}

export const GOOGLE_DOC = 'application/vnd.google-apps.document';
export const PLAIN_TEXT = 'text/plain';

export interface DriveClient {
  /** changes.getStartPageToken */
  getStartPageToken(): Promise<string>;
  /** changes.list (with file fields); throws DriveError('invalid_cursor') for an unusable token. */
  listChanges(pageToken: string, pageSize: number): Promise<{ changes: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>;
  /** files.get (metadata) */
  getFile(fileId: string): Promise<DriveFile>;
  /** files.get?alt=media; throws DriveError('too_large') past maxBytes. */
  download(fileId: string, maxBytes: number): Promise<string>;
  /** files.export as text/plain; throws DriveError('too_large') past maxBytes. */
  exportText(fileId: string, maxBytes: number): Promise<string>;
  /** files.list in one folder (catch-up after an invalid cursor). */
  listFolder(folderId: string, pageToken?: string): Promise<{ files: DriveFile[]; nextPageToken?: string }>;
  /** files.create (multipart) of a text/plain file with appProperties. */
  createTextFile(folderId: string, name: string, content: string, appProperties: Record<string, string>): Promise<{ id: string }>;
  /** files.list with an appProperties query in one folder. */
  findByAppProperty(folderId: string, key: string, value: string): Promise<{ id: string } | null>;
  /** changes.watch */
  watchChanges(pageToken: string, channel: { id: string; token: string; address: string; expiration: number }): Promise<{ resourceId: string; expiration: number }>;
  /** channels.stop */
  stopChannel(channelId: string, resourceId: string): Promise<void>;
}
