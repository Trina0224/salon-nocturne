// Owner-approved administration relay, with synthetic identities only:
// "synthetic-rei" posts as agent Rei; "synthetic-rei-relay" is Rei's separate
// relay binding. Approval comes only from the owner's REST token. This is
// local evidence of the server-side guarantees, not of any ChatGPT approval
// integration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalString } from '../src/domain/admin-ops.ts';
import { mcpWorld } from './mcp-helpers.ts';
import { TOKENS, setup, type Json } from './helpers.ts';

async function relayWorld() {
  const w = await mcpWorld();
  const bound = await w.call('POST', '/api/v1/admin/oauth-bindings', {
    token: TOKENS.owner, body: { participant_id: w.reiId, subject: 'synthetic-rei-relay', label: 'Rei relay (synthetic)', purpose: 'relay' },
  });
  assert.equal(bound.status, 201, JSON.stringify(bound.body));
  assert.deepEqual(bound.body.binding.scopes, ['relay']);
  const relayToken = await w.token('synthetic-rei-relay', 'salon:read salon:post salon:relay');
  const relay = (name: string, args: Json = {}, token = relayToken) => w.tool(token, name, args);
  const owner = (method: string, path: string, body?: Json) => w.call(method, path, { token: TOKENS.owner, body });
  const propose = async (args: Json) => {
    const r = await relay('propose_admin_operation', args);
    assert.equal(r.isError, false, JSON.stringify(r.data));
    return r.data.operation as Json;
  };
  const approve = (op: Json, ttl_minutes?: number) =>
    owner('POST', `/api/v1/admin/operations/${op.id}/approve`, { digest: op.digest, ...(ttl_minutes ? { ttl_minutes } : {}) });
  const execute = (op: Json, args: Json, key = 'exec-key-0001') =>
    relay('execute_admin_operation', { operation_id: op.id, ...args, idempotency_key: key });
  const count = (sql: string, ...p: string[]) => Number((w.raw.prepare(sql).get(...p) as { n: number }).n);
  return { ...w, relayToken, relayBindingId: bound.body.binding.id as string, relay, owner, propose, approve, execute, count };
}

const ENROLL = { operation: 'enroll_participant', participant_name: 'Muse', subject: 'synthetic-muse', label: 'Muse via ChatGPT (synthetic)' };

test('relay: propose, owner approves the exact digest, relay executes once; OAuth-only enrollment mints no REST token', async () => {
  const w = await relayWorld();
  const op = await w.propose(ENROLL);
  assert.equal(op.state, 'proposed');
  assert.match(op.summary, /Enroll a new agent participant "Muse" with OAuth sign-in only.*No REST token/);
  assert.match(op.subject_fingerprint, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(op).includes('synthetic-muse'), 'the subject is never echoed or stored');
  assert.ok(!JSON.stringify(w.raw.prepare('SELECT * FROM admin_operations').all()).includes('synthetic-muse'));

  // Nothing happens before approval.
  const early = await w.execute(op, ENROLL);
  assert.equal(early.data.error.code, 'APPROVAL_REQUIRED');
  assert.equal(w.count("SELECT COUNT(*) AS n FROM participants WHERE display_name = 'Muse'"), 0);

  // The owner reviews it on her own channel and must confirm the exact digest.
  const pending = await w.owner('GET', '/api/v1/admin/operations?state=proposed');
  assert.deepEqual(pending.body.operations.map((o: Json) => o.id), [op.id]);
  const wrongDigest = await w.owner('POST', `/api/v1/admin/operations/${op.id}/approve`, { digest: 'f'.repeat(64) });
  assert.equal(wrongDigest.body.error.code, 'APPROVAL_MISMATCH');
  const approved = await w.approve(op);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.operation.state, 'approved');
  assert.equal(Date.parse(approved.body.operation.approval_expires_at) - Date.parse(approved.body.operation.decided_at), 15 * 60_000);

  const done = await w.execute(op, ENROLL);
  assert.equal(done.isError, false, JSON.stringify(done.data));
  assert.equal(done.data.replayed, false);
  const result = done.data.operation.result;
  assert.equal(result.participant.display_name, 'Muse');
  assert.deepEqual(result.binding.scopes, ['read', 'post']);
  assert.ok(!JSON.stringify(done.data).includes('sna_'), 'no credential in the result');
  assert.ok(!/"(token|credential)"/.test(JSON.stringify(result)), 'no credential field in the result');
  assert.equal(w.count("SELECT COUNT(*) AS n FROM credentials WHERE participant_id = ? AND kind = 'token'", result.participant.id), 0, 'no REST token was minted');

  // The new agent signs in with OAuth and posts as itself.
  const who = (await w.tool(await w.token('synthetic-muse'), 'whoami')).data;
  assert.deepEqual(who.participant, { id: result.participant.id, display_name: 'Muse', role: 'agent' });
  assert.deepEqual(who.scopes, ['read', 'post']);

  // A retry with the same key returns the stored result without re-executing.
  const again = await w.execute(op, ENROLL);
  assert.equal(again.data.replayed, true);
  assert.deepEqual(again.data.operation.result, result);
  assert.equal(w.count("SELECT COUNT(*) AS n FROM participants WHERE display_name = 'Muse'"), 1);
  // A different key cannot reuse the approval.
  assert.equal((await w.execute(op, ENROLL, 'exec-key-0002')).data.error.code, 'APPROVAL_USED');

  // Audit: proposal, approval, and execution, with no subject or credential.
  const audit = w.raw.prepare("SELECT actor_id, action FROM audit_log WHERE target_id = ? ORDER BY id").all(op.id) as { actor_id: string; action: string }[];
  assert.deepEqual(audit.map((a) => a.action), ['propose_admin_operation', 'approve_admin_operation', 'relay_execute_admin_operation']);
  assert.deepEqual(audit.map((a) => a.actor_id), [w.reiId, 'p_host', w.reiId]);
  assert.ok(!JSON.stringify(w.raw.prepare('SELECT * FROM audit_log').all()).includes('synthetic-muse'));
});

test('relay: an altered operation, target, or parameter is refused without consuming the approval', async () => {
  const w = await relayWorld();
  const aster = 'p_aster';
  const req = { operation: 'bind_identity', target: aster, subject: 'synthetic-aster-2', label: 'second' };
  const op = await w.propose(req);
  await w.approve(op);
  for (const changed of [
    { ...req, subject: 'synthetic-aster-3' },
    { ...req, subject: ' synthetic-aster-2' },
    { ...req, target: 'p_birch' },
    { ...req, label: 'second!' },
    { operation: 'enroll_participant', participant_name: 'X', subject: 'synthetic-aster-2', label: 'second' },
  ]) {
    const r = await w.execute(op, changed);
    assert.equal(r.data.error.code, 'APPROVAL_MISMATCH', JSON.stringify(changed));
  }
  assert.equal(w.count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'relay_request_mismatch' AND target_id = ?", op.id), 5);
  assert.equal((await w.owner('GET', `/api/v1/admin/operations/${op.id}`)).body.operation.state, 'approved');
  // The exact request still works.
  const ok = await w.execute(op, req);
  assert.equal(ok.isError, false);
  assert.equal((await w.tool(await w.token('synthetic-aster-2'), 'whoami')).data.participant.id, aster);
});

test('relay: expired, revoked, rejected, and in-flight-revoked approvals never execute', async () => {
  const w = await relayWorld();

  // Expiry is checked inside the admission batch.
  const a = await w.propose(ENROLL);
  await w.approve(a, 1);
  w.clock.advance(61_000);
  assert.equal((await w.owner('GET', `/api/v1/admin/operations/${a.id}`)).body.operation.state, 'expired');
  assert.equal((await w.execute(a, ENROLL)).data.error.code, 'APPROVAL_EXPIRED');

  // Revoked before execution.
  const b = await w.propose({ ...ENROLL, subject: 'synthetic-muse-b' });
  await w.approve(b);
  assert.equal((await w.owner('POST', `/api/v1/admin/operations/${b.id}/revoke`, {})).body.operation.state, 'revoked');
  const rb = await w.execute(b, { ...ENROLL, subject: 'synthetic-muse-b' });
  assert.equal(rb.data.error.code, 'APPROVAL_REVOKED');
  assert.equal(rb.data.error.stop, true);

  // Revoked while the execution is in flight (after its checks, before its batch).
  const c = await w.propose({ ...ENROLL, subject: 'synthetic-muse-c' });
  await w.approve(c);
  w.hooks.beforeAdmission = async () => {
    w.hooks.beforeAdmission = undefined;
    await w.owner('POST', `/api/v1/admin/operations/${c.id}/revoke`, {});
  };
  assert.equal((await w.execute(c, { ...ENROLL, subject: 'synthetic-muse-c' })).data.error.code, 'APPROVAL_REVOKED');

  // The relay binding itself revoked in flight.
  const d = await w.propose({ ...ENROLL, subject: 'synthetic-muse-d' });
  await w.approve(d);
  w.hooks.beforeAdmission = async () => {
    w.hooks.beforeAdmission = undefined;
    await w.owner('POST', `/api/v1/admin/credentials/${w.relayBindingId}/revoke`, {});
  };
  assert.equal((await w.execute(d, { ...ENROLL, subject: 'synthetic-muse-d' })).data.error.code, 'REVOKED');
  assert.equal((await w.rpc(w.relayToken, 'tools/list')).status, 403, 'and the next request is refused at the door');
  assert.equal(w.count("SELECT COUNT(*) AS n FROM participants WHERE display_name = 'Muse'"), 0, 'nothing was enrolled');
});

test('relay: rejected proposals stay unusable; the owner cannot approve them later', async () => {
  const w = await relayWorld();
  const op = await w.propose(ENROLL);
  assert.equal((await w.owner('POST', `/api/v1/admin/operations/${op.id}/reject`, { reason: 'not now' })).body.operation.state, 'rejected');
  assert.equal((await w.execute(op, ENROLL)).data.error.code, 'APPROVAL_REQUIRED');
  assert.equal((await w.approve(op)).body.error.code, 'REVISION_CONFLICT');
  // Approving twice is idempotent; revoking an executed operation is refused.
  const op2 = await w.propose({ ...ENROLL, subject: 'synthetic-muse-2' });
  await w.approve(op2);
  assert.equal((await w.approve(op2)).status, 200);
  await w.execute(op2, { ...ENROLL, subject: 'synthetic-muse-2' });
  assert.equal((await w.owner('POST', `/api/v1/admin/operations/${op2.id}/revoke`, {})).body.error.code, 'APPROVAL_USED');
});

test('relay: concurrent executions consume an approval exactly once', async () => {
  const w = await relayWorld();
  const barrier = () => {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    w.hooks.beforeAdmission = async () => {
      if (++arrived === 2) release();
      await gate;
    };
  };
  // Same key: one execution and one replay of the same result.
  const op = await w.propose(ENROLL);
  await w.approve(op);
  barrier();
  const [a, b] = await Promise.all([w.execute(op, ENROLL), w.execute(op, ENROLL)]);
  w.hooks.beforeAdmission = undefined;
  assert.deepEqual([a.data.replayed, b.data.replayed].sort(), [false, true]);
  assert.deepEqual(a.data.operation.result, b.data.operation.result);
  assert.equal(w.count("SELECT COUNT(*) AS n FROM participants WHERE display_name = 'Muse'"), 1);

  // Different keys: one succeeds, the other is refused.
  const op2 = await w.propose({ ...ENROLL, participant_name: 'Muse 2', subject: 'synthetic-muse-2' });
  await w.approve(op2);
  barrier();
  const args = { ...ENROLL, participant_name: 'Muse 2', subject: 'synthetic-muse-2' };
  const [c, d] = await Promise.all([w.execute(op2, args, 'race-key-0001'), w.execute(op2, args, 'race-key-0002')]);
  w.hooks.beforeAdmission = undefined;
  const outcomes = [c, d].map((r) => (r.isError ? r.data.error.code : 'ok')).sort();
  assert.deepEqual(outcomes, ['APPROVAL_USED', 'ok']);
  assert.equal(w.count("SELECT COUNT(*) AS n FROM participants WHERE display_name = 'Muse 2'"), 1);
});

test('relay: no escalation: no host targets, no permission parameters, no posting or approving from the relay, no relay tools for posting connections', async () => {
  const w = await relayWorld();
  // Permission-shaped or unknown parameters are refused by the tool schema.
  for (const extra of [{ role: 'owner' }, { scopes: 'admin' }, { confirm_owner: true }, { purpose: 'relay' }, { approved: true }, { digest: 'x' }]) {
    const r = await w.relay('propose_admin_operation', { ...ENROLL, ...extra });
    assert.equal(r.data.error.code, 'INVALID_INPUT', JSON.stringify(extra));
  }
  // Fields that do not belong to the operation are refused too.
  assert.equal((await w.relay('propose_admin_operation', { operation: 'revoke_binding', target: 'cred_x', subject: 's' })).data.error.code, 'INVALID_INPUT');
  // The host cannot be targeted.
  assert.equal((await w.relay('propose_admin_operation', { operation: 'bind_identity', target: 'p_host', subject: 'synthetic-x', label: 'x' })).data.error.code, 'INVALID_INPUT');
  assert.equal((await w.relay('propose_admin_operation', { operation: 'revoke_participant', target: 'p_host', reason: 'x' })).data.error.code, 'INVALID_INPUT');
  assert.equal((await w.relay('propose_admin_operation', { operation: 'revoke_binding', target: w.ownerBindingId })).data.error.code, 'INVALID_INPUT');

  // The relay connection sees only identity and relay tools; it cannot post or read the feed.
  const relayTools = (await w.rpc(w.relayToken, 'tools/list')).body.result.tools.map((t: Json) => t.name).sort();
  assert.deepEqual(relayTools, ['execute_admin_operation', 'get_admin_operation', 'propose_admin_operation', 'whoami']);
  assert.equal((await w.rpc(w.relayToken, 'tools/call', { name: 'create_post', arguments: {} })).body.error.code, -32602);
  assert.equal((await w.rpc(w.relayToken, 'tools/call', { name: 'get_changes', arguments: {} })).body.error.code, -32602);
  const relayWho = (await w.relay('whoami')).data;
  assert.deepEqual(relayWho.scopes, ['relay']);
  assert.equal(relayWho.participant.role, 'agent');

  // Rei's posting connection has no relay tools, and the owner-bound MCP connection has no approval tools.
  const posting = await w.token('synthetic-rei');
  assert.equal((await w.rpc(posting, 'tools/call', { name: 'propose_admin_operation', arguments: ENROLL })).body.error.code, -32602);
  const host = await w.token('synthetic-owner');
  const hostTools = (await w.rpc(host, 'tools/list')).body.result.tools.map((t: Json) => t.name);
  assert.ok(!hostTools.some((n: string) => /admin|approve|operation/.test(n)));

  // Approval is REST with the owner token only: MCP tokens are not accepted there.
  const op = await w.propose(ENROLL);
  for (const t of [w.relayToken, posting, host, TOKENS.aster]) {
    const r = await w.call('POST', `/api/v1/admin/operations/${op.id}/approve`, { token: t, body: { digest: op.digest } });
    assert.ok([401, 403].includes(r.status), `${r.status}`);
  }
  // A relay cannot read or execute another relay's operation.
  const other = await w.call('POST', '/api/v1/admin/oauth-bindings', {
    token: TOKENS.owner, body: { participant_id: 'p_birch', subject: 'synthetic-birch-relay', label: 'Birch relay', purpose: 'relay' },
  });
  assert.equal(other.status, 201);
  await w.approve(op);
  const birchRelay = await w.token('synthetic-birch-relay', 'salon:relay');
  assert.equal((await w.relay('get_admin_operation', { operation_id: op.id }, birchRelay)).data.error.code, 'NOT_FOUND');
  assert.equal((await w.relay('execute_admin_operation', { operation_id: op.id, ...ENROLL, idempotency_key: 'other-key-01' }, birchRelay)).data.error.code, 'NOT_FOUND');
  // Relay bindings cannot belong to the host.
  const hostRelay = await w.call('POST', '/api/v1/admin/oauth-bindings', {
    token: TOKENS.owner, body: { participant_id: 'p_host', subject: 'synthetic-host-relay', label: 'x', purpose: 'relay', confirm_owner: true },
  });
  assert.equal(hostRelay.status, 400);
});

test('relay: revoke_binding and revoke_participant take effect; pending proposals are bounded', async () => {
  const w = await relayWorld();
  const muse = await w.owner('POST', '/api/v1/admin/participants', { display_name: 'Muse', oauth_subject: 'synthetic-muse', label: 'Muse (synthetic)' });
  assert.equal(muse.status, 201);
  const museToken = await w.token('synthetic-muse');
  assert.equal((await w.rpc(museToken, 'tools/list')).status, 200);

  const rb = { operation: 'revoke_binding', target: muse.body.binding.id };
  const op = await w.propose(rb);
  assert.match(op.summary, /Revoke OAuth binding .* of agent "Muse"/);
  await w.approve(op);
  assert.equal((await w.execute(op, rb)).isError, false);
  assert.equal((await w.rpc(museToken, 'tools/list')).status, 403);

  const rp = { operation: 'revoke_participant', target: 'p_cedar', reason: 'left the salon' };
  const op2 = await w.propose(rp);
  await w.approve(op2);
  await w.execute(op2, rp, 'exec-key-0003');
  assert.equal((await w.call('GET', '/api/v1/me', { token: TOKENS.cedar })).status, 403);

  for (let i = 0; i < 20; i++) await w.propose({ ...ENROLL, subject: `synthetic-bulk-${i}` });
  const over = await w.relay('propose_admin_operation', { ...ENROLL, subject: 'synthetic-bulk-x' });
  assert.equal(over.data.error.code, 'RATE_LIMITED');
});

test('REST: OAuth-only enrollment creates a participant and binding without a REST token', async () => {
  const w = await relayWorld();
  const r = await w.owner('POST', '/api/v1/admin/participants', { display_name: 'Lark', oauth_subject: 'synthetic-lark', label: 'Lark (synthetic)' });
  assert.equal(r.status, 201);
  assert.equal(r.body.credential, undefined);
  assert.ok(!JSON.stringify(r.body).includes('sna_') && !JSON.stringify(r.body).includes('synthetic-lark'));
  assert.equal(w.count("SELECT COUNT(*) AS n FROM credentials WHERE participant_id = ? AND kind = 'token'", r.body.participant.id), 0);
  assert.equal((await w.tool(await w.token('synthetic-lark'), 'whoami')).data.participant.display_name, 'Lark');
  // Without MCP configured there is no OAuth enrollment and no relay.
  const plain = setup();
  await plain.salon.ready;
  assert.equal((await plain.call('POST', '/api/v1/admin/participants', { token: TOKENS.owner, body: { display_name: 'X', oauth_subject: 's', label: 'x' } })).body.error.code, 'OAUTH_NOT_CONFIGURED');
  assert.equal((await plain.call('GET', '/api/v1/admin/operations', { token: TOKENS.owner })).body.error.code, 'OAUTH_NOT_CONFIGURED');
});

test('relay: the digest binds the service context, operation, target, and exact parameters', () => {
  const base = canonicalString('https://salon.test/mcp', 'bind_identity', 'p_a', { label: 'x', subject_digest: 'd' });
  assert.notEqual(base, canonicalString('https://other.test/mcp', 'bind_identity', 'p_a', { label: 'x', subject_digest: 'd' }));
  assert.notEqual(base, canonicalString('https://salon.test/mcp', 'bind_identity', 'p_b', { label: 'x', subject_digest: 'd' }));
  assert.notEqual(base, canonicalString('https://salon.test/mcp', 'bind_identity', 'p_a', { label: 'x ', subject_digest: 'd' }));
  assert.equal(base, canonicalString('https://salon.test/mcp', 'bind_identity', 'p_a', { subject_digest: 'd', label: 'x' }), 'key order does not matter');
});

test('relay: a Time Travel restore reapply withdraws every open approval, so none can be replayed', async () => {
  const { CAPTURE_SQL, parseCapture, reapplySql, verifySql } = await import('../src/ops/recovery.ts');
  const w = await relayWorld();
  const approvedOp = await w.propose(ENROLL);
  await w.approve(approvedOp);
  const pendingOp = await w.propose({ ...ENROLL, subject: 'synthetic-muse-2' });
  const capture = parseCapture({ capture: (w.raw.prepare(CAPTURE_SQL).get() as { capture: string }).capture });
  w.raw.exec(reapplySql(capture));
  const verify = w.raw.prepare(verifySql(capture)).get() as Record<string, number>;
  assert.equal(verify.open_admin_operations, 0);
  assert.equal((await w.owner('GET', `/api/v1/admin/operations/${approvedOp.id}`)).body.operation.state, 'revoked');
  assert.equal((await w.owner('GET', `/api/v1/admin/operations/${pendingOp.id}`)).body.operation.state, 'rejected');
  assert.equal((await w.execute(approvedOp, ENROLL)).data.error.code, 'APPROVAL_REVOKED');
});
