// Test harness for the Workers runtime: real workerd and local D1 through
// Wrangler, with schemas applied by `wrangler d1 migrations apply`. This
// exercises Cloudflare's local implementation, not a mock; it is still not
// live Cloudflare validation.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy, unstable_dev } from 'wrangler';
import { D1Sql, type D1Database } from '../../src/infra/d1.ts';
import type { Clock } from '../../src/infra/clock.ts';
import { MemoryReadLimiter } from '../../src/infra/ratelimit.ts';
import { createSalon } from '../../src/context.ts';
import type { LedgerHooks } from '../../src/store/ledger.ts';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CONFIG = join(ROOT, 'wrangler.toml');
export const WRANGLER_ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };

// Synthetic test-only credentials, generated per run.
export const OWNER_TOKEN = createHash('sha256').update(`owner-${process.pid}-${Date.now()}`).digest('hex');
export const OWNER_HASH = createHash('sha256').update(OWNER_TOKEN).digest('hex');
export const PEPPER = createHash('sha256').update(`pepper-${process.pid}-${Date.now()}`).digest('hex');

export function wrangler(args: string[]): string {
  return execFileSync(join(ROOT, 'node_modules/.bin/wrangler'), args, { cwd: ROOT, env: WRANGLER_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

let template: string | null = null;

/** A fresh local D1 state directory with all migrations applied by Wrangler. */
export function migratedState(): string {
  if (!template) {
    template = mkdtempSync(join(tmpdir(), 'salon-d1-template-'));
    wrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', template]);
  }
  const dir = mkdtempSync(join(tmpdir(), 'salon-d1-'));
  cpSync(template, dir, { recursive: true });
  return dir;
}

/** The app wired to local D1 (inside workerd) through the platform proxy. */
export async function d1Salon(opts: { clock: Clock; hooks?: LedgerHooks; writesPerMinute?: number }) {
  const dir = migratedState();
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: CONFIG, persist: { path: join(dir, 'v3') }, envFiles: [] });
  const db = new D1Sql(proxy.env.DB);
  const salon = createSalon({
    db,
    clock: opts.clock,
    config: { ownerTokenHashes: [OWNER_HASH], tokenPepper: PEPPER, writesPerMinute: opts.writesPerMinute ?? 1_000_000, exportByteCap: 2 * 1024 * 1024 },
    limiter: new MemoryReadLimiter(1_000_000, 60_000, opts.clock),
    hooks: opts.hooks,
  });
  return {
    ...salon,
    async dispose() {
      await proxy.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The real Worker bundle in local workerd, with D1, assets, and the rate limiter. */
export async function startWorker(vars: Record<string, string>) {
  const dir = migratedState();
  const worker = await unstable_dev(join(ROOT, 'src/worker.ts'), {
    config: CONFIG,
    persistTo: dir,
    vars,
    ip: '127.0.0.1',
    logLevel: 'none',
    experimental: { disableExperimentalWarning: true },
  });
  return {
    worker,
    async stop() {
      await worker.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function cleanupTemplate(): void {
  if (template) rmSync(template, { recursive: true, force: true });
  template = null;
}
