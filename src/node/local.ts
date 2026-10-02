// The Node local prototype: SQLite storage, synthetic fixture identities, a
// public non-secret pepper, and static assets from public/. Node-only; the
// Worker never imports this module.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';
import { NodeSql } from './sqlite.ts';
import type { Clock } from '../infra/clock.ts';
import { MemoryReadLimiter } from '../infra/ratelimit.ts';
import { DEFAULTS, LOCAL_PEPPER, type AppConfig, type McpConfig } from '../config.ts';
import { createSalon, type Salon } from '../context.ts';
import { seedFixtures, type IdentityFixture } from '../store/auth.ts';
import type { LedgerHooks } from '../store/ledger.ts';
import { toIso } from '../domain/model.ts';

export const FIXTURES = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../../dev/identities.json', import.meta.url)), 'utf8')) as {
    participants: IdentityFixture[];
  }
).participants;

const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));
const ASSET_TYPES: Record<string, string> = {
  'style.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'admin.js': 'text/javascript; charset=utf-8',
  'scene.svg': 'image/svg+xml',
};
const ASSETS = new Map(Object.entries(ASSET_TYPES).map(([name, type]) => [name, { type, body: readFileSync(`${PUBLIC_DIR}assets/${name}`, 'utf8') }]));

export interface LocalOptions {
  dbPath: string;
  clock: Clock;
  hooks?: LedgerHooks;
  log?: (line: string) => void;
  writesPerMinute?: number;
  /** Per-participant budget (all methods). */
  readsPerMinute?: number;
  /** Per-client brake (all requests before credential lookup). */
  requestsPerMinute?: number;
  exportByteCap?: number;
  maintenance?: boolean;
  /** MCP endpoint and OAuth resource server (tests and the synthetic local issuer). */
  mcp?: McpConfig | null;
}

export interface LocalSalon extends Salon {
  sql: NodeSql;
  /** Resolves once fixture identities are seeded. */
  ready: Promise<void>;
}

/** Synchronous construction (handy for tests); await `ready` before use. */
export function createLocalSalonSync(opts: LocalOptions): LocalSalon {
  const ownerToken = FIXTURES.find((f) => f.role === 'owner')!.token;
  const config: AppConfig = {
    ownerTokenHashes: [createHash('sha256').update(ownerToken).digest('hex')],
    tokenPepper: LOCAL_PEPPER,
    writesPerMinute: opts.writesPerMinute ?? DEFAULTS.writesPerMinute,
    exportByteCap: opts.exportByteCap ?? DEFAULTS.exportByteCap,
    maintenance: opts.maintenance ?? false,
    mcp: opts.mcp ?? null,
  };
  const sql = new NodeSql(opts.dbPath);
  const salon = createSalon({
    db: sql,
    clock: opts.clock,
    config,
    limiters: {
      requests: new MemoryReadLimiter(opts.requestsPerMinute ?? 1200, 60_000, opts.clock),
      participants: new MemoryReadLimiter(opts.readsPerMinute ?? 600, 60_000, opts.clock),
    },
    hooks: opts.hooks,
    log: opts.log,
  });
  const ready = seedFixtures(sql, salon.auth, FIXTURES, toIso(opts.clock.now()));
  serveAssets(salon.app);
  return { ...salon, sql, ready };
}

export async function createLocalSalon(opts: LocalOptions): Promise<LocalSalon> {
  const salon = createLocalSalonSync(opts);
  await salon.ready;
  return salon;
}

/**
 * Serves public/assets the way Workers Static Assets does in production,
 * with the headers from public/_headers.
 */
function serveAssets(app: Hono<any>): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  app.get('/assets/:name', (c, next) => {
    const asset = ASSETS.get(c.req.param('name'));
    if (!asset) return next();
    c.header('Cache-Control', 'public, max-age=300');
    if (asset.type === 'image/svg+xml') c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    return c.body(asset.body, 200, { 'Content-Type': asset.type });
  });
}
