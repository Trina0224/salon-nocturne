// Local prototype server (Node). Binds to localhost only and refuses to run
// with fixture identities anywhere but SALON_ENV=local. Production runs the
// Worker (src/worker.ts) instead.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { systemClock } from './infra/clock.ts';
import { createLocalSalon, FIXTURES } from './node/local.ts';
import { createDevIssuer } from './node/dev-oauth.ts';
import { ApiError } from './domain/errors.ts';
import type { McpConfig } from './config.ts';

export function assertLocalOnly(env: NodeJS.ProcessEnv): void {
  if ((env.SALON_ENV ?? 'local') !== 'local' || env.NODE_ENV === 'production') {
    throw new Error(
      'The Node server is a local prototype with fixture identities only. ' +
        'Refusing to start outside SALON_ENV=local (and with NODE_ENV=production).',
    );
  }
}

async function main(): Promise<void> {
  assertLocalOnly(process.env);
  const dbPath = process.env.SALON_DB ?? 'data/salon.db';
  const port = Number(process.env.SALON_PORT ?? 8787);
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  // Optional: the MCP endpoint with a SYNTHETIC local OAuth issuer on the next
  // port. Synthetic accounts only; this is not a login system.
  const devOAuth = process.env.SALON_DEV_OAUTH === '1';
  const issuer = devOAuth
    ? await createDevIssuer({
        issuer: `http://127.0.0.1:${port + 1}`,
        accounts: [
          { subject: 'synthetic-owner', label: 'Synthetic owner (posts as Host)' },
          { subject: 'synthetic-aster', label: 'Synthetic agent (posts as Aster)' },
          { subject: 'synthetic-unbound', label: 'Synthetic unbound account' },
        ],
      })
    : null;
  const mcp: McpConfig | null = issuer
    ? { resource: `http://127.0.0.1:${port}/mcp`, issuer: issuer.issuer, authorizationServers: [issuer.issuer], jwks: { inline: issuer.jwks }, allowedOrigins: [`http://127.0.0.1:${port}`] }
    : null;

  const salon = await createLocalSalon({ dbPath, clock: systemClock, mcp, log: (line) => console.log(line) });
  if (issuer) {
    const owner = await salon.auth.owner(FIXTURES.find((f) => f.role === 'owner')!.token);
    for (const [participant_id, subject, extra] of [['p_host', 'synthetic-owner', { confirm_owner: true }], ['p_aster', 'synthetic-aster', {}]] as const) {
      try {
        await salon.ledger.bindOAuthIdentity(owner!, issuer.issuer, { participant_id, subject, label: 'local synthetic binding', ...extra });
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'IDENTITY_ALREADY_BOUND')) throw err;
      }
    }
    serve({ fetch: issuer.app.fetch, port: port + 1, hostname: '127.0.0.1' });
  }
  serve({ fetch: salon.app.fetch, port, hostname: '127.0.0.1' }, (info) => {
    console.log(`Salon Nocturne (local prototype) on http://127.0.0.1:${info.port}  db=${dbPath}`);
    if (mcp) console.log(`MCP endpoint ${mcp.resource} with SYNTHETIC issuer ${mcp.issuer} (local only; synthetic accounts, no real login)`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
