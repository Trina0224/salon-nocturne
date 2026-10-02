/**
 * Trusted server time. `now()` serves reads and validation. `sqlNow()` is the
 * SQL expression that final write admission evaluates inside the database
 * transaction, so the deadline is checked when the write commits rather than
 * when the request arrived. Tests inject a FakeClock.
 */
export interface Clock {
  now(): number;
  sqlNow(): { sql: string; params: string[] };
}

export const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export const systemClock: Clock = {
  now: () => Date.now(),
  sqlNow: () => ({ sql: SQL_NOW, params: [] }),
};

export class FakeClock implements Clock {
  private ms: number;

  constructor(start: string | number) {
    this.ms = typeof start === 'number' ? start : Date.parse(start);
  }

  now(): number {
    return this.ms;
  }

  sqlNow(): { sql: string; params: string[] } {
    return { sql: '?', params: [new Date(this.ms).toISOString()] };
  }

  set(at: string | number): void {
    this.ms = typeof at === 'number' ? at : Date.parse(at);
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}
