// Web Crypto helpers that run unchanged on Node 22 and Cloudflare Workers.

const encoder = new TextEncoder();

export const utf8 = (text: string) => encoder.encode(text);
export const utf8Length = (text: string) => encoder.encode(text).length;

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', utf8(text)));
}

type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
const keyCache = new Map<string, Promise<HmacKey>>();

function hmacKey(secret: string): Promise<HmacKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, key);
  }
  return key;
}

export async function hmacHex(secret: string, text: string): Promise<string> {
  return hex(await crypto.subtle.sign('HMAC', await hmacKey(secret), utf8(text)));
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Constant-time comparison of two strings of equal length. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
