// Cloudflare D1 adapter. Only the subset of the D1 binding this app uses is
// declared here, so the Node typecheck needs no Workers global types.

import type { Row, SqlDb, SqlValue, Statement } from './sql.ts';

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Row>(): Promise<{ results: T[] }>;
  first<T = Row>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
}

export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown[]>;
}

export class D1Sql implements SqlDb {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async all(sql: string, ...params: SqlValue[]): Promise<Row[]> {
    return (await this.db.prepare(sql).bind(...params).all<Row>()).results;
  }

  first(sql: string, ...params: SqlValue[]): Promise<Row | null> {
    return this.db.prepare(sql).bind(...params).first<Row>();
  }

  async run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }> {
    const r = await this.db.prepare(sql).bind(...params).run();
    return { changes: r.meta.changes ?? 0 };
  }

  /** D1 runs a batch as one SQL transaction and rolls it back on any error. */
  async batch(statements: Statement[]): Promise<void> {
    await this.db.batch(statements.map((s) => this.db.prepare(s.sql).bind(...s.params)));
  }
}
