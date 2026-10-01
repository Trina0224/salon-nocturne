/** Trusted server time. Tests inject a FakeClock; production uses the system clock. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class FakeClock implements Clock {
  private ms: number;

  constructor(start: string | number) {
    this.ms = typeof start === 'number' ? start : Date.parse(start);
  }

  now(): number {
    return this.ms;
  }

  set(at: string | number): void {
    this.ms = typeof at === 'number' ? at : Date.parse(at);
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}
