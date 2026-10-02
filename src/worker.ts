// Cloudflare Workers entry point. Static files under public/ are served by
// Workers Static Assets before this code runs; everything else comes here.
// Only Web APIs are used (no nodejs_compat): no Node, SQLite, or filesystem
// modules are reachable from this file.

import { systemClock } from './infra/clock.ts';
import { D1Sql, type D1Database } from './infra/d1.ts';
import { BindingReadLimiter } from './infra/ratelimit.ts';
import { workerConfig, type WorkerEnv } from './config.ts';
import { createSalon, type Salon } from './context.ts';

let cached: { env: WorkerEnv; salon: Salon } | null = null;

function misconfigured(): Response {
  return new Response(
    JSON.stringify({
      schema_version: 1,
      error: { code: 'MISCONFIGURED', message: 'The service is not configured.', stop: true },
    }),
    { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
  );
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const result = workerConfig(env);
    if (!result.ok) {
      // Fail closed. The problems name settings, never their values.
      console.error(`Configuration rejected: ${result.problems.join(' ')}`);
      return misconfigured();
    }
    if (!cached || cached.env !== env) {
      cached = {
        env,
        salon: createSalon({
          db: new D1Sql(env.DB as D1Database),
          clock: systemClock,
          config: result.config,
          limiter: new BindingReadLimiter(env.READ_LIMITER as ConstructorParameters<typeof BindingReadLimiter>[0]),
          log: (line) => console.log(line),
        }),
      };
    }
    return cached.salon.app.fetch(request);
  },
};
