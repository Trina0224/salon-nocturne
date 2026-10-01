// Wires storage, clock, and the HTTP app together. Used by the server, the
// tests, and the demo so all three exercise the same code path.

import { randomBytes } from 'node:crypto';
import type { Hono } from 'hono';
import { openDatabase, type Db } from './infra/db.ts';
import type { Clock } from './infra/clock.ts';
import { CursorCodec } from './infra/cursor.ts';
import { Ledger, type LedgerHooks } from './store/ledger.ts';
import { ReadModel } from './store/reads.ts';
import { createApp, type AppEnv } from './api/app.ts';

export interface Salon {
  db: Db;
  ledger: Ledger;
  reads: ReadModel;
  app: Hono<AppEnv>;
}

export function createSalon(opts: { dbPath: string; clock: Clock; hooks?: LedgerHooks; log?: (line: string) => void }): Salon {
  const db = openDatabase(opts.dbPath);
  const cursors = new CursorCodec(cursorSecret(db));
  const ledger = new Ledger(db, opts.clock, opts.hooks);
  const reads = new ReadModel(db, opts.clock, cursors);
  return { db, ledger, reads, app: createApp({ db, ledger, reads, log: opts.log }) };
}

/** A per-database random secret so cursors survive restarts but cannot be forged. */
function cursorSecret(db: Db): string {
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('cursor_secret', ?)").run(randomBytes(32).toString('hex'));
  return String(db.prepare("SELECT value FROM meta WHERE key = 'cursor_secret'").get()!.value);
}
