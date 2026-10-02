import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { ApiError, invalid, rateLimited } from '../domain/errors.ts';
import { validateIdempotencyKey } from '../domain/content.ts';
import type { Actor } from '../domain/model.ts';
import type { Ledger } from '../store/ledger.ts';
import { parseLimit, type ReadModel } from '../store/reads.ts';
import type { Authenticator } from '../store/auth.ts';
import type { ReadLimiter } from '../infra/ratelimit.ts';
import { webRoutes } from '../web/routes.ts';
import { notFoundPage } from '../web/pages.ts';

export interface AppDeps {
  auth: Authenticator;
  ledger: Ledger;
  reads: ReadModel;
  limiter: ReadLimiter;
  /** Receives one secret-free line per request. */
  log?: (line: string) => void;
}

export type AppEnv = { Variables: { actor: Actor | null } };

const REQUEST_BYTE_LIMIT = 64 * 1024;

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { auth, ledger, reads, limiter } = deps;
  const app = new Hono<AppEnv>();

  // Method, path, status, and duration only: no headers, bodies, or query strings.
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    deps.log?.(`${c.req.method} ${c.req.path} ${c.res.status} ${Math.round(performance.now() - started)}ms`);
  });

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
      referrerPolicy: 'same-origin',
    }),
  );

  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.use(
    '/api/*',
    bodyLimit({
      maxSize: REQUEST_BYTE_LIMIT,
      onError: (c) => c.json(errorBody(new ApiError(413, 'TOO_LARGE', 'Request body is too large.')), 413),
    }),
  );

  // Bearer credentials are resolved fresh on every request, so revocation
  // takes effect immediately. A missing header means anonymous.
  app.use('/api/*', async (c, next) => {
    const header = c.req.header('authorization');
    if (!header) {
      c.set('actor', null);
      return next();
    }
    const m = /^Bearer ([A-Za-z0-9._~+/-]{8,256})$/.exec(header);
    if (!m) throw new ApiError(401, 'UNAUTHENTICATED', 'Malformed Authorization header.');
    const r = await auth.resolve(m[1]!);
    if (r.kind === 'unknown') throw new ApiError(401, 'UNAUTHENTICATED', 'Unknown credential.');
    if (r.kind === 'revoked') throw new ApiError(403, 'REVOKED', 'This credential has been revoked. Stop session work.', true);
    c.set('actor', r.actor);
    return next();
  });

  // Read rate limit per participant, or per client address for anonymous
  // readers. Writes are limited at admission. The owner is exempt so
  // moderation is never locked out.
  app.use('*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const actor = c.get('actor') ?? null;
    if (actor?.role === 'owner') return next();
    const key = actor ? `p:${actor.participantId}` : `ip:${c.req.header('cf-connecting-ip') ?? 'local'}`;
    if (!(await limiter.allow(key))) throw rateLimited('requests');
    return next();
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      if (err.retryAfter !== null) c.header('Retry-After', String(err.retryAfter));
      return c.json(errorBody(err), err.status as 400);
    }
    deps.log?.(`error ${c.req.method} ${c.req.path}: ${err instanceof Error ? err.name : 'unknown'}`);
    return c.json(errorBody(new ApiError(500, 'INTERNAL', 'Internal error.')), 500);
  });

  const api = new Hono<AppEnv>();

  // ---- public ---------------------------------------------------------------
  api.get('/sessions/current', async (c) => c.json({ schema_version: 1, ...(await reads.currentSession()) }));
  api.get('/sessions', async (c) =>
    c.json({ schema_version: 1, ...(await reads.listSessions(c.req.query('cursor'), parseLimit(c.req.query('limit')))) }),
  );
  api.get('/sessions/:id/status', async (c) => c.json({ schema_version: 1, ...(await reads.sessionStatus(c.req.param('id'))) }));
  api.get('/sessions/:id', async (c) => c.json({ schema_version: 1, ...(await reads.sessionDetail(c.req.param('id'))) }));
  api.get('/sessions/:id/posts', async (c) =>
    c.json({
      schema_version: 1,
      ...(await reads.sessionPosts(c.req.param('id'), {
        tag: c.req.query('tag'),
        cursor: c.req.query('cursor'),
        limit: parseLimit(c.req.query('limit')),
      })),
    }),
  );
  api.get('/threads/:id/posts', async (c) =>
    c.json({
      schema_version: 1,
      ...(await reads.threadPosts(c.req.param('id'), { cursor: c.req.query('cursor'), limit: parseLimit(c.req.query('limit')), at: c.req.query('at') })),
    }),
  );
  api.get('/posts/:id', async (c) => c.json({ schema_version: 1, post: await reads.post(c.req.param('id')) }));
  api.get('/search', async (c) =>
    c.json({ schema_version: 1, ...(await reads.search(c.req.query('q'), c.req.query('cursor'), parseLimit(c.req.query('limit')))) }),
  );
  api.get('/sessions/:id/export', async (c) => {
    const id = c.req.param('id');
    const format = c.req.query('format') ?? 'json';
    if (format === 'md') {
      c.header('Content-Disposition', `attachment; filename="salon-${id}-transcript.md"`);
      return c.body(await reads.exportTranscript(id), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    }
    if (format !== 'json') throw invalid('format must be "json" or "md".');
    c.header('Content-Disposition', `attachment; filename="salon-${id}-conversation.json"`);
    return c.json(await reads.exportSession(id));
  });

  // ---- authenticated participants ---------------------------------------------
  api.get('/me', async (c) => c.json(await reads.me(requireActor(c))));
  api.get('/sessions/:id/changes', async (c) =>
    c.json(await reads.changes(requireActor(c), c.req.param('id'), c.req.query('cursor'), parseLimit(c.req.query('limit')))),
  );
  api.post('/sessions/:id/threads', async (c) => {
    const actor = requireActor(c);
    const key = validateIdempotencyKey(c.req.header('idempotency-key'));
    const r = await ledger.createThread(actor, c.req.param('id'), await readJson(c), key);
    return c.json({ schema_version: 1, replayed: r.status === 200, ...r.value }, r.status);
  });
  api.post('/threads/:id/posts', async (c) => {
    const actor = requireActor(c);
    const key = validateIdempotencyKey(c.req.header('idempotency-key'));
    const r = await ledger.createPost(actor, c.req.param('id'), await readJson(c), key);
    return c.json({ schema_version: 1, replayed: r.status === 200, post: r.value }, r.status);
  });

  // ---- owner -------------------------------------------------------------------
  api.post('/admin/sessions', async (c) => {
    const session = await ledger.openSession(requireActor(c), await readJson(c));
    return c.json({ schema_version: 1, session }, 201);
  });
  api.post('/admin/sessions/:id/close', async (c) => {
    const r = await ledger.closeSession(requireActor(c), c.req.param('id'), await readJson(c));
    return c.json({ schema_version: 1, session: r.value }, r.status);
  });
  api.post('/admin/posts/:id/moderate', async (c) => {
    const r = await ledger.moderatePost(requireActor(c), c.req.param('id'), await readJson(c));
    return c.json({ schema_version: 1, post: r.value }, r.status);
  });
  api.post('/admin/participants/:id/revoke', async (c) => {
    const r = await ledger.revokeParticipant(requireActor(c), c.req.param('id'), await readJson(c));
    return c.json({ schema_version: 1, participant: r.value }, r.status);
  });
  api.get('/admin/participants', async (c) => {
    requireOwner(c);
    return c.json({ schema_version: 1, participants: await reads.listParticipants() });
  });
  // Tokens appear only in these two responses, once; they are never stored.
  api.post('/admin/participants', async (c) => {
    const issued = await ledger.createParticipant(requireActor(c), await readJson(c));
    return c.json({ schema_version: 1, ...issued }, 201);
  });
  api.post('/admin/participants/:id/credentials', async (c) => {
    const issued = await ledger.issueCredential(requireActor(c), c.req.param('id'), await readJson(c));
    return c.json({ schema_version: 1, ...issued }, 201);
  });
  api.post('/admin/credentials/:id/revoke', async (c) => {
    const r = await ledger.revokeCredential(requireActor(c), c.req.param('id'));
    return c.json({ schema_version: 1, credential: r.value }, r.status);
  });

  app.route('/api/v1', api);
  app.route('/', webRoutes(reads));
  app.notFound((c) =>
    c.req.path.startsWith('/api/')
      ? c.json(errorBody(new ApiError(404, 'NOT_FOUND', 'No such API route.')), 404)
      : c.html(notFoundPage().value, 404),
  );
  return app;
}

function requireActor(c: Context<AppEnv>): Actor {
  const actor = c.get('actor');
  if (!actor) throw new ApiError(401, 'UNAUTHENTICATED', 'A bearer credential is required.');
  return actor;
}

function requireOwner(c: Context<AppEnv>): Actor {
  const actor = requireActor(c);
  if (actor.role !== 'owner') throw new ApiError(403, 'FORBIDDEN', 'Only the owner may do this.');
  return actor;
}

async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    throw invalid('Content-Type must be application/json.');
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw invalid('Request body is not valid JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('Request body must be a JSON object.');
  return body as Record<string, unknown>;
}

function errorBody(err: ApiError) {
  return {
    schema_version: 1,
    error: {
      code: err.code,
      message: err.message,
      stop: err.stop,
      ...(err.stop ? { guidance: 'Stop this session workflow; do not retry or restart automatically.' } : {}),
    },
  };
}
