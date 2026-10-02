// Runtime configuration. The Worker always runs with production rules and
// fails closed: if secrets or bindings are missing or insecure, every request
// gets 503 and nothing is served. Fixture identities exist only in the Node
// local server and are never accepted by the Worker.

export interface AppConfig {
  /** Lowercase hex SHA-256 digests of accepted owner tokens (rotation: list several). */
  ownerTokenHashes: string[];
  /** Secret pepper for agent credential digests. */
  tokenPepper: string;
  /** Posts one participant may write per minute (enforced at admission). */
  writesPerMinute: number;
  /** Largest export, in UTF-8 bytes of post bodies. */
  exportByteCap: number;
  /** Serve only the owner (restores and incidents). */
  maintenance: boolean;
}

export const DEFAULTS = {
  writesPerMinute: 10,
  exportByteCap: 2 * 1024 * 1024,
} as const;

/** Public, non-secret pepper used only by the Node local prototype. */
export const LOCAL_PEPPER = 'salon-nocturne-local-prototype-pepper-not-a-secret';

const HASH = /^[0-9a-f]{64}$/;
const PLACEHOLDER = /placeholder|example|changeme|replace|local-prototype|test/i;

export interface WorkerEnv {
  DB?: unknown;
  REQUEST_LIMITER?: unknown;
  PARTICIPANT_LIMITER?: unknown;
  SALON_MAINTENANCE?: string;
  OWNER_TOKEN_SHA256?: string;
  TOKEN_PEPPER?: string;
  WRITES_PER_MINUTE?: string;
  EXPORT_BYTE_CAP?: string;
}

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; problems: string[] };

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number, name: string, problems: string[]): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer from ${min} to ${max}.`);
    return fallback;
  }
  return n;
}

/** Validates Worker bindings and secrets. Problems never include secret values. */
export function workerConfig(env: WorkerEnv): ConfigResult {
  const problems: string[] = [];
  if (!env.DB) problems.push('The DB (D1) binding is missing.');
  for (const name of ['REQUEST_LIMITER', 'PARTICIPANT_LIMITER'] as const) {
    const limiter = env[name] as { limit?: unknown } | undefined;
    if (!limiter || typeof limiter.limit !== 'function') problems.push(`The ${name} rate-limit binding is missing.`);
  }

  const hashes = (env.OWNER_TOKEN_SHA256 ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (hashes.length === 0) problems.push('The OWNER_TOKEN_SHA256 secret is not set.');
  else if (!hashes.every((h) => HASH.test(h))) problems.push('OWNER_TOKEN_SHA256 must be comma-separated 64-character hex SHA-256 digests.');

  const pepper = env.TOKEN_PEPPER ?? '';
  if (pepper.length < 32) problems.push('The TOKEN_PEPPER secret is missing or shorter than 32 characters.');
  else if (pepper === LOCAL_PEPPER || PLACEHOLDER.test(pepper)) problems.push('TOKEN_PEPPER looks like a placeholder or the local pepper.');

  const writesPerMinute = boundedInt(env.WRITES_PER_MINUTE, DEFAULTS.writesPerMinute, 1, 120, 'WRITES_PER_MINUTE', problems);
  const exportByteCap = boundedInt(env.EXPORT_BYTE_CAP, DEFAULTS.exportByteCap, 64 * 1024, 8 * 1024 * 1024, 'EXPORT_BYTE_CAP', problems);

  const mode = (env.SALON_MAINTENANCE ?? 'off').trim().toLowerCase();
  if (mode !== 'on' && mode !== 'off') problems.push('SALON_MAINTENANCE must be "on" or "off".');

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { ownerTokenHashes: hashes, tokenPepper: pepper, writesPerMinute, exportByteCap, maintenance: mode === 'on' } };
}
