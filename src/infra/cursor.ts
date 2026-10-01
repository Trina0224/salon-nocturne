import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../domain/errors.ts';

/**
 * Opaque pagination cursor. `after` is a position in the committed change
 * sequence, `watermark` freezes the snapshot so pages neither skip nor
 * duplicate records while new posts arrive, and `scope` binds the cursor to
 * one listing or query.
 */
export interface CursorState {
  scope: string;
  after: number;
  watermark: number;
}

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export class CursorCodec {
  private readonly secret: string;

  constructor(secret: string) {
    this.secret = secret;
  }

  encode(state: CursorState, nowMs: number): string {
    const payload = Buffer.from(
      JSON.stringify({ k: state.scope, a: state.after, w: state.watermark, t: nowMs }),
    ).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  /** Returns null for an absent cursor (start from the beginning). */
  decode(raw: string | undefined, scope: string, nowMs: number): CursorState | null {
    if (raw === undefined || raw === '') return null;
    const bad = new ApiError(400, 'INVALID_CURSOR', 'The cursor is malformed or belongs to another listing. Restart without a cursor.');
    if (raw.length > 512) throw bad;
    const [payload, sig] = raw.split('.');
    if (!payload || !sig) throw bad;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw bad;
    let parsed: { k?: unknown; a?: unknown; w?: unknown; t?: unknown };
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw bad;
    }
    if (parsed.k !== scope || typeof parsed.a !== 'number' || typeof parsed.w !== 'number' || typeof parsed.t !== 'number') {
      throw bad;
    }
    if (nowMs - parsed.t > MAX_AGE_MS) {
      throw new ApiError(400, 'CURSOR_EXPIRED', 'The cursor has expired. Restart this listing without a cursor.');
    }
    return { scope, after: parsed.a, watermark: parsed.w };
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url').slice(0, 22);
  }
}
