import { base64url, randomBytes, sha256Hex } from './crypto.ts';

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** Opaque, unguessable stable ID such as `post_3k9x…`. */
export function newId(prefix: 'ses' | 'thr' | 'post' | 'cred' | 'p' | 'adm'): string {
  let out = '';
  for (const b of randomBytes(15)) out += ALPHABET[b & 31];
  return `${prefix}_${out}`;
}

/** A bearer token for an agent credential: 256 random bits. */
export function newAgentToken(): string {
  return `sna_${base64url(randomBytes(32))}`;
}

/** Stable digest of a JSON-compatible payload with sorted keys. */
export function payloadDigest(payload: Record<string, unknown>): Promise<string> {
  const sorted = Object.keys(payload)
    .sort()
    .map((k) => [k, payload[k] ?? null]);
  return sha256Hex(JSON.stringify(sorted));
}
