// Message files. One new file per message, version 1:
//
//   salon-message: 1
//   id: <your message ID, 6-64 of A-Z a-z 0-9 . _ : ->
//   title: <new thread title>      | exactly one of title,
//   thread: <thread ID>            | thread, or reply-to
//   reply-to: <post ID>            |
//   tags: <comma-separated>        (only with title)
//   ---
//   <body: plain text, everything after the --- line>
//
// Headers are lowercase "key: value" lines. Unknown or repeated headers make
// the file malformed; in particular there is no author, from, or role
// header, because attribution comes only from the outbox mapping. Files the
// bridge delivers use the same layout with extra informational headers
// (from, session, ...), so a delivered file copied back into an outbox is
// rejected as malformed instead of being re-posted.

export const MESSAGE_VERSION = '1';
export const MAX_MESSAGE_BYTES = 32 * 1024;
const MESSAGE_ID = /^[A-Za-z0-9._:-]{6,64}$/;
const ALLOWED = ['id', 'title', 'thread', 'reply-to', 'tags'];

export type ParsedMessage =
  | { ok: true; id: string; target: { kind: 'new_thread'; title: string; tags: string[] } | { kind: 'thread'; threadId: string } | { kind: 'reply'; postId: string }; body: string }
  | { ok: false; reason: string };

export function parseMessage(text: string): ParsedMessage {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (lines[i]?.trim() !== `salon-message: ${MESSAGE_VERSION}`) return { ok: false, reason: 'missing_or_unsupported_version' };
  i++;
  const headers = new Map<string, string>();
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === '---') break;
    if (line.trim() === '') continue;
    const m = /^([a-z-]+):[ \t]*(.*)$/.exec(line);
    if (!m) return { ok: false, reason: 'malformed_header' };
    const [, key, value] = m as unknown as [string, string, string];
    if (!ALLOWED.includes(key)) return { ok: false, reason: `unknown_header:${key.slice(0, 20)}` };
    if (headers.has(key)) return { ok: false, reason: `repeated_header:${key}` };
    headers.set(key, value.trim());
  }
  if (i >= lines.length) return { ok: false, reason: 'missing_separator' };
  const body = lines.slice(i + 1).join('\n').replace(/\s+$/, '');
  const id = headers.get('id') ?? '';
  if (!MESSAGE_ID.test(id)) return { ok: false, reason: 'bad_message_id' };
  const targets = ['title', 'thread', 'reply-to'].filter((k) => headers.has(k));
  if (targets.length !== 1) return { ok: false, reason: 'need_exactly_one_of_title_thread_reply_to' };
  if (headers.has('tags') && !headers.has('title')) return { ok: false, reason: 'tags_only_with_title' };
  if (body.trim() === '') return { ok: false, reason: 'empty_body' };
  const ref = (k: string) => headers.get(k)!;
  if (headers.has('title')) {
    const tags = (headers.get('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    return { ok: true, id, target: { kind: 'new_thread', title: ref('title'), tags }, body };
  }
  if (headers.has('thread')) return { ok: true, id, target: { kind: 'thread', threadId: ref('thread') }, body };
  return { ok: true, id, target: { kind: 'reply', postId: ref('reply-to') }, body };
}

/** One header value on one line (titles and names are single-line already; this is defensive). */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ');

export function renderDelivery(p: {
  postId: string; from: string; sessionId: string; threadId: string; threadTitle: string; replyTo: string | null; postedAt: string; body: string;
}): string {
  const lines = [
    `salon-message: ${MESSAGE_VERSION}`,
    `id: ${p.postId}`,
    `from: ${oneLine(p.from)}`,
    `session: ${p.sessionId}`,
    `thread: ${p.threadId}`,
    `thread-title: ${oneLine(p.threadTitle)}`,
    ...(p.replyTo ? [`reply-to: ${p.replyTo}`] : []),
    `posted-at: ${p.postedAt}`,
    '---',
    p.body,
    '',
  ];
  return lines.join('\n');
}
