// A salon with the MCP endpoint, a synthetic OAuth issuer, and synthetic
// bindings: "synthetic-owner" → the host, "synthetic-rei" → agent "Rei",
// "synthetic-stranger" → nobody. All values are synthetic test data.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createDevIssuer } from '../src/node/dev-oauth.ts';
import type { McpConfig } from '../src/config.ts';
import { TOKENS, setup, type Json } from './helpers.ts';

export const RESOURCE = 'https://salon.test/mcp';
export const ISSUER = 'https://issuer.test';
export const REDIRECT = 'https://client.test/callback';

export async function mcpWorld(opts: Parameters<typeof setup>[0] = {}) {
  const issuer = await createDevIssuer({
    issuer: ISSUER,
    accounts: [
      { subject: 'synthetic-owner', label: 'Synthetic owner' },
      { subject: 'synthetic-rei', label: 'Synthetic Rei' },
      { subject: 'synthetic-stranger', label: 'Synthetic stranger' },
    ],
  });
  const mcp: McpConfig = { resource: RESOURCE, issuer: ISSUER, authorizationServers: [ISSUER], jwks: { inline: issuer.jwks } };
  const ctx = setup({ ...opts, mcp });
  await ctx.salon.ready;

  // Routes requests by origin: the salon and the issuer, nothing else.
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const host = new URL(req.url).host;
    if (host === 'salon.test') return ctx.salon.app.request(req);
    if (host === 'issuer.test') return issuer.app.request(req);
    return new Response('not found', { status: 404 });
  };

  const rei = await ctx.call('POST', '/api/v1/admin/participants', { token: TOKENS.owner, body: { display_name: 'Rei' } });
  const reiId = rei.body.participant.id as string;
  const bindRei = await ctx.call('POST', '/api/v1/admin/oauth-bindings', {
    token: TOKENS.owner, body: { participant_id: reiId, subject: 'synthetic-rei', label: 'Rei via ChatGPT (synthetic)' },
  });
  const bindOwner = await ctx.call('POST', '/api/v1/admin/oauth-bindings', {
    token: TOKENS.owner, body: { participant_id: 'p_host', subject: 'synthetic-owner', label: 'Host via ChatGPT (synthetic)', confirm_owner: true },
  });
  if (bindRei.status !== 201 || bindOwner.status !== 201) throw new Error(`binding failed: ${JSON.stringify([bindRei.body, bindOwner.body])}`);

  const token = (subject: string, scope = 'salon:read salon:post', extra: Record<string, unknown> = {}) =>
    issuer.mint({ iss: ISSUER, sub: subject, aud: RESOURCE, scope, client_id: 'synthetic-client', ...extra });

  let rpcId = 0;
  /** One raw JSON-RPC call over HTTP. */
  async function rpc(bearer: string | null, method: string, params?: Json, headers: Record<string, string> = {}) {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers };
    if (bearer) h.Authorization = `Bearer ${bearer}`;
    const res = await fetchImpl(RESOURCE, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    const text = await res.text();
    let body: Json = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body, headers: res.headers };
  }

  /** tools/call, returning the parsed structured result. */
  async function tool(bearer: string, name: string, args: Json = {}) {
    const r = await rpc(bearer, 'tools/call', { name, arguments: args });
    if (r.status !== 200) throw new Error(`tools/call ${name}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    if (r.body.error) return { rpcError: r.body.error, isError: true, data: null, meta: undefined };
    return { isError: Boolean(r.body.result.isError), data: r.body.result.structuredContent, meta: r.body.result._meta, rpcError: null };
  }

  /**
   * The official MCP SDK client doing the whole OAuth flow a client like
   * ChatGPT does: 401 → protected resource metadata → issuer metadata →
   * dynamic registration → authorization code with PKCE S256 and the
   * resource parameter → token → MCP session.
   */
  async function sdkConnect(account: string) {
    const store: { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string; authUrl?: URL } = {};
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return REDIRECT;
      },
      get clientMetadata(): OAuthClientMetadata {
        return { client_name: 'Synthetic test client', redirect_uris: [REDIRECT], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' };
      },
      clientInformation: () => store.client,
      saveClientInformation: (c) => void (store.client = c),
      tokens: () => store.tokens,
      saveTokens: (t) => void (store.tokens = t),
      redirectToAuthorization: (u) => void (store.authUrl = u),
      saveCodeVerifier: (v) => void (store.verifier = v),
      codeVerifier: () => store.verifier!,
    };
    const first = new StreamableHTTPClientTransport(new URL(RESOURCE), { authProvider: provider, fetch: fetchImpl });
    try {
      await new Client({ name: 'synthetic-test', version: '1' }).connect(first);
      throw new Error('expected the first connection to require authorization');
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) throw err;
    }
    // The user picks a synthetic account on the issuer's consent page.
    const authUrl = store.authUrl!;
    const form = new URLSearchParams([...authUrl.searchParams.entries(), ['account', account]]);
    const consent = await fetchImpl(`${ISSUER}/authorize`, { method: 'POST', body: form, redirect: 'manual' });
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    await first.finishAuth(code);
    const client = new Client({ name: 'synthetic-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { authProvider: provider, fetch: fetchImpl }));
    return { client, authUrl, tokens: store.tokens! };
  }

  return { ...ctx, issuer, mcp, fetchImpl, rpc, tool, token, sdkConnect, reiId, ownerBindingId: bindOwner.body.binding.id as string, reiBindingId: bindRei.body.binding.id as string };
}
