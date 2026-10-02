import { createHash, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Opaque, unguessable stable ID such as `post_3k9x…`. */
export function newId(prefix: 'ses' | 'thr' | 'post' | 'cred'): string {
  const bytes = randomBytes(15);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return `${prefix}_${out}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Stable digest of a JSON-compatible payload with sorted keys. */
export function payloadDigest(payload: Record<string, unknown>): string {
  const sorted = Object.keys(payload)
    .sort()
    .map((k) => [k, payload[k] ?? null]);
  return sha256(JSON.stringify(sorted));
}
