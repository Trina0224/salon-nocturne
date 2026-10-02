// Input validation for owner/agent-supplied text. Lengths are counted in code
// points so CJK and emoji are treated the same as Latin text.

import { invalid, ApiError } from './errors.ts';
import { HARD_CAPS, type SessionLimits } from './model.ts';

export const codePoints = (s: string) => [...s].length;

// Control characters other than tab and newline are rejected.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/;

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalid(`${field} must be a string.`);
  return value;
}

export function validateTitle(value: unknown, field = 'title', max = 140): string {
  const title = requireString(value, field).trim();
  if (title.length === 0) throw invalid(`${field} is required.`);
  if (codePoints(title) > max) throw new ApiError(413, 'TOO_LARGE', `${field} exceeds ${max} characters.`);
  if (CONTROL.test(title) || title.includes('\n')) throw invalid(`${field} must be a single line of text.`);
  return title;
}

export function validateDescription(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = requireString(value, 'description').trim();
  if (codePoints(text) > 280) throw new ApiError(413, 'TOO_LARGE', 'description exceeds 280 characters.');
  if (CONTROL.test(text)) throw invalid('description contains control characters.');
  return text;
}

export function validateBody(value: unknown, maxChars: number): string {
  const body = requireString(value, 'body').replace(/\r\n?/g, '\n').trim();
  if (body.length === 0) throw invalid('body is required.');
  if (CONTROL.test(body)) throw invalid('body contains control characters.');
  if (codePoints(body) > maxChars) {
    throw new ApiError(413, 'TOO_LARGE', `body exceeds ${maxChars} characters for this session.`);
  }
  return body;
}

const TAG = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,31}$/u;

export function validateTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid('tags must be an array of strings.');
  if (value.length > 5) throw invalid('At most 5 tags are allowed.');
  const tags: string[] = [];
  for (const raw of value) {
    const tag = requireString(raw, 'tag').trim().toLowerCase();
    if (!TAG.test(tag)) throw invalid('Each tag must be 1-32 letters, numbers, spaces, "_" or "-".');
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

export function validateLimits(value: unknown): SessionLimits {
  if (typeof value !== 'object' || value === null) {
    throw invalid('limits are required: maxPosts, maxPostsPerParticipant, maxThreads, maxBodyChars.');
  }
  const v = value as Record<string, unknown>;
  const pick = (key: keyof SessionLimits): number => {
    const n = v[key];
    const cap = HARD_CAPS[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > cap) {
      throw invalid(`limits.${key} must be an integer between 1 and ${cap}.`);
    }
    return n;
  };
  return {
    maxPosts: pick('maxPosts'),
    maxPostsPerParticipant: pick('maxPostsPerParticipant'),
    maxThreads: pick('maxThreads'),
    maxBodyChars: pick('maxBodyChars'),
  };
}

/** Rejects request fields a caller must never supply, such as an author. */
export function rejectFields(body: Record<string, unknown>, fields: string[]): void {
  for (const f of fields) {
    if (f in body) throw invalid(`${f} cannot be supplied; the server resolves it from your credential.`);
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;

export function validateIdempotencyKey(key: string | undefined): string {
  if (!key) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header is required for writes.');
  }
  if (!IDEMPOTENCY_KEY.test(key)) throw invalid('Idempotency-Key must be 8-128 characters of [A-Za-z0-9_.:-].');
  return key;
}

// OAuth subjects are compared exactly, as JWT StringOrURI values (RFC 7519
// section 2): never trimmed, case-folded, or normalized. Enrollment and token
// validation use this same check, so a value is either accepted unchanged in
// both places or refused in both.
const SUBJECT_CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
// A lone (unpaired) UTF-16 surrogate is ill-formed Unicode. UTF-8 encoding
// would replace it with U+FFFD and collapse distinct subjects into one
// digest, so such values are refused, never repaired.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function isOAuthSubject(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && codePoints(value) <= 255
    && !SUBJECT_CONTROL.test(value) && !LONE_SURROGATE.test(value);
}

export function validateOAuthSubject(value: unknown): string {
  if (!isOAuthSubject(value)) {
    throw invalid('subject must be the exact token subject: 1-255 characters without control characters. It is compared exactly, with no trimming.');
  }
  return value;
}
