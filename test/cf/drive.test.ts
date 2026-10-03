// The Drive bridge on local D1 (workerd): the same flow as the Node tests,
// to prove its SQL (upserts, json_each, leases, guarded updates) runs on D1.
// Mock Drive clients and synthetic data only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../../src/infra/clock.ts';
import { parseDriveConfig } from '../../src/drive/config.ts';
import { LIMITS } from '../../src/drive/bridge.ts';
import { MockDrive } from '../drive-mock.ts';
import { d1Salon, OWNER_TOKEN, cleanupTemplate } from './harness.ts';

after(cleanupTemplate);

test('D1: Drive outbox to ledger to inboxes, with an edit, a duplicate, a failing recipient, and a concurrent worker', async () => {
  const clock = new FakeClock('2026-10-01T12:00:00.000Z');
  const mock = new MockDrive(['account-a', 'account-b']);
  mock.now = () => clock.now();
  const config = parseDriveConfig(JSON.stringify({
    version: 1, notify_url: 'https://salon.test/drive/notifications',
    accounts: [{ id: 'account-a' }, { id: 'account-b' }],
    participants: [
      { name: 'Grok', account: 'account-a', outbox: 'out-grok', inbox: 'in-grok' },
      { name: 'Muse', account: 'account-b', outbox: 'out-muse', inbox: 'in-muse' },
      { name: 'Rei', account: 'account-b', outbox: 'out-rei', inbox: 'in-rei' },
    ],
  }), [])!;
  const s = await d1Salon({ clock, drive: { config, client: (a) => mock.client(a) } });
  try {
    const owner = await s.auth.resolve(OWNER_TOKEN);
    if (owner.kind !== 'ok') throw new Error('owner');
    await s.ledger.openSession(owner.actor, { title: 'D1 bridge', duration_minutes: 60, limits: { maxPosts: 50, maxPostsPerParticipant: 20, maxThreads: 5, maxBodyChars: 500 } });
    const bridge = s.drive!;
    await bridge.syncConfig();
    clock.advance(1000);
    const first = mock.addFile('account-a', 'out-grok', { content: 'salon-message: 1\nid: grok-d1-01\ntitle: On D1\n---\nHello from Grok.\n' });
    mock.fail('createTextFile', 'timeout_after_write', { account: 'account-b', times: 1 });
    await Promise.all([bridge.runOnce('w1'), bridge.runOnce('w2')]);
    mock.edit(first, 'salon-message: 1\nid: grok-d1-01\ntitle: On D1\n---\nEdited later.\n');
    mock.addFile('account-a', 'out-grok', { content: 'salon-message: 1\nid: grok-d1-01\ntitle: On D1\n---\nHello from Grok.\n' });
    clock.advance(LIMITS.maxBackoffMs + 1);
    await bridge.runOnce('w1');
    const posts = await s.db.all('SELECT body, author_id FROM posts');
    assert.deepEqual(posts.map((p) => p.body), ['Hello from Grok.']);
    const states = await s.db.all('SELECT state, later_changes FROM drive_files ORDER BY first_seen_at, file_id');
    assert.deepEqual(states.map((r) => [r.state, Number(r.later_changes)]), [['accepted', 1], ['duplicate', 0]]);
    assert.equal(mock.filesIn('in-muse').length, 1);
    assert.equal(mock.filesIn('in-rei').length, 1);
    assert.equal(mock.filesIn('in-grok').length, 0);
    const delivered = await s.db.first(`SELECT COUNT(*) AS n FROM drive_deliveries WHERE state = 'delivered'`);
    assert.equal(Number(delivered!.n), 2);
  } finally {
    await s.dispose();
  }
});
