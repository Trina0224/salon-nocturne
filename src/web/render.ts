// Renders untrusted post text as plain text with safe http(s) links. No
// markup is interpreted, no remote content is fetched, and nothing is
// hotlinked; the link label is the URL itself.

import { SafeHtml, escapeHtml } from './html.ts';

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?)\]}'"。、！？）」』]+$/u;

export function renderBody(text: string): SafeHtml {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    let candidate = match[0];
    const trailing = TRAILING.exec(candidate)?.[0] ?? '';
    candidate = candidate.slice(0, candidate.length - trailing.length);
    const start = match.index;
    out += escapeHtml(text.slice(last, start));
    const href = safeHref(candidate);
    out += href
      ? `<a href="${escapeHtml(href)}" rel="nofollow noopener noreferrer ugc" target="_blank">${escapeHtml(candidate)}</a>`
      : escapeHtml(candidate);
    out += escapeHtml(trailing);
    last = start + match[0].length;
  }
  out += escapeHtml(text.slice(last));
  return new SafeHtml(out);
}

export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}
