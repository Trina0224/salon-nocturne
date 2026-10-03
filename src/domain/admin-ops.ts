// Owner-approved administration relay: the operations a relay may propose and
// how a request is reduced to one canonical form. The same canonical form is
// computed when the relay proposes, when the owner approves (she confirms its
// digest), and when the relay executes, so an approval covers exactly one
// operation, target, and parameter set in one service context.
//
// The allowlist is deliberately small and agent-only: no operation can create
// or bind an owner identity, grant scopes, or open, close, or moderate.

import { invalid } from './errors.ts';
import { validateOAuthSubject, validateTitle } from './content.ts';

export const ADMIN_OPERATIONS = ['enroll_participant', 'bind_identity', 'revoke_binding', 'revoke_participant'] as const;
export type AdminOperation = (typeof ADMIN_OPERATIONS)[number];

/** Request fields a relay may send (flat, so MCP tool schemas stay simple). */
export const REQUEST_FIELDS = ['operation', 'target', 'participant_name', 'subject', 'label', 'reason'] as const;

export interface AdminRequest {
  operation: AdminOperation;
  /** '' for enroll_participant; otherwise the participant or binding ID. */
  target: string;
  /** Validated parameters. `subject` is the exact OAuth subject, never stored. */
  params: { participant_name?: string; subject?: string; label?: string; reason?: string };
}

const SHAPES: Record<AdminOperation, { target: boolean; params: (keyof AdminRequest['params'])[] }> = {
  enroll_participant: { target: false, params: ['participant_name', 'subject', 'label'] },
  bind_identity: { target: true, params: ['subject', 'label'] },
  revoke_binding: { target: true, params: [] },
  revoke_participant: { target: true, params: ['reason'] },
};

/**
 * Validates a request exactly: unknown fields, fields that do not belong to
 * the operation, and missing ones are refused. Nothing is trimmed or
 * normalized except where the existing validators already define it
 * (titles); OAuth subjects are kept exactly.
 */
export function parseAdminRequest(raw: Record<string, unknown>): AdminRequest {
  for (const k of Object.keys(raw)) {
    if (!(REQUEST_FIELDS as readonly string[]).includes(k)) throw invalid(`"${k}" is not part of an administrative request.`);
  }
  const operation = raw.operation;
  if (typeof operation !== 'string' || !(ADMIN_OPERATIONS as readonly string[]).includes(operation)) {
    throw invalid(`operation must be one of: ${ADMIN_OPERATIONS.join(', ')}.`);
  }
  const shape = SHAPES[operation as AdminOperation];
  let target = '';
  if (shape.target) target = validateTitle(raw.target, 'target', 64);
  else if (raw.target !== undefined && raw.target !== '') throw invalid(`${operation} takes no target.`);
  const params: AdminRequest['params'] = {};
  for (const k of ['participant_name', 'subject', 'label', 'reason'] as const) {
    const present = raw[k] !== undefined;
    if (!shape.params.includes(k)) {
      if (present) throw invalid(`${operation} does not take "${k}".`);
      continue;
    }
    if (!present) throw invalid(`${k} is required for ${operation}.`);
    if (k === 'subject') params.subject = validateOAuthSubject(raw.subject);
    else if (k === 'participant_name') params.participant_name = validateTitle(raw.participant_name, 'participant_name', 60);
    else if (k === 'label') params.label = validateTitle(raw.label, 'label', 60);
    else params.reason = validateTitle(raw.reason, 'reason', 200);
  }
  return { operation: operation as AdminOperation, target, params };
}

/** Canonical stored parameters: the subject is replaced by its peppered digest. */
export function storedParams(req: AdminRequest, subjectDigest: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.params).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (k === 'subject') out.subject_digest = subjectDigest!;
    else out[k] = v as string;
  }
  return out;
}

/** The exact string the digest covers: version, service context, operation, target, parameters. */
export function canonicalString(context: string, operation: AdminOperation, target: string, params: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify(['salon-admin-operation-v1', context, operation, target, sorted]);
}

