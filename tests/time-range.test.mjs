import assert from 'node:assert/strict';
import test from 'node:test';
import { dateWindow, filterPosts, postTimeCoverage } from '../lib/time-range.js';

test('date filters use post publication time without changing the saved input', () => {
  const original = { bookmarks: [
    { tweet_id: '1', created_at: '2026-09-29T00:00:00Z' },
    { tweet_id: '2', created_at: '2026-08-01T00:00:00Z' },
    { tweet_id: '3' },
  ] };
  const selected = filterPosts(original, 'week', { now: Date.parse('2026-09-30T00:00:00Z') });
  assert.deepEqual(selected.bookmarks.map(item => item.tweet_id), ['1']);
  assert.equal(original.bookmarks.length, 3);
  assert.equal(selected.time_filter.field, 'created_at');
  assert.equal(selected.export_metadata.collection.bookmarks, 'partial');
});

test('custom bounds include both dates and reject reversed dates', () => {
  const input = { likes: [{ tweet_id: '1', created_at: '2026-09-29T00:00:00Z' }, { tweet_id: '2', created_at: '2026-09-30T10:59:59Z' }] };
  assert.equal(filterPosts(input, 'custom', { from: '2026-09-29', to: '2026-09-30' }).likes.length, 2);
  assert.throws(() => dateWindow('custom', { from: '2026-10-01', to: '2026-09-30' }), /有效/);
});

test('snapshot collection time never restricts publication time coverage', () => {
  const snapshot = { exported_at: '2026-10-01T02:13:00Z', bookmarks: [
    { created_at: '2026-09-30T00:00:00Z' }, { created_at: '2026-05-01T00:00:00Z' },
  ] };
  const coverage = postTimeCoverage(snapshot, Date.parse('2026-10-01T02:13:00Z'));
  assert.equal(coverage.counts.week, 1);
  assert.equal(coverage.counts.month, 1);
  assert.equal(coverage.counts.half, 2);
  assert.equal(coverage.oldest, '2026-05-01T00:00:00.000Z');
  assert.equal(postTimeCoverage({ bookmarks: [{}, {}] }).oldest, null);
});

test('publication display preserves seconds and timezone without inventing a missing time', async () => {
  const { formatPostTimestamp } = await import('../lib/time-range.js');
  assert.equal(formatPostTimestamp('2026-10-03T18:13:47Z'), '2026/10/04 02:13:47 (UTC+8)');
  assert.match(formatPostTimestamp('2026-10-03T18:13:47Z', 'en'), /04\/10\/2026, 02:13:47 \(UTC\+8\)/);
  assert.equal(formatPostTimestamp('2026-10-04'), '2026-10-04（具体时间未记录）');
  assert.equal(formatPostTimestamp('invalid'), '时间未记录');
  assert.equal(formatPostTimestamp(null, 'en'), 'Time not recorded');
});
