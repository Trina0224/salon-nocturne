// Read rate limiting. On Workers this wraps the Rate Limiting binding (a
// per-location, eventually consistent counter: a coarse abuse brake, not an
// exact quota). Locally it is an in-memory fixed window.

import type { Clock } from './clock.ts';

export interface ReadLimiter {
  /** True if a request for `key` may proceed. */
  allow(key: string): Promise<boolean>;
}

interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export class BindingReadLimiter implements ReadLimiter {
  private readonly binding: RateLimitBinding;

  constructor(binding: RateLimitBinding) {
    this.binding = binding;
  }

  async allow(key: string): Promise<boolean> {
    return (await this.binding.limit({ key })).success;
  }
}

export class MemoryReadLimiter implements ReadLimiter {
  private readonly limit: number;
  private readonly periodMs: number;
  private readonly clock: Clock;
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(limit: number, periodMs: number, clock: Clock) {
    this.limit = limit;
    this.periodMs = periodMs;
    this.clock = clock;
  }

  async allow(key: string): Promise<boolean> {
    const now = this.clock.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.periodMs) {
      if (this.windows.size > 10_000) this.windows.clear();
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= this.limit;
  }
}
