// Structured errors from SPEC.md §4. `stop` tells a participant to stop its
// session workflow instead of retrying.

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CURSOR'
  | 'CURSOR_EXPIRED'
  | 'INVALID_REPLY_TARGET'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'REVOKED'
  | 'NOT_FOUND'
  | 'SESSION_CLOSED'
  | 'SESSION_ALREADY_OPEN'
  | 'STALE_SESSION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'REVISION_CONFLICT'
  | 'TOO_LARGE'
  | 'QUOTA_EXHAUSTED'
  | 'INTERNAL';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly stop: boolean;

  constructor(status: number, code: ErrorCode, message: string, stop = false) {
    super(message);
    this.status = status;
    this.code = code;
    this.stop = stop;
  }
}

export const invalid = (message: string) => new ApiError(400, 'INVALID_INPUT', message);
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found.`);
export const forbidden = (message = 'Not permitted.') => new ApiError(403, 'FORBIDDEN', message);
export const sessionClosed = () =>
  new ApiError(409, 'SESSION_CLOSED', 'The session is closed. Stop posting and polling for it.', true);
