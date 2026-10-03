// Drive bridge configuration. It comes from one secret (DRIVE_BRIDGE_CONFIG)
// because folder IDs are private; nothing here is ever in the repository.
// The mapping (owner account + outbox folder ID -> participant) is the only
// source of attribution. Sharing one owner account between several agents is
// a trusted household convention, not cryptographic authentication of each
// agent.

import { validateTitle } from '../domain/content.ts';

export const MAX_BRIDGE_PARTICIPANTS = 8;

export interface DriveParticipantConfig {
  name: string;
  account: string;
  outbox: string;
  inbox: string;
}

export interface DriveBridgeConfig {
  version: 1;
  /** https URL of POST /drive/notifications on this deployment (where Drive sends wake-ups). */
  notifyUrl: string;
  accounts: { id: string }[];
  participants: DriveParticipantConfig[];
}

const ACCOUNT_ID = /^[a-z0-9-]{1,32}$/;
const FOLDER_ID = /^[A-Za-z0-9_-]{1,128}$/;

function httpsOrLoopback(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const u = new URL(raw);
    if (u.username || u.password || u.hash) return null;
    if (u.protocol === 'https:') return u.href;
    if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return u.href;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Validates the configuration. Problems never echo folder IDs or other
 * values. A folder may be an outbox or an inbox, never both, and never used
 * twice, so the bridge can never read what it writes.
 */
export function parseDriveConfig(raw: string | undefined, problems: string[]): DriveBridgeConfig | null {
  if (raw === undefined || raw.trim() === '') return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    problems.push('DRIVE_BRIDGE_CONFIG is not valid JSON.');
    return null;
  }
  const o = v as Record<string, unknown>;
  const before = problems.length;
  if (o?.version !== 1) problems.push('DRIVE_BRIDGE_CONFIG.version must be 1.');
  const notifyUrl = httpsOrLoopback(o?.notify_url);
  if (!notifyUrl) problems.push('DRIVE_BRIDGE_CONFIG.notify_url must be an https URL.');
  const accounts = Array.isArray(o?.accounts) ? (o.accounts as Record<string, unknown>[]) : [];
  if (accounts.length === 0 || !accounts.every((a) => typeof a?.id === 'string' && ACCOUNT_ID.test(a.id))) {
    problems.push('DRIVE_BRIDGE_CONFIG.accounts must list accounts with ids of a-z, 0-9, and -.');
  } else if (new Set(accounts.map((a) => a.id)).size !== accounts.length) {
    problems.push('DRIVE_BRIDGE_CONFIG.accounts has a duplicate id.');
  }
  const accountIds = new Set(accounts.map((a) => a?.id));
  const list = Array.isArray(o?.participants) ? (o.participants as Record<string, unknown>[]) : [];
  if (list.length === 0 || list.length > MAX_BRIDGE_PARTICIPANTS) {
    problems.push(`DRIVE_BRIDGE_CONFIG.participants must list 1 to ${MAX_BRIDGE_PARTICIPANTS} participants.`);
  }
  const participants: DriveParticipantConfig[] = [];
  const folders = new Set<string>();
  const names = new Set<string>();
  for (const p of list) {
    let name: string;
    try {
      name = validateTitle(p?.name, 'name', 60);
    } catch {
      problems.push('Each DRIVE_BRIDGE_CONFIG participant needs a one-line name of at most 60 characters.');
      continue;
    }
    if (names.has(name)) problems.push('DRIVE_BRIDGE_CONFIG has a duplicate participant name.');
    names.add(name);
    if (!accountIds.has(p.account)) problems.push('A DRIVE_BRIDGE_CONFIG participant names an unknown account.');
    for (const k of ['outbox', 'inbox'] as const) {
      if (typeof p[k] !== 'string' || !FOLDER_ID.test(p[k] as string)) problems.push(`A DRIVE_BRIDGE_CONFIG participant has a malformed ${k} folder ID.`);
      else if (folders.has(p[k] as string)) problems.push('A Drive folder is used more than once (as an outbox, an inbox, or both).');
      else folders.add(p[k] as string);
    }
    participants.push({ name, account: String(p.account), outbox: String(p.outbox), inbox: String(p.inbox) });
  }
  if (problems.length > before) return null;
  return { version: 1, notifyUrl: notifyUrl!, accounts: accounts.map((a) => ({ id: String(a.id) })), participants };
}
