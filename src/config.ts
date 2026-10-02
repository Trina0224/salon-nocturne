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
  /** The MCP endpoint and its OAuth resource server; null when not configured. */
  mcp: McpConfig | null;
}

/** A JSON Web Key Set with public keys only. */
export interface PublicJwks {
  keys: Record<string, unknown>[];
}

export interface McpConfig {
  /** Canonical URL of the MCP endpoint; access tokens must name it as their audience. */
  resource: string;
  /** The only accepted token issuer (exact match). */
  issuer: string;
  /** Authorization servers advertised in protected resource metadata. */
  authorizationServers: string[];
  /** Where the issuer's signing keys come from. */
  jwks: { url: string } | { inline: PublicJwks };
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
  MCP_RESOURCE?: string;
  OAUTH_ISSUER?: string;
  OAUTH_AUTHORIZATION_SERVER?: string;
  OAUTH_JWKS_URL?: string;
  OAUTH_JWKS?: string;
}

const MCP_VARS = ['MCP_RESOURCE', 'OAUTH_ISSUER', 'OAUTH_AUTHORIZATION_SERVER', 'OAUTH_JWKS_URL', 'OAUTH_JWKS'] as const;
const PRIVATE_JWK_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k'];

/** https, or http only on a loopback host (local development). */
function secureUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || u.hash) return null;
  if (u.protocol === 'https:') return u;
  if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]')) return u;
  return null;
}

/**
 * MCP/OAuth settings are all-or-nothing: none set disables the MCP endpoint;
 * a partial or invalid set is a configuration error, so the Worker fails
 * closed instead of serving MCP with half a trust model. Values are public
 * (URLs and public keys), but problems still never echo them.
 */
export function mcpConfig(env: Pick<WorkerEnv, (typeof MCP_VARS)[number]>, problems: string[]): McpConfig | null {
  const set = MCP_VARS.filter((k) => (env[k] ?? '').trim() !== '');
  if (set.length === 0) return null;
  const before = problems.length;
  const resource = secureUrl((env.MCP_RESOURCE ?? '').trim());
  if (!resource || resource.search || resource.pathname !== '/mcp') {
    problems.push('MCP_RESOURCE must be the https URL of the /mcp endpoint, without query or fragment.');
  }
  const issuer = (env.OAUTH_ISSUER ?? '').trim();
  if (!secureUrl(issuer)) problems.push('OAUTH_ISSUER must be an https URL.');
  const asRaw = (env.OAUTH_AUTHORIZATION_SERVER ?? '').trim() || issuer;
  if (!secureUrl(asRaw)) problems.push('OAUTH_AUTHORIZATION_SERVER must be an https URL.');
  const jwksUrl = (env.OAUTH_JWKS_URL ?? '').trim();
  const jwksJson = (env.OAUTH_JWKS ?? '').trim();
  let jwks: McpConfig['jwks'] | null = null;
  if (Boolean(jwksUrl) === Boolean(jwksJson)) {
    problems.push('Set exactly one of OAUTH_JWKS_URL or OAUTH_JWKS.');
  } else if (jwksUrl) {
    if (secureUrl(jwksUrl)) jwks = { url: jwksUrl };
    else problems.push('OAUTH_JWKS_URL must be an https URL.');
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jwksJson);
    } catch {
      parsed = null;
    }
    const keys = (parsed as { keys?: unknown })?.keys;
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => k && typeof k === 'object')) {
      problems.push('OAUTH_JWKS must be a JSON Web Key Set with at least one key.');
    } else if (keys.some((k) => PRIVATE_JWK_MEMBERS.some((m) => m in (k as object)))) {
      problems.push('OAUTH_JWKS must contain public keys only.');
    } else {
      jwks = { inline: { keys: keys as Record<string, unknown>[] } };
    }
  }
  if (problems.length > before || !resource || !jwks) return null;
  return { resource: resource.href, issuer, authorizationServers: [asRaw], jwks };
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

  const mcp = mcpConfig(env, problems);

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { ownerTokenHashes: hashes, tokenPepper: pepper, writesPerMinute, exportByteCap, maintenance: mode === 'on', mcp } };
}
