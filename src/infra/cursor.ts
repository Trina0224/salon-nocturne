import { ApiError } from '../domain/errors.ts';
import { base64url, fromBase64url, hmacHex, timingSafeEqual, utf8 } from './crypto.ts';

/**
 * Opaque pagination cursor. `after` is a position in the committed change
 * sequence, `watermark` freezes the snapshot so pages neither skip nor
 * duplicate records while new posts arrive (negative means "fresh snapshot"),
 * and `scope` binds the cursor to one listing or query.
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

  async encode(state: CursorState, nowMs: number): Promise<string> {
    const payload = base64url(utf8(JSON.stringify({ k: state.scope, a: state.after, w: state.watermark, t: nowMs })));
    return `${payload}.${await this.sign(payload)}`;
  }

  /** Returns null for an absent cursor (start from the beginning). */
  async decode(raw: string | undefined, scope: string, nowMs: number): Promise<CursorState | null> {
    if (raw === undefined || raw === '') return null;
    const bad = new ApiError(400, 'INVALID_CURSOR', 'The cursor is malformed or belongs to another listing. Restart without a cursor.');
    if (raw.length > 512) throw bad;
    const [payload, sig] = raw.split('.');
    if (!payload || !sig || !timingSafeEqual(await this.sign(payload), sig)) throw bad;
    let parsed: { k?: unknown; a?: unknown; w?: unknown; t?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
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

  private async sign(payload: string): Promise<string> {
    return (await hmacHex(this.secret, `cursor-v1:${payload}`)).slice(0, 32);
  }
}
