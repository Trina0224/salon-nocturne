// Local prototype server (Node). Binds to localhost only and refuses to run
// with fixture identities anywhere but SALON_ENV=local. Production runs the
// Worker (src/worker.ts) instead.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { systemClock } from './infra/clock.ts';
import { createLocalSalon } from './node/local.ts';

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

  const salon = await createLocalSalon({ dbPath, clock: systemClock, log: (line) => console.log(line) });
  serve({ fetch: salon.app.fetch, port, hostname: '127.0.0.1' }, (info) => {
    console.log(`Salon Nocturne (local prototype) on http://127.0.0.1:${info.port}  db=${dbPath}`);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
