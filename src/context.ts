// Wires storage, clock, auth, and the HTTP app together. Runtime-neutral: the
// Node server passes a SQLite adapter, the Worker passes D1.

import type { Hono } from 'hono';
import type { SqlDb } from './infra/sql.ts';
import type { Clock } from './infra/clock.ts';
import { CursorCodec } from './infra/cursor.ts';
import type { Limiters } from './api/app.ts';
import type { AppConfig } from './config.ts';
import { Ledger, type LedgerHooks } from './store/ledger.ts';
import { ReadModel } from './store/reads.ts';
import { AdminRelay } from './store/relay.ts';
import { Authenticator } from './store/auth.ts';
import { createApp, type AppEnv } from './api/app.ts';

export interface Salon {
  db: SqlDb;
  auth: Authenticator;
  ledger: Ledger;
  reads: ReadModel;
  relay: AdminRelay | null;
  app: Hono<AppEnv>;
}

export interface SalonOptions {
  db: SqlDb;
  clock: Clock;
  config: AppConfig;
  limiters: Limiters;
  hooks?: LedgerHooks;
  log?: (line: string) => void;
}

export function createSalon(opts: SalonOptions): Salon {
  const auth = new Authenticator(opts.db, { ownerTokenHashes: opts.config.ownerTokenHashes, tokenPepper: opts.config.tokenPepper });
  // Cursor signing key derived from the pepper: cursors survive restarts and
  // rotate with the pepper. Cursors carry no secrets; they only prevent forgery.
  const cursors = new CursorCodec(`cursor:${opts.config.tokenPepper}`);
  const ledger = new Ledger(opts.db, opts.clock, auth, { writesPerMinute: opts.config.writesPerMinute }, opts.hooks);
  const reads = new ReadModel(opts.db, opts.clock, cursors, { exportByteCap: opts.config.exportByteCap });
  // The administration relay exists only with MCP/OAuth configured: relays
  // are OAuth bindings, and approvals are bound to the MCP resource as their
  // service context.
  const mcp = opts.config.mcp;
  const relay = mcp ? new AdminRelay({ db: opts.db, clock: opts.clock, auth, ledger, issuer: mcp.issuer, context: mcp.resource }) : null;
  const app = createApp({ db: opts.db, auth, ledger, reads, relay, limiters: opts.limiters, maintenance: opts.config.maintenance, mcp, log: opts.log });
  return { db: opts.db, auth, ledger, reads, relay, app };
}
