// The storage contract shared by the local SQLite adapter and Cloudflare D1.
// It deliberately offers no interactive transactions: every write is a
// `batch` of statements that commits or rolls back as one unit, which is the
// atomicity D1 provides (see docs/architecture.md, "Write admission").

export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;

export interface Statement {
  sql: string;
  params: SqlValue[];
}

export interface SqlDb {
  all(sql: string, ...params: SqlValue[]): Promise<Row[]>;
  first(sql: string, ...params: SqlValue[]): Promise<Row | null>;
  run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }>;
  /** Executes statements in order; any error rolls back every statement. */
  batch(statements: Statement[]): Promise<void>;
}

export const stmt = (sql: string, ...params: SqlValue[]): Statement => ({ sql, params });

/** The named CHECK constraint that rejected a guarded write, if any. */
export function failedCheck(err: unknown): string | null {
  const m = /CHECK constraint failed: ([A-Z_]+)/.exec(String((err as Error)?.message ?? err));
  return m ? m[1]! : null;
}

export function isUniqueViolation(err: unknown, table: string): boolean {
  return String((err as Error)?.message ?? err).includes(`UNIQUE constraint failed: ${table}.`);
}
