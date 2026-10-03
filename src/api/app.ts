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
import type { SqlDb } from '../infra/sql.ts';
import type { McpConfig } from '../config.ts';
import { mcpRoutes } from '../mcp/server.ts';
import type { AdminRelay } from '../store/relay.ts';

export interface Limiters {
  /** Per client address, every request, before credential lookup. */
  requests: ReadLimiter;
  /** Per participant, every authenticated request. */
  participants: ReadLimiter;
}
import { webRoutes } from '../web/routes.ts';
import { notFoundPage } from '../web/pages.ts';

export interface AppDeps {
  db: SqlDb;
  auth: Authenticator;
  /** Owner-approved administration relay; null when MCP/OAuth is not configured. */
  relay?: AdminRelay | null;
  ledger: Ledger;
  reads: ReadModel;
  limiters: Limiters;
  /** When true, only the owner is served (for restores and incidents). */
  maintenance?: boolean;
  /** MCP endpoint and OAuth resource server; absent or null disables /mcp. */
  mcp?: McpConfig | null;
  /** Receives one secret-free line per request. */
  log?: (line: string) => void;
}

export type AppEnv = { Variables: { actor: Actor | null } };

const REQUEST_BYTE_LIMIT = 64 * 1024;

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { auth, ledger, reads, limiters } = deps;
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

  // Request admission, cheapest checks first:
  //   1. The owner's token is checked by hash alone (no database), and the
  //      owner skips every brake below, so moderation is never locked out.
  //   2. In maintenance mode everyone else gets 503.
  //   3. A per-client request brake covers every method and every request,
  //      including malformed, unknown, and revoked credentials, BEFORE any
  //      database lookup of agent credentials.
  //   4. Agent credentials are resolved (fresh each request, so revocation is
  //      immediate), then a per-participant budget applies to all methods.
  // Publication additionally has its exact per-participant write rate inside
  // the admission batch.
  app.use('*', async (c, next) => {
    c.set('actor', null);
    const header = c.req.path.startsWith('/api/') ? c.req.header('authorization') : undefined;
    const m = header ? /^Bearer ([A-Za-z0-9._~+/-]{8,256})$/.exec(header) : null;
    const token = m ? m[1]! : null;
    if (token) {
      const owner = await auth.owner(token);
      if (owner) {
        c.set('actor', owner);
        return next();
      }
    }
    if (deps.maintenance) {
      throw new ApiError(503, 'MAINTENANCE', 'The salon is closed for maintenance. Stop and try again later.', true);
    }
    if (!(await limiters.requests.allow(`ip:${c.req.header('cf-connecting-ip') ?? 'local'}`))) throw rateLimited('requests');
    if (header && !token) throw new ApiError(401, 'UNAUTHENTICATED', 'Malformed Authorization header.');
    if (token) {
      const r = await auth.resolveAgent(token);
      if (r.kind === 'unknown') throw new ApiError(401, 'UNAUTHENTICATED', 'Unknown credential.');
      if (r.kind === 'revoked') throw new ApiError(403, 'REVOKED', 'This credential has been revoked. Stop session work.', true);
      if (!(await limiters.participants.allow(`p:${r.actor.participantId}`))) throw rateLimited('requests from this participant');
      c.set('actor', r.actor);
    }
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
    const body = await readJson(c);
    // With oauth_subject: OAuth-only enrollment, which mints no REST token.
    if (body.oauth_subject !== undefined) {
      const actor = requireOwner(c);
      if (!deps.mcp) throw new ApiError(409, 'OAUTH_NOT_CONFIGURED', 'The MCP endpoint and its OAuth issuer are not configured.');
      return c.json({ schema_version: 1, ...(await ledger.enrollParticipantOAuth(actor, deps.mcp.issuer, body)) }, 201);
    }
    const issued = await ledger.createParticipant(requireActor(c), body);
    return c.json({ schema_version: 1, ...issued }, 201);
  });
  api.post('/admin/participants/:id/credentials', async (c) => {
    const issued = await ledger.issueCredential(requireActor(c), c.req.param('id'), await readJson(c));
    return c.json({ schema_version: 1, ...issued }, 201);
  });
  // OAuth identity bindings for the MCP endpoint. Revoke one with the
  // credential revoke route below; its ID is the binding ID.
  api.post('/admin/oauth-bindings', async (c) => {
    const actor = requireOwner(c);
    if (!deps.mcp) throw new ApiError(409, 'OAUTH_NOT_CONFIGURED', 'The MCP endpoint and its OAuth issuer are not configured.');
    return c.json({ schema_version: 1, ...(await ledger.bindOAuthIdentity(actor, deps.mcp.issuer, await readJson(c))) }, 201);
  });
  api.get('/admin/oauth-bindings', async (c) => {
    requireOwner(c);
    return c.json({ schema_version: 1, bindings: await reads.listOAuthBindings() });
  });
  // Approval channel for the administration relay. Owner token only: an MCP
  // connection (owner-bound or not) can never reach these routes.
  const relay = () => {
    if (!deps.relay) throw new ApiError(409, 'OAUTH_NOT_CONFIGURED', 'The administration relay needs the MCP endpoint and its OAuth issuer.');
    return deps.relay;
  };
  api.get('/admin/operations', async (c) =>
    c.json({ schema_version: 1, operations: await relay().list(requireOwner(c), c.req.query('state')) }));
  api.get('/admin/operations/:id', async (c) =>
    c.json({ schema_version: 1, operation: await relay().getForOwner(requireOwner(c), c.req.param('id')) }));
  api.post('/admin/operations/:id/approve', async (c) =>
    c.json({ schema_version: 1, operation: await relay().approve(requireOwner(c), c.req.param('id'), await readJson(c)) }));
  api.post('/admin/operations/:id/reject', async (c) =>
    c.json({ schema_version: 1, operation: await relay().reject(requireOwner(c), c.req.param('id'), await readJson(c)) }));
  api.post('/admin/operations/:id/revoke', async (c) =>
    c.json({ schema_version: 1, operation: await relay().revoke(requireOwner(c), c.req.param('id')) }));

  api.post('/admin/credentials/:id/revoke', async (c) => {
    const r = await ledger.revokeCredential(requireActor(c), c.req.param('id'));
    return c.json({ schema_version: 1, credential: r.value }, r.status);
  });

  app.route('/api/v1', api);
  if (deps.mcp) app.route('/', mcpRoutes({ config: deps.mcp, db: deps.db, auth, ledger, reads, limiters, relay: deps.relay ?? null }));
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
