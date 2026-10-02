// Local adapter: node:sqlite behind the same batch-only contract as D1.
// Node-only; never imported by the Worker.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Row, SqlDb, SqlValue, Statement } from '../infra/sql.ts';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export class NodeSql implements SqlDb {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = ON');
    migrate(this.raw);
  }

  async all(sql: string, ...params: SqlValue[]): Promise<Row[]> {
    return this.raw.prepare(sql).all(...params) as Row[];
  }

  async first(sql: string, ...params: SqlValue[]): Promise<Row | null> {
    return (this.raw.prepare(sql).get(...params) as Row | undefined) ?? null;
  }

  async run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }> {
    return { changes: Number(this.raw.prepare(sql).run(...params).changes) };
  }

  /**
   * Same semantics as D1 batch(): statements run in order inside one
   * transaction, and any error rolls all of them back. BEGIN IMMEDIATE also
   * serializes writers on other connections to the same file.
   */
  async batch(statements: Statement[]): Promise<void> {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      for (const s of statements) this.raw.prepare(s.sql).run(...s.params);
      this.raw.exec('COMMIT');
    } catch (err) {
      if (this.raw.isTransaction) this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.raw.close();
  }
}

/**
 * Applies migrations/*.sql in filename order, each once. These are the same
 * files `wrangler d1 migrations apply` uses for D1.
 */
export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(file)) {
        db.exec(readFileSync(MIGRATIONS_DIR + file, 'utf8'));
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, new Date().toISOString());
      }
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
}
