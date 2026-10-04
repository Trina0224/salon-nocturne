// Bounded body reads for the Drive adapter: a declared Content-Length over
// the cap is refused before reading, and a streamed body is read only up to
// the cap, then cancelled. Memory use per response is bounded either way.

import { DriveError } from './client.ts';

/** Reads the body as UTF-8 text, at most `maxBytes`; throws DriveError('too_large') past it. */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new DriveError('too_large');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DriveError('too_large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(all);
}
