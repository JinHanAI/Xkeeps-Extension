import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendUpdate, updateSummary } from '../lib/update-status.js';
import { LikesStore, likesDocument } from '../lib/likes-archive.js';

const now = Date.parse('2026-10-01T02:13:00Z');
test('update recommendations cover first use, missing baseline, recent and overdue full checks', () => {
  assert.equal(recommendUpdate({ count: 0, now }).mode, 'full');
  assert.equal(recommendUpdate({ count: 100, now }).reason, 'unverified');
  assert.equal(recommendUpdate({ count: 100, now, lastFullAt: '2026-10-01T00:00:00Z' }).mode, 'quick');
  assert.equal(recommendUpdate({ count: 100, now, lastFullAt: '2026-09-24T02:13:00Z' }).mode, 'quick');
  assert.equal(recommendUpdate({ count: 100, now: now + 1, lastFullAt: '2026-09-24T02:13:00Z' }).mode, 'full');
  assert.equal(recommendUpdate({ count: 100, now, lastFullAt: 'invalid' }).mode, 'full');
});

test('count transition distinguishes observations from newly added records', () => {
  const result = updateSummary(1630, '2026-09-30T00:00:00Z', 1631, '2026-10-01T00:00:00Z', { added: 1, updated: 196 });
  assert.equal(result.after_count - result.before_count, 1);
  assert.equal(result.updated, 196);
  assert.equal(updateSummary(1631, null, 1631, '2026-10-01T00:00:00Z').added, 0);
});

test('Likes preserves the merge baseline and start time across pages and reloads', async () => {
  const store = new LikesStore();
  const tweet = id => ({ tweet_id: id, status: 'available', full_text: id, created_at: '2026-09-01T00:00:00Z' });
  const record = { current: likesDocument({ userId: '42', likes: [tweet('1')], exportedAt: '2026-09-30T00:00:00Z' }), revision: 1 };
  store.transact = async (_id, action) => action(record).output;
  await store.start('42', 'test', 'quick');
  const startedAt = record.snapshot.started_at;
  await store.append('42', [tweet('1'), tweet('2')], new Date().toISOString());
  assert.equal(record.snapshot.started_at, startedAt);
  assert.equal(record.snapshot.before_count, 1);
  const result = await store.finish('42', 'quick_boundary', false);
  assert.equal(result.record.snapshot.update_summary.before_count, 1);
  assert.equal(result.record.snapshot.update_summary.after_count, 2);
  assert.equal(result.record.snapshot.update_summary.added, 1);
  const summary = structuredClone(record.snapshot.update_summary);
  await store.finish('42', 'quick_boundary', false);
  assert.deepEqual(record.snapshot.update_summary, summary);
});
