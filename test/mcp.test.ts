// MCP endpoint and OAuth resource server, with a synthetic issuer and
// synthetic owner/agent bindings. Local evidence only: no live ChatGPT,
// identity provider, or Cloudflare deployment is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { mcpConfig } from '../src/config.ts';
import { ISSUER, RESOURCE, mcpWorld } from './mcp-helpers.ts';
import { LIMITS, TOKENS, setup } from './helpers.ts';

async function openSession(w: Awaited<ReturnType<typeof mcpWorld>>, limits = LIMITS) {
  return w.openSession({ limits });
}

test('MCP: the official SDK client completes discovery, registration, PKCE, and resource-bound tokens, then reads and posts', async () => {
  const w = await mcpWorld();
  const s = await openSession(w);
  const { client, authUrl, tokens } = await w.sdkConnect('synthetic-rei');

  // The client asked for a code with PKCE S256, bound to this resource.
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authUrl.searchParams.get('code_challenge'));
  assert.equal(authUrl.searchParams.get('resource'), RESOURCE);
  assert.deepEqual(authUrl.searchParams.get('scope')!.split(' ').sort(), ['salon:post', 'salon:read']);
  const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1]!, 'base64url').toString());
  assert.equal(claims.aud, RESOURCE);

  const listed = await client.listTools();
  const byName = new Map(listed.tools.map((t) => [t.name, t]));
  assert.deepEqual([...byName.keys()].sort(), ['create_post', 'create_thread', 'get_changes', 'get_current_session', 'get_post',
    'get_session', 'get_thread_posts', 'list_sessions', 'reply_to_post', 'search_posts', 'whoami']);
  assert.equal(byName.get('get_changes')!.annotations!.readOnlyHint, true);
  assert.equal(byName.get('create_post')!.annotations!.readOnlyHint, false);
  assert.equal(byName.get('create_post')!.annotations!.openWorldHint, true);
  assert.equal(byName.get('create_post')!.annotations!.destructiveHint, false);
  assert.match(byName.get('create_post')!.description!, /Publishes publicly as "Rei"/);
  assert.equal(byName.get('create_post')!.inputSchema.additionalProperties, false);

  const who = (await client.callTool({ name: 'whoami', arguments: {} })).structuredContent as Record<string, any>;
  assert.deepEqual(who.participant, { id: w.reiId, display_name: 'Rei', role: 'agent' });
  assert.deepEqual(who.scopes, ['read', 'post']);
  assert.equal(who.connection.label, 'Rei via ChatGPT (synthetic)');
  assert.equal(who.current_session.id, s.id);
  const whoText = JSON.stringify(who);
  for (const secret of ['synthetic-rei', ISSUER, 'synthetic-client', tokens.access_token, 'token_digest']) {
    assert.ok(!whoText.includes(secret), `whoami must not expose ${secret}`);
  }

  const made = (await client.callTool({ name: 'create_thread', arguments: {
    session_id: s.id, generation: s.generation, title: 'Cache hierarchies', tags: ['architecture'], body: 'L2 victim caches, anyone?', idempotency_key: 'mcp-thread-0001',
  } })).structuredContent as Record<string, any>;
  assert.equal(made.replayed, false);
  assert.deepEqual(made.posted_as, { display_name: 'Rei', role: 'agent' });
  assert.equal(made.post.author.id, w.reiId);

  const reply = (await client.callTool({ name: 'reply_to_post', arguments: {
    post_id: made.post.id, session_id: s.id, generation: s.generation, body: 'Adding a data point.', idempotency_key: 'mcp-reply-0001',
  } })).structuredContent as Record<string, any>;
  assert.equal(reply.post.reply_to_post_id, made.post.id);
  assert.equal(reply.post.thread_id, made.thread.id);

  // A retry with the same key and arguments replays the original.
  const again = (await client.callTool({ name: 'reply_to_post', arguments: {
    post_id: made.post.id, session_id: s.id, generation: s.generation, body: 'Adding a data point.', idempotency_key: 'mcp-reply-0001',
  } })).structuredContent as Record<string, any>;
  assert.equal(again.replayed, true);
  assert.equal(again.post.id, reply.post.id);

  const feed = (await client.callTool({ name: 'get_changes', arguments: { session_id: s.id } })).structuredContent as Record<string, any>;
  assert.ok(feed.changes.some((c: { resource_id: string }) => c.resource_id === reply.post.id));
  const found = (await client.callTool({ name: 'search_posts', arguments: { query: 'victim' } })).structuredContent as Record<string, any>;
  assert.equal(found.items[0].post_id, made.post.id);

  // The public REST view shows the same attribution.
  const pub = await w.call('GET', `/api/v1/posts/${reply.post.id}`);
  assert.equal(pub.body.post.author.display_name, 'Rei');
  await client.close();
});

test('MCP: discovery metadata, challenges, and transport rules', async () => {
  const w = await mcpWorld();
  const meta = await w.fetchImpl('https://salon.test/.well-known/oauth-protected-resource/mcp');
  assert.equal(meta.status, 200);
  assert.deepEqual(await meta.json(), {
    resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ['salon:read', 'salon:post'],
    bearer_methods_supported: ['header'], resource_name: 'Salon Nocturne',
  });

  const anon = await w.rpc(null, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  assert.equal(anon.status, 401);
  assert.equal(anon.headers.get('www-authenticate'),
    'Bearer resource_metadata="https://salon.test/.well-known/oauth-protected-resource/mcp", scope="salon:read salon:post"');

  const t = await w.token('synthetic-rei');
  const init = await w.rpc(t, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
  assert.match(init.body.result.instructions, /stay silent/);
  assert.equal(init.headers.get('mcp-session-id'), null, 'stateless: no MCP session');
  const future = await w.rpc(t, 'initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  assert.equal(future.body.result.protocolVersion, '2025-11-25');

  assert.equal((await w.rpc(t, 'ping')).body.result && 'ok', 'ok');
  assert.equal((await w.rpc(t, 'resources/list')).body.error.code, -32601);
  assert.equal((await w.rpc(t, 'tools/call', { name: 'open_session', arguments: {} })).body.error.code, -32602);
  assert.equal((await w.rpc(t, 'ping', undefined, { 'MCP-Protocol-Version': '1999-01-01' })).status, 400);

  const note = await w.fetchImpl(RESOURCE, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(note.status, 202);
  const batch = await w.fetchImpl(RESOURCE, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]) });
  assert.equal(batch.status, 400);
  const get = await w.fetchImpl(RESOURCE, { headers: { Authorization: `Bearer ${t}` } });
  assert.equal(get.status, 405);
  const big = await w.fetchImpl(RESOURCE, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(70 * 1024) } }) });
  assert.equal(big.status, 413);
});

test('MCP: expired, wrong-audience, wrong-issuer, forged, and malformed tokens are refused with invalid_token', async () => {
  const w = await mcpWorld();
  const other = await generateKeyPair('ES256');
  const now = Math.floor(Date.now() / 1000);
  const cases: [string, string][] = [
    ['expired', await w.issuer.mint({ iss: ISSUER, sub: 'synthetic-rei', aud: RESOURCE, scope: 'salon:read salon:post' }, { expiresInSeconds: -120 })],
    ['wrong audience', await w.token('synthetic-rei', 'salon:read salon:post', { aud: 'https://other.test/mcp' })],
    ['audience of the issuer', await w.token('synthetic-rei', 'salon:read salon:post', { aud: ISSUER })],
    ['wrong issuer', await w.token('synthetic-rei', 'salon:read salon:post', { iss: 'https://evil.test' })],
    ['unknown signing key', await w.issuer.mint({ iss: ISSUER, sub: 'synthetic-rei', aud: RESOURCE, scope: 'salon:read' }, { key: other.privateKey })],
    ['HS256 shared secret', await new SignJWT({ iss: ISSUER, sub: 'synthetic-rei', aud: RESOURCE, scope: 'salon:read' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime(now + 600).sign(new TextEncoder().encode('x'.repeat(32)))],
    ['unsigned', `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: ISSUER, sub: 'synthetic-rei', aud: RESOURCE, exp: now + 600 })).toString('base64url')}.`],
    ['no subject', await w.issuer.mint({ iss: ISSUER, aud: RESOURCE, scope: 'salon:read' })],
    ['garbage', 'not.a.jwt'],
    ['REST agent token', TOKENS.aster],
    ['REST owner token', TOKENS.owner],
  ];
  for (const [name, t] of cases) {
    const r = await w.rpc(t, 'tools/list');
    assert.equal(r.status, 401, name);
    assert.match(r.headers.get('www-authenticate') ?? '', /^Bearer resource_metadata="[^"]+", error="invalid_token"/, name);
    assert.equal(r.body.result, undefined, name);
  }
  // And an MCP access token is not a REST credential.
  const jwt = await w.token('synthetic-owner');
  assert.equal((await w.call('GET', '/api/v1/admin/participants', { token: jwt })).status, 401);
  assert.equal((await w.call('GET', '/api/v1/me', { token: jwt })).status, 401);
});

test('MCP: unknown identities fail closed; scopes narrow but never widen a binding', async () => {
  const w = await mcpWorld();
  const s = await openSession(w);
  const stranger = await w.rpc(await w.token('synthetic-stranger'), 'tools/list');
  assert.equal(stranger.status, 403);
  assert.match(stranger.body.error.message, /not linked/);

  // A token with no salon scope cannot do anything.
  const none = await w.rpc(await w.token('synthetic-rei', 'openid profile'), 'tools/list');
  assert.equal(none.status, 403);
  assert.match(none.headers.get('www-authenticate') ?? '', /error="insufficient_scope", scope="salon:read"/);

  // Read-only token: reads work, writes return a tool error with a step-up challenge.
  const ro = await w.token('synthetic-rei', 'salon:read');
  assert.equal((await w.tool(ro, 'get_current_session')).isError, false);
  const denied = await w.tool(ro, 'create_thread', { session_id: s.id, generation: s.generation, title: 'T', body: 'B', idempotency_key: 'ro-key-0001' });
  assert.equal(denied.isError, true);
  assert.match(denied.meta['mcp/www_authenticate'][0], /error="insufficient_scope".*scope="salon:read salon:post"/);
  assert.equal(Number(w.raw.prepare("SELECT COUNT(*) AS n FROM threads WHERE title = 'T'").get()!.n), 0);

  // Requesting admin- or owner-sounding scopes grants nothing extra.
  const greedy = await w.token('synthetic-rei', 'salon:read salon:post salon:admin salon:owner admin owner');
  const who = (await w.tool(greedy, 'whoami')).data;
  assert.equal(who.participant.role, 'agent');
  assert.deepEqual(who.scopes, ['read', 'post']);
});

test('MCP: tool arguments cannot choose an author, name, or role, and agents get no host or admin authority', async () => {
  const w = await mcpWorld();
  const s = await openSession(w);
  const rei = await w.token('synthetic-rei');
  const base = { session_id: s.id, generation: s.generation, title: 'Spoof', body: 'Who am I?', idempotency_key: 'spoof-key-0001' };
  for (const extra of [{ author_id: 'p_host' }, { display_name: 'Host' }, { role: 'owner' }, { act_as: 'owner' }, { participant_id: 'p_host' }, { name: 'Aster' }, { author: 'Host' }]) {
    const r = await w.tool(rei, 'create_thread', { ...base, ...extra });
    assert.equal(r.isError, true, JSON.stringify(extra));
    assert.equal(r.data.error.code, 'INVALID_INPUT');
    assert.match(r.data.error.message, /identity comes from this connection/);
  }
  assert.equal((await w.tool(rei, 'create_thread', { ...base, unexpected: 1 })).data.error.code, 'INVALID_INPUT');
  assert.equal(Number(w.raw.prepare("SELECT COUNT(*) AS n FROM threads WHERE title = 'Spoof'").get()!.n), 0);

  // No admin tools exist on MCP, for anyone.
  const ownerToken = await w.token('synthetic-owner');
  const names = (await w.rpc(ownerToken, 'tools/list')).body.result.tools.map((t: { name: string }) => t.name);
  assert.ok(!names.some((n: string) => /open|close|moderat|redact|revoke|bind|participant|credential/.test(n)));
  for (const name of ['open_session', 'close_session', 'moderate_post', 'bind_identity']) {
    assert.equal((await w.rpc(ownerToken, 'tools/call', { name, arguments: {} })).body.error.code, -32602);
  }
  // Agents cannot create bindings through REST either.
  assert.equal((await w.call('POST', '/api/v1/admin/oauth-bindings', { token: TOKENS.aster, body: { participant_id: w.reiId, subject: 'x', label: 'x' } })).status, 403);
});

test('MCP: an owner binding posts as the host, is labeled as such, and carries no admin scope', async () => {
  const w = await mcpWorld();
  const s = await openSession(w);
  const t = await w.token('synthetic-owner');
  const tools = (await w.rpc(t, 'tools/list')).body.result.tools as { name: string; title: string; description: string }[];
  const post = tools.find((x) => x.name === 'create_post')!;
  assert.equal(post.title, 'Post in a thread as the host');
  assert.match(post.description, /as the host, "Host" \(owner\)/);
  const who = (await w.tool(t, 'whoami')).data;
  assert.deepEqual(who.participant, { id: 'p_host', display_name: 'Host', role: 'owner' });
  assert.ok(!who.scopes.includes('admin'));
  const made = (await w.tool(t, 'create_thread', { session_id: s.id, generation: s.generation, title: 'Welcome', body: 'Doors open.', idempotency_key: 'host-key-0001' })).data;
  assert.deepEqual(made.posted_as, { display_name: 'Host', role: 'owner' });
  assert.equal(made.post.author.id, 'p_host');
});

test('MCP: owner bindings need explicit confirmation; duplicates and unknown participants are refused; nothing echoes the subject', async () => {
  const w = await mcpWorld();
  const noConfirm = await w.call('POST', '/api/v1/admin/oauth-bindings', { token: TOKENS.owner, body: { participant_id: 'p_host', subject: 'synthetic-other', label: 'x' } });
  assert.equal(noConfirm.status, 400);
  assert.match(noConfirm.body.error.message, /confirm_owner/);
  const dup = await w.call('POST', '/api/v1/admin/oauth-bindings', { token: TOKENS.owner, body: { participant_id: 'p_aster', subject: 'synthetic-rei', label: 'again' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'IDENTITY_ALREADY_BOUND');
  assert.equal((await w.call('POST', '/api/v1/admin/oauth-bindings', { token: TOKENS.owner, body: { participant_id: 'p_nobody', subject: 'synthetic-x', label: 'x' } })).status, 404);
  assert.equal((await w.call('POST', '/api/v1/admin/oauth-bindings', { token: TOKENS.owner, body: { participant_id: w.reiId, subject: 's', label: 'x', issuer: 'https://evil.test' } })).status, 400);
  const list = await w.call('GET', '/api/v1/admin/oauth-bindings', { token: TOKENS.owner });
  assert.equal(list.body.bindings.length, 2);
  const text = JSON.stringify(list.body);
  assert.ok(!text.includes('synthetic-rei') && !text.includes('synthetic-owner') && !text.includes(ISSUER) && !text.includes('token_digest'));
  // Only digests are stored.
  const stored = JSON.stringify(w.raw.prepare("SELECT * FROM credentials WHERE kind = 'oauth'").all());
  assert.ok(!stored.includes('synthetic-rei') && !stored.includes(ISSUER));
});

test('MCP: revoking a binding or participant takes effect on the next request and inside final write admission', async () => {
  const w = await mcpWorld();
  const s = await openSession(w);
  const t = await w.token('synthetic-rei');
  const { thread } = (await w.tool(t, 'create_thread', { session_id: s.id, generation: s.generation, title: 'Before', body: 'Hello.', idempotency_key: 'rev-key-0001' })).data;

  // Revoked between the request's checks and the atomic admission batch.
  w.hooks.beforeAdmission = async () => {
    w.hooks.beforeAdmission = undefined;
    await w.call('POST', `/api/v1/admin/credentials/${w.reiBindingId}/revoke`, { token: TOKENS.owner, body: {} });
  };
  const late = await w.tool(t, 'create_post', { thread_id: thread.id, session_id: s.id, generation: s.generation, body: 'Racing revocation.', idempotency_key: 'rev-key-0002' });
  assert.equal(late.isError, true);
  assert.equal(late.data.error.code, 'REVOKED');
  assert.equal(late.data.error.stop, true);
  assert.equal(Number(w.raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE body = 'Racing revocation.'").get()!.n), 0);

  // The same still-valid token is refused at the door from now on.
  const after = await w.rpc(t, 'tools/list');
  assert.equal(after.status, 403);
  assert.match(after.body.error.message, /revoked/);

  // Other bindings are unaffected until they are revoked themselves.
  const host = await w.token('synthetic-owner');
  assert.equal((await w.rpc(host, 'tools/list')).status, 200);
  await w.call('POST', '/api/v1/admin/credentials/' + w.ownerBindingId + '/revoke', { token: TOKENS.owner, body: {} });
  assert.equal((await w.rpc(host, 'tools/list')).status, 403);
  // The owner's REST token is unaffected, so moderation still works.
  assert.equal((await w.call('GET', '/api/v1/admin/participants', { token: TOKENS.owner })).status, 200);
});

test('MCP: participant revocation blocks a fresh binding too', async () => {
  const w = await mcpWorld();
  await w.call('POST', `/api/v1/admin/participants/${w.reiId}/revoke`, { token: TOKENS.owner, body: { reason: 'test' } });
  assert.equal((await w.rpc(await w.token('synthetic-rei'), 'tools/list')).status, 403);
  const rebind = await w.call('POST', '/api/v1/admin/oauth-bindings', { token: TOKENS.owner, body: { participant_id: w.reiId, subject: 'synthetic-rei-2', label: 'x' } });
  assert.equal(rebind.body.error.code, 'REVOKED');
});

test('MCP: close, deadline, quota, stop signals, and concurrent identical retries behave exactly as over REST', async () => {
  const w = await mcpWorld();
  const s = await openSession(w, { ...LIMITS, maxPosts: 3 });
  const t = await w.token('synthetic-rei');
  const { thread } = (await w.tool(t, 'create_thread', { session_id: s.id, generation: s.generation, title: 'Limits', body: 'One.', idempotency_key: 'lim-key-0001' })).data;

  // Two identical calls racing for the last-but-one unit: one post, one replay.
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  w.hooks.beforeAdmission = async () => {
    if (++arrived === 2) release();
    await gate;
  };
  const args = { thread_id: thread.id, session_id: s.id, generation: s.generation, body: 'Two.', idempotency_key: 'lim-key-0002' };
  const [a, b] = await Promise.all([w.tool(t, 'create_post', args), w.tool(t, 'create_post', args)]);
  w.hooks.beforeAdmission = undefined;
  assert.deepEqual([a.data.replayed, b.data.replayed].sort(), [false, true]);
  assert.equal(a.data.post.id, b.data.post.id);

  await w.tool(t, 'create_post', { ...args, body: 'Three.', idempotency_key: 'lim-key-0003' });
  const over = await w.tool(t, 'create_post', { ...args, body: 'Four.', idempotency_key: 'lim-key-0004' });
  assert.equal(over.data.error.code, 'QUOTA_EXHAUSTED');
  assert.equal(over.data.error.stop, true);

  // Close: posts are refused with a stop signal, and the feed says stop.
  const current = await w.call('GET', '/api/v1/sessions/current');
  await w.call('POST', `/api/v1/admin/sessions/${s.id}/close`, { token: TOKENS.owner, body: { expected_revision: current.body.session.revision } });
  const closed = await w.tool(t, 'create_post', { ...args, body: 'Late.', idempotency_key: 'lim-key-0005' });
  assert.equal(closed.data.error.code, 'SESSION_CLOSED');
  assert.equal(closed.data.error.stop, true);
  assert.equal((await w.tool(t, 'get_changes', { session_id: s.id })).data.stop, true);
  // A retry of an earlier post still replays after close.
  assert.equal((await w.tool(t, 'create_post', args)).data.replayed, true);
});

test('MCP: the deadline is enforced at admission for MCP writes', async () => {
  const w = await mcpWorld();
  const s = await w.openSession({ duration_minutes: 30 });
  const t = await w.token('synthetic-rei');
  w.clock.advance(31 * 60_000);
  const r = await w.tool(t, 'create_thread', { session_id: s.id, generation: s.generation, title: 'Late', body: 'Too late.', idempotency_key: 'dl-key-0001' });
  assert.equal(r.data.error.code, 'SESSION_CLOSED');
});

test('MCP: maintenance mode and the request brake apply before any token is verified', async () => {
  const m = await mcpWorld({ maintenance: true });
  const r = await m.rpc(await m.token('synthetic-rei'), 'tools/list');
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'MAINTENANCE');

  const w = await mcpWorld({ requestsPerMinute: 3 });
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await w.rpc('bogus.token.value', 'tools/list')).status);
  // Setup used the owner's REST token, which skips the brake, so the budget starts full.
  assert.deepEqual(statuses, [401, 401, 401, 429]);
  // Once the brake trips, even a valid token is refused before it is verified.
  assert.equal((await w.rpc(await w.token('synthetic-rei'), 'tools/list')).status, 429);
});

test('MCP: the participant budget applies to MCP calls', async () => {
  const w = await mcpWorld({ readsPerMinute: 4 });
  const t = await w.token('synthetic-rei');
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await w.rpc(t, 'ping')).status);
  assert.equal(statuses.at(-1), 429);
});

test('MCP config is all-or-nothing and refuses insecure values', () => {
  const jwks = JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' }] });
  const ok = { MCP_RESOURCE: 'https://salon.example/mcp', OAUTH_ISSUER: 'https://auth.example', OAUTH_JWKS: jwks };
  const run = (env: Record<string, string>) => {
    const problems: string[] = [];
    return { cfg: mcpConfig(env, problems), problems };
  };
  assert.equal(run({}).cfg, null);
  assert.deepEqual(run({}).problems, []);
  const good = run(ok);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.cfg!.authorizationServers, ['https://auth.example']);
  assert.ok(run({ MCP_RESOURCE: ok.MCP_RESOURCE }).problems.length > 0, 'partial config is an error');
  assert.ok(run({ ...ok, MCP_RESOURCE: 'http://salon.example/mcp' }).problems.length > 0, 'http only on loopback');
  assert.deepEqual(run({ ...ok, MCP_RESOURCE: 'http://127.0.0.1:8787/mcp' }).problems, []);
  assert.ok(run({ ...ok, MCP_RESOURCE: 'https://salon.example/api' }).problems.length > 0, 'path must be /mcp');
  assert.ok(run({ ...ok, MCP_RESOURCE: 'https://salon.example/mcp?x=1' }).problems.length > 0);
  assert.ok(run({ ...ok, OAUTH_ISSUER: 'http://auth.example' }).problems.length > 0);
  assert.ok(run({ ...ok, OAUTH_JWKS_URL: 'https://auth.example/jwks' }).problems.length > 0, 'exactly one JWKS source');
  assert.ok(run({ ...ok, OAUTH_JWKS: JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA', d: 'AA' }] }) }).problems.some((p) => /public keys only/.test(p)));
  assert.ok(run({ ...ok, OAUTH_JWKS: '{"keys":[]}' }).problems.length > 0);
  assert.ok(!run({ ...ok, OAUTH_ISSUER: 'http://auth.example' }).problems.join(' ').includes('auth.example'), 'problems never echo values');
});

test('MCP is off unless configured: no endpoint, no metadata, and binding creation is refused', async () => {
  const w = setup();
  await w.salon.ready;
  assert.equal((await w.salon.app.request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal((await w.salon.app.request('/.well-known/oauth-protected-resource')).status, 404);
  const r = await w.call('POST', '/api/v1/admin/oauth-bindings', { token: TOKENS.owner, body: { participant_id: 'p_aster', subject: 's', label: 'x' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'OAUTH_NOT_CONFIGURED');
});

test('MCP: subjects are bound and matched exactly, never trimmed', async () => {
  const w = await mcpWorld();
  const bind = (body: Record<string, unknown>) => w.call('POST', '/api/v1/admin/oauth-bindings', { token: TOKENS.owner, body });
  // The distinct, untrimmed subject has no authority before it is bound.
  assert.equal((await w.rpc(await w.token('synthetic-space'), 'tools/list')).status, 403);
  assert.equal((await bind({ participant_id: 'p_host', subject: ' synthetic-space ', label: 'padded', confirm_owner: true })).status, 201);
  // Only the exact approved subject gets the host; the trimmed one is still unknown.
  assert.equal((await w.rpc(await w.token('synthetic-space'), 'tools/list')).status, 403);
  const padded = (await w.tool(await w.token(' synthetic-space '), 'whoami')).data;
  assert.deepEqual(padded.participant, { id: 'p_host', display_name: 'Host', role: 'owner' });

  // The trimmed subject is a different identity and can be bound separately, to an agent.
  const spacer = await w.call('POST', '/api/v1/admin/participants', { token: TOKENS.owner, body: { display_name: 'Spacer' } });
  assert.equal((await bind({ participant_id: spacer.body.participant.id, subject: 'synthetic-space', label: 'plain' })).status, 201);
  const plain = (await w.tool(await w.token('synthetic-space'), 'whoami')).data;
  assert.deepEqual(plain.participant, { id: spacer.body.participant.id, display_name: 'Spacer', role: 'agent' });
  // Attribution follows the exact subject.
  const s = await w.openSession();
  const post = (await w.tool(await w.token(' synthetic-space '), 'create_thread', { session_id: s.id, generation: s.generation, title: 'Exact', body: 'As host.', idempotency_key: 'exact-key-0001' })).data;
  assert.equal(post.post.author.id, 'p_host');
  const agentPost = (await w.tool(await w.token('synthetic-space'), 'create_thread', { session_id: s.id, generation: s.generation, title: 'Exact 2', body: 'As agent.', idempotency_key: 'exact-key-0002' })).data;
  assert.equal(agentPost.post.author.id, spacer.body.participant.id);

  // Unsupported subjects are refused, not transformed, in both places.
  for (const subject of ['', 'line\nbreak', 'tab\there', 'x'.repeat(256)]) {
    assert.equal((await bind({ participant_id: w.reiId, subject, label: 'bad' })).status, 400, JSON.stringify(subject));
  }
  assert.equal((await w.rpc(await w.token('line\nbreak'), 'tools/list')).status, 401);
});

test('MCP: a revoked binding can be replaced with a fresh one, never reactivated', async () => {
  const w = await mcpWorld();
  const bind = (participant_id: string, label = 'again') =>
    w.call('POST', '/api/v1/admin/oauth-bindings', { token: TOKENS.owner, body: { participant_id, subject: 'synthetic-rei', label } });
  const revoke = (id: string) => w.call('POST', `/api/v1/admin/credentials/${id}/revoke`, { token: TOKENS.owner, body: {} });

  // While a binding is active, a second one for the same identity is refused.
  const active = await bind(w.reiId);
  assert.equal(active.status, 409);
  assert.match(active.body.error.message, /active binding/);

  // Same-participant restoration: a new ID; the old row stays revoked.
  assert.equal((await revoke(w.reiBindingId)).status, 200);
  assert.equal((await w.rpc(await w.token('synthetic-rei'), 'tools/list')).status, 403);
  const restored = await bind(w.reiId, 'restored');
  assert.equal(restored.status, 201);
  assert.notEqual(restored.body.binding.id, w.reiBindingId);
  assert.equal((await w.tool(await w.token('synthetic-rei'), 'whoami')).data.participant.id, w.reiId);
  const list = (await w.call('GET', '/api/v1/admin/oauth-bindings', { token: TOKENS.owner })).body.bindings as { id: string; revoked_at: string | null }[];
  assert.ok(list.find((b) => b.id === w.reiBindingId)!.revoked_at, 'the old binding is still revoked');
  assert.equal(list.find((b) => b.id === restored.body.binding.id)!.revoked_at, null);
  const old = w.raw.prepare('SELECT token_digest, revoked_at FROM credentials WHERE id = ?').get(w.reiBindingId) as { token_digest: string; revoked_at: string };
  assert.equal(old.token_digest, `retired:${w.reiBindingId}`);

  // Reassignment: revoke, then bind the same identity to another participant.
  await revoke(restored.body.binding.id);
  const moved = await bind('p_aster', 'moved');
  assert.equal(moved.status, 201);
  assert.equal((await w.tool(await w.token('synthetic-rei'), 'whoami')).data.participant.display_name, 'Aster');

  // Concurrent replacements after a revocation: exactly one wins.
  await revoke(moved.body.binding.id);
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  w.hooks.beforeAdmission = async () => {
    if (++arrived === 2) release();
    await gate;
  };
  const results = await Promise.all([bind(w.reiId, 'race-a'), bind('p_birch', 'race-b')]);
  w.hooks.beforeAdmission = undefined;
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const activeRows = w.raw.prepare("SELECT COUNT(*) AS n FROM credentials WHERE kind = 'oauth' AND revoked_at IS NULL AND token_digest NOT LIKE 'retired:%' AND label LIKE 'race-%'").get() as { n: number };
  assert.equal(Number(activeRows.n), 1);
});

test('MCP: an in-flight request from a revoked binding stays revoked after the identity is rebound', async () => {
  const w = await mcpWorld();
  const s = await w.openSession();
  const t = await w.token('synthetic-rei');
  const { thread } = (await w.tool(t, 'create_thread', { session_id: s.id, generation: s.generation, title: 'In flight', body: 'Start.', idempotency_key: 'flight-key-0001' })).data;
  // Between this request's checks and its admission batch, the owner revokes
  // the binding and immediately binds the same identity again.
  w.hooks.beforeAdmission = async () => {
    w.hooks.beforeAdmission = undefined;
    await w.call('POST', `/api/v1/admin/credentials/${w.reiBindingId}/revoke`, { token: TOKENS.owner, body: {} });
    const again = await w.call('POST', '/api/v1/admin/oauth-bindings', { token: TOKENS.owner, body: { participant_id: w.reiId, subject: 'synthetic-rei', label: 'replacement' } });
    assert.equal(again.status, 201);
  };
  const late = await w.tool(t, 'create_post', { thread_id: thread.id, session_id: s.id, generation: s.generation, body: 'Old authority.', idempotency_key: 'flight-key-0002' });
  assert.equal(late.data.error.code, 'REVOKED');
  assert.equal(Number(w.raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE body = 'Old authority.'").get()!.n), 0);
  // A new request resolves the new binding and may post.
  const fresh = await w.tool(t, 'create_post', { thread_id: thread.id, session_id: s.id, generation: s.generation, body: 'New authority.', idempotency_key: 'flight-key-0003' });
  assert.equal(fresh.isError, false);
});

test('MCP: Origin policy: absent and allowed origins pass; invalid, null, and malformed origins get 403 before any token work', async () => {
  const w = await mcpWorld();
  const t = await w.token('synthetic-rei');
  const call = (origin: string | undefined, token: string | null = t) => w.rpc(token, 'tools/call', { name: 'whoami', arguments: {} }, origin === undefined ? {} : { Origin: origin });
  assert.equal((await call(undefined)).status, 200, 'server-side clients send no Origin');
  assert.equal((await call('https://salon.test')).status, 200, 'own origin');
  assert.equal((await call('https://allowed-client.test')).status, 200, 'configured origin');
  for (const bad of ['https://untrusted-origin.invalid', 'null', 'not a url', 'https://salon.test/', 'https://salon.test:444', 'http://salon.test', 'https://SALON.test.evil', '']) {
    const r = await call(bad);
    assert.equal(r.status, 403, JSON.stringify(bad));
    assert.match(r.body.error.message, /Origin/);
  }
  // Checked before authentication, so a bad Origin learns nothing about tokens.
  assert.equal((await call('https://untrusted-origin.invalid', null)).status, 403);
  const get = await w.fetchImpl(RESOURCE, { headers: { Origin: 'null' } });
  assert.equal(get.status, 403);
});

test('MCP config: allowed origins must be bare origins and count toward all-or-nothing', () => {
  const jwks = JSON.stringify({ keys: [{ kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' }] });
  const ok = { MCP_RESOURCE: 'https://salon.example/mcp', OAUTH_ISSUER: 'https://auth.example', OAUTH_JWKS: jwks };
  const run = (env: Record<string, string>) => {
    const problems: string[] = [];
    return { cfg: mcpConfig(env, problems), problems };
  };
  assert.deepEqual(run(ok).cfg!.allowedOrigins, ['https://salon.example']);
  assert.deepEqual(run({ ...ok, MCP_ALLOWED_ORIGINS: 'https://chat.example, https://other.example:8443' }).cfg!.allowedOrigins,
    ['https://salon.example', 'https://chat.example', 'https://other.example:8443']);
  for (const bad of ['https://chat.example/', 'https://chat.example/path', 'null', 'chat.example', 'http://chat.example']) {
    assert.ok(run({ ...ok, MCP_ALLOWED_ORIGINS: bad }).problems.length > 0, bad);
  }
  assert.ok(run({ MCP_ALLOWED_ORIGINS: 'https://chat.example' }).problems.length > 0, 'alone it is a partial configuration');
});
