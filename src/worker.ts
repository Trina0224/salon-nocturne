// Cloudflare Workers entry point. Static files under public/ are served by
// Workers Static Assets before this code runs; everything else comes here.
// Only Web APIs are used (no nodejs_compat): no Node, SQLite, or filesystem
// modules are reachable from this file.
//
// Drive bridge execution (only when every Drive setting is configured):
// - POST /drive/notifications validates the channel and, for a valid change,
//   runs one bounded bridge pass for that account after the response
//   (waitUntil). The body is never read.
// - The scheduled handler (a cron trigger the owner adds when activating the
//   bridge; none is configured in wrangler.toml) runs the full bounded pass:
//   config sync, channel renewal, every account, files, fan-out, deliveries.
// There is no public endpoint that starts a run on request.

import { systemClock } from './infra/clock.ts';
import { D1Sql, type D1Database } from './infra/d1.ts';
import { BindingReadLimiter } from './infra/ratelimit.ts';
import { workerConfig, type WorkerEnv } from './config.ts';
import { createSalon, type Salon } from './context.ts';
import { DriveHttpClient } from './drive/http.ts';
import { RefreshTokenProvider, type FetchLike } from './drive/tokens.ts';

type Binding = ConstructorParameters<typeof BindingReadLimiter>[0];

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

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

/** The Salon for this environment, or null (logged) when the configuration is rejected. */
function salonFor(env: WorkerEnv): Salon | null {
  const result = workerConfig(env);
  if (!result.ok) {
    // Fail closed. The problems name settings, never their values.
    console.error(`Configuration rejected: ${result.problems.join(' ')}`);
    return null;
  }
  if (cached && cached.env === env) return cached.salon;
  const driveCfg = result.config.drive ?? null;
  let drive: Parameters<typeof createSalon>[0]['drive'];
  if (driveCfg) {
    // The global fetch, looked up per call (bound correctly for the Workers runtime).
    const doFetch: FetchLike = (input, init) => fetch(input, init);
    const tokens = new RefreshTokenProvider(driveCfg.oauth, doFetch);
    drive = { config: driveCfg.bridge, client: (accountId) => new DriveHttpClient({ accountId, tokens, fetch: doFetch }) };
  }
  const salon = createSalon({
    db: new D1Sql(env.DB as D1Database),
    clock: systemClock,
    config: result.config,
    limiters: {
      requests: new BindingReadLimiter(env.REQUEST_LIMITER as Binding),
      participants: new BindingReadLimiter(env.PARTICIPANT_LIMITER as Binding),
    },
    drive,
    log: (line) => console.log(line),
  });
  cached = { env, salon };
  return salon;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx?: ExecutionContextLike): Promise<Response> {
    const salon = salonFor(env);
    if (!salon) return misconfigured();
    return salon.app.fetch(request, env, ctx as never);
  },

  /** Cron-triggered catch-up for the Drive bridge; a no-op when the bridge is not configured. */
  async scheduled(_controller: unknown, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void> {
    const salon = salonFor(env);
    if (!salon?.drive) return;
    const drive = salon.drive;
    ctx.waitUntil(drive.runOnce().catch((err: unknown) => {
      console.error(`Drive scheduled run failed: ${err instanceof Error ? err.name : 'unknown'}`);
    }));
  },
};
