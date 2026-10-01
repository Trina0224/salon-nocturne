import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type Db = DatabaseSync;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export function openDatabase(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/** Applies versioned SQL migrations in filename order, each exactly once. */
export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    immediate(db, () => {
      const done = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(file);
      if (done) return;
      db.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'));
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
    });
  }
}

/**
 * Runs fn inside BEGIN IMMEDIATE, which takes the database write lock up
 * front. Every admission decision and the writes it allows therefore commit
 * in one serial order, which is what makes close/post and last-quota-unit
 * races unambiguous in this local adapter. fn must be synchronous.
 */
export function immediate<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error('Transaction bodies must be synchronous.');
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}
