// Full host-form regression tests: the unchanged admin.js form handlers run
// in a vm with a minimal DOM and a fetch that calls the real app, with faults
// injected into specific responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { TOKENS, setup, type Json } from './helpers.ts';

class FakeForm {
  fields: Record<string, string> = {};
  button = { disabled: false };
  private listeners: ((ev: { preventDefault(): void }) => void)[] = [];
  addEventListener(_type: string, fn: (ev: { preventDefault(): void }) => void) {
    this.listeners.push(fn);
  }
  querySelector() {
    return this.button;
  }
  reset() {
    for (const k of Object.keys(this.fields)) this.fields[k] = '';
  }
  submit() {
    for (const fn of this.listeners) fn({ preventDefault() {} });
  }
}

type Fault = (send: () => Promise<Response>) => Promise<unknown>;
interface Sent { path: string; key: string | undefined; body: Json }

/** Loads admin.js against the real app; `faults` alters the next matching POSTs. */
function hostPage(ctx: ReturnType<typeof setup>) {
  const forms = new Map<string, FakeForm>();
  const output = { textContent: '', classList: { toggle() {} } };
  const sent: Sent[] = [];
  const faults: Fault[] = [];
  const context: Json = {
    window: undefined,
    document: {
      querySelector(selector: string) {
        if (selector === '[data-admin-output]') return output;
        if (!forms.has(selector)) forms.set(selector, new FakeForm());
        return forms.get(selector);
      },
    },
    FormData: class {
      private form: FakeForm;
      constructor(form: FakeForm) { this.form = form; }
      get(name: string) { return this.form.fields[name] ?? null; }
    },
    sessionStorage: { getItem: () => TOKENS.owner, setItem() {} },
    crypto: webcrypto,
    fetch: (url: string, init: RequestInit & { headers: Record<string, string> }) => {
      const send = () => Promise.resolve(ctx.salon.app.request(url, init));
      if (init.method === 'POST') {
        sent.push({ path: url, key: init.headers['Idempotency-Key'], body: JSON.parse(String(init.body)) });
        const fault = faults.shift();
        if (fault) return fault(send);
      }
      return send();
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../public/assets/admin.js', import.meta.url), 'utf8'), context);

  const form = forms.get('[data-admin-post]')!;
  return {
    form,
    output,
    sent,
    faults,
    /** Submits the host-post form and waits for its handler to finish. */
    async submit() {
      form.submit();
      for (let i = 0; i < 200 && form.button.disabled === false; i++) await new Promise((r) => setImmediate(r));
      for (let i = 0; i < 2000 && form.button.disabled; i++) await new Promise((r) => setTimeout(r, 1));
      assert.equal(form.button.disabled, false, 'handler finished');
    },
  };
}

// The server commits, then the body fails mid-read (an interrupted response).
const unreadableBody: Fault = async (send) => {
  const res = await send();
  assert.equal(res.status >= 200 && res.status < 300, true);
  return { ok: true, status: res.status, json: () => Promise.reject(new TypeError('terminated')) };
};
// The server commits, then the connection drops before any response arrives.
const lostResponse: Fault = async (send) => {
  await send();
  throw new TypeError('Failed to fetch');
};

const count = (ctx: ReturnType<typeof setup>, sql: string, ...args: string[]) =>
  Number(ctx.raw.prepare(sql).get(...args)!.n);

test('host form: an unreadable success body keeps the form and key; the retry replays one post', async () => {
  const ctx = setup();
  const s = await ctx.openSession();
  const { thread } = await ctx.startThread(s.id, s.generation);
  const page = hostPage(ctx);
  const postsBefore = count(ctx, 'SELECT COUNT(*) AS n FROM posts');
  const usedBefore = count(ctx, 'SELECT posts_used AS n FROM sessions WHERE id = ?', s.id);

  page.form.fields = { thread: thread.id, title: '', tags: '', body: 'One message, interrupted.' };
  page.faults.push(unreadableBody);
  await page.submit();
  assert.ok(!page.output.textContent.startsWith('Posted'), page.output.textContent);
  assert.equal(page.form.fields.body, 'One message, interrupted.', 'the form is kept');
  assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM posts'), postsBefore + 1, 'the server did commit');

  await page.submit();
  assert.match(page.output.textContent, /^Posted post_\w+ \(confirmed on retry\)\.$/);
  assert.equal(page.form.fields.body, '', 'the form resets after a valid receipt');
  assert.equal(page.sent.length, 2);
  assert.deepEqual(page.sent[1], page.sent[0], 'same destination, body, and key');
  assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM posts'), postsBefore + 1, 'one persisted post');
  assert.equal(count(ctx, 'SELECT posts_used AS n FROM sessions WHERE id = ?', s.id), usedBefore + 1, 'one quota charge');
});

test('host form: an uncertain new thread retried after A closes and B opens stays in A', async () => {
  const ctx = setup();
  const a = await ctx.openSession({ title: 'Session A' });
  const page = hostPage(ctx);

  page.form.fields = { thread: '', title: 'House notes', tags: 'notes', body: 'Published once, in A.' };
  page.faults.push(lostResponse);
  await page.submit();
  assert.match(page.output.textContent, /retry the same request safely/);
  assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM threads WHERE session_id = ?', a.id), 1, 'committed in A');

  await ctx.call('POST', `/api/v1/admin/sessions/${a.id}/close`, { token: TOKENS.owner, body: { expected_revision: a.revision } });
  const b = await ctx.openSession({ title: 'Session B' });

  await page.submit(); // the untouched form, after the safe-retry message
  assert.match(page.output.textContent, /^Posted post_\w+ \(confirmed on retry\)\.$/);
  assert.equal(page.sent.length, 2);
  assert.deepEqual(page.sent[1], page.sent[0], 'same destination, session/generation, body, and key');
  assert.equal(page.sent[1]!.path, `/api/v1/sessions/${a.id}/threads`);
  assert.equal(page.sent[1]!.body.generation, a.generation);
  assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM threads'), 1, 'one thread in total');
  assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM posts'), 1, 'one post in total');
  assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM posts WHERE session_id = ?', b.id), 0, 'nothing published into B');
  assert.equal(count(ctx, 'SELECT posts_used AS n FROM sessions WHERE id = ?', a.id), 1, 'one quota charge in A');
  assert.equal(count(ctx, 'SELECT posts_used AS n FROM sessions WHERE id = ?', b.id), 0);

  // A genuinely new submission binds to the current session with a new key.
  page.form.fields = { thread: '', title: 'New in B', tags: '', body: 'A fresh message.' };
  await page.submit();
  assert.match(page.output.textContent, /^Posted post_\w+\.$/);
  assert.equal(page.sent[2]!.path, `/api/v1/sessions/${b.id}/threads`);
  assert.notEqual(page.sent[2]!.key, page.sent[0]!.key);
  assert.equal(count(ctx, 'SELECT COUNT(*) AS n FROM posts WHERE session_id = ?', b.id), 1);
});

test('host form: a definite rejection is not retried with the old key', async () => {
  const ctx = setup();
  const a = await ctx.openSession();
  const page = hostPage(ctx);
  await ctx.call('POST', `/api/v1/admin/sessions/${a.id}/close`, { token: TOKENS.owner, body: { expected_revision: a.revision } });
  page.form.fields = { thread: '', title: 'Too late', tags: '', body: 'After closing.' };
  await page.submit();
  assert.match(page.output.textContent, /SESSION_CLOSED/);
  const b = await ctx.openSession();
  await page.submit();
  assert.match(page.output.textContent, /^Posted /);
  assert.notEqual(page.sent[1]!.key, page.sent[0]!.key);
  assert.equal(page.sent[1]!.path, `/api/v1/sessions/${b.id}/threads`);
});
