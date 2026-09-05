import assert from 'node:assert/strict';
import test from 'node:test';
import '../lib/archive.js';
const { merge, validate } = globalThis.XArchive;
const t1 = '2026-01-01T00:00:00.000Z', t2 = '2026-02-01T00:00:00.000Z', t3 = '2026-03-01T00:00:00.000Z';
const bm = (id, extra = {}) => ({ tweet_id: id, status: 'available', full_text: `Post ${id}`, folders: [], ...extra });
const snapshot = (at, bookmarks, extra = {}) => ({ export_metadata: { user_id: '42', exported_at: at, collection: { bookmarks: 'complete', folders: 'complete' } }, folders: [], bookmarks, ...extra });

test('adds new IDs, refreshes existing posts and retains absent posts', () => {
  const base = snapshot(t1, [bm('1'), bm('2')]);
  const input = snapshot(t2, [bm('2', { full_text: 'Updated' }), bm('3')]);
  const result = merge(base, input);
  assert.deepEqual(result.data.bookmarks.map(b => b.tweet_id), ['1', '2', '3']);
  assert.equal(result.data.bookmarks[1].full_text, 'Updated');
  assert.deepEqual(result.summary, { added: 1, updated: 1, unchanged: 0, retained: 1 });
  assert.equal(base.bookmarks[1].full_text, 'Post 2');
  assert.equal(input.bookmarks[0]._archive, undefined, 'source objects stay untouched');
});

test('the same import is idempotent, including metadata', () => {
  const file = snapshot(t1, [bm('1'), bm('1'), bm('2')]);
  const first = merge(null, file).data;
  const again = merge(first, file);
  assert.equal(first.bookmarks.length, 2);
  assert.equal(again.changed, false);
  assert.deepEqual(again.data, first);
  assert.equal(again.summary.unchanged, 2);
});

test('a tombstone preserves text, media and last good content date', () => {
  const original = snapshot(t1, [bm('1', { media: [{ type: 'photo', url: 'https://example.com/a.jpg' }] })]);
  const gone = snapshot(t2, [bm('1', { status: 'unavailable', full_text: undefined, unavailable_reason: 'Deleted' })]);
  const record = merge(original, gone).data.bookmarks[0];
  assert.equal(record.full_text, 'Post 1');
  assert.equal(record.media.length, 1);
  assert.equal(record.status, 'unavailable');
  assert.equal(record._archive.content_updated_at, t1);
  assert.equal(record._archive.last_seen_at, t2);
});

test('older files recover missing history but cannot revert newer content', () => {
  const newest = merge(null, snapshot(t3, [bm('1', { full_text: 'Newest' })])).data;
  const result = merge(newest, snapshot(t1, [bm('1', { full_text: 'Old' }), bm('2')]));
  assert.equal(result.data.bookmarks[0].full_text, 'Newest');
  assert.equal(result.data.bookmarks[0]._archive.first_seen_at, t1);
  assert.equal(result.data.bookmarks[0]._archive.last_seen_at, t3);
  assert.equal(result.data.bookmarks.length, 2);
});

test('older rich data can recover a tombstone without changing its availability', () => {
  const newest = snapshot(t3, [bm('1', { status: 'unavailable', full_text: undefined })]);
  const result = merge(newest, snapshot(t1, [bm('1')]));
  assert.equal(result.data.bookmarks[0].full_text, 'Post 1');
  assert.equal(result.data.bookmarks[0].status, 'unavailable');
});

test('partial and legacy imports preserve missing folder assignments', () => {
  const base = snapshot(t1, [bm('1', { folders: ['Old'], folder_ids: ['a'] })], { folders: [{ id: 'a', name: 'Old' }] });
  for (const collection of [undefined, { bookmarks: 'partial', folders: 'partial' }, { mode: 'quick', bookmarks: 'partial', folders: 'unknown' }]) {
    const incoming = snapshot(t2, [bm('1')]);
    incoming.export_metadata.collection = collection;
    assert.deepEqual(merge(base, incoming).data.bookmarks[0].folders, ['Old']);
  }
});

test('complete folder checks replace membership and stable IDs handle renames', () => {
  const base = snapshot(t1, [bm('1', { folders: ['Old'], folder_ids: ['a'] }), bm('2', { folders: ['Old'], folder_ids: ['a'] })], { folders: [{ id: 'a', name: 'Old' }] });
  const incoming = snapshot(t2, [bm('1', { folders: ['Renamed'], folder_ids: ['a'] }), bm('2')], { folders: [{ id: 'a', name: 'Renamed' }] });
  const result = merge(base, incoming).data;
  assert.equal(result.folders.length, 1);
  assert.deepEqual(result.bookmarks[0].folders, ['Renamed']);
  assert.deepEqual(result.bookmarks[1].folders, []);
  assert.deepEqual(merge(result, base).data.bookmarks[1].folders, []);
});

test('empty complete snapshots preserve history and advance full-refresh date', () => {
  const result = merge(snapshot(t1, [bm('1')]), snapshot(t2, [])).data;
  assert.equal(result.bookmarks.length, 1);
  assert.equal(result.archive_metadata.last_full_refresh_at, t2);
});

test('cumulative files preserve individual observation dates across round trips', () => {
  const cumulative = merge(snapshot(t1, [bm('1')]), snapshot(t3, [bm('2')])).data;
  const result = merge(cumulative, snapshot(t2, [bm('1', { full_text: 'Intermediate update' })])).data;
  assert.equal(result.bookmarks[0].full_text, 'Intermediate update');
  assert.equal(result.bookmarks[0]._archive.last_seen_at, t2);
  assert.equal(merge(null, result).data.bookmarks[0]._archive.last_seen_at, t2);
});

test('different or unidentified accounts cannot merge', () => {
  const base = snapshot(t1, [bm('1')]);
  const other = snapshot(t2, [bm('2')]);
  other.export_metadata.user_id = '43';
  assert.throws(() => merge(base, other), /different X accounts/);
  other.export_metadata.user_id = 'unknown';
  assert.throws(() => merge(base, other), /account ID is missing/);
  assert.equal(merge(null, other).data.bookmarks.length, 1, 'unknown archives can open independently');
});

test('missing dates cannot overwrite dated observations', () => {
  const result = merge(snapshot(t1, [bm('1')]), snapshot(undefined, [bm('1', { full_text: 'Undated' })])).data;
  assert.equal(result.bookmarks[0].full_text, 'Post 1');
});

test('invalid files fail validation before storage and viewer helpers are stripped', () => {
  for (const invalid of [null, [], { bookmarks: {} }, snapshot(t1, [{ tweet_id: 12 }]), snapshot(t1, [bm('1', { folders: 'bad' })])]) assert.throws(() => validate(invalid));
  const data = merge(null, snapshot(t1, [bm('1', { _date: 'temporary', _searchText: 'temporary' })])).data;
  assert.equal(data.bookmarks[0]._searchText, undefined);
});

test('folder names colliding with prototype properties remain valid', () => {
  const result = merge(null, snapshot(t1, [bm('1', { folders: ['constructor', '__proto__'] })], { folders: [{ id: 'a', name: 'constructor' }, { id: 'b', name: '__proto__' }] })).data;
  assert.deepEqual(result.bookmarks[0].folder_ids, ['a', 'b']);
});

test('successful folders refresh independently while failed folders keep assignments', () => {
  const folders = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const base = snapshot(t1, [bm('1', { folders: ['A', 'B'], folder_ids: ['a', 'b'] })], { folders });
  const partial = snapshot(t3, [bm('1')], { folders });
  partial.export_metadata.collection.folders = 'partial';
  partial.export_metadata.collection.folder_contents = { a: 'complete', b: 'partial' };
  const merged = merge(base, partial).data;
  assert.deepEqual(merged.bookmarks[0].folder_ids, ['b']);
  assert.equal(merged.archive_metadata.last_full_refresh_at, t1);
  const older = snapshot(t2, [bm('1', { folders: ['A', 'B'], folder_ids: ['a', 'b'] })], { folders });
  assert.deepEqual(merge(merged, older).data.bookmarks[0].folder_ids, ['b'], 'older full scans cannot undo a newer successful folder check');
  assert.deepEqual(merge(null, merged).data.bookmarks[0].folder_ids, ['b'], 'combined round trips retain folder checks');
  assert.equal(merge(merged, partial).changed, false);
});

test('quick updates do not claim a later folder observation', () => {
  const base = snapshot(t1, [bm('1', { folders: ['A'], folder_ids: ['a'] })], { folders: [{ id: 'a', name: 'A' }] });
  const quick = snapshot(t3, [bm('1')]);
  quick.export_metadata.collection = { mode: 'quick', bookmarks: 'partial', folders: 'unknown' };
  const result = merge(base, quick).data;
  assert.equal(result.bookmarks[0]._archive.folders_updated_at, t1);
  assert.deepEqual(result.bookmarks[0].folder_ids, ['a']);
});

test('partial profile fields cannot erase previously saved author details', () => {
  const old = snapshot(t1, [bm('1', { author: { name: 'Saved author', screen_name: 'saved', verified: true } })]);
  const incoming = snapshot(t2, [bm('1', { author: { name: null, screen_name: null, verified: false } })]);
  const result = merge(old, incoming).data.bookmarks[0];
  assert.equal(result.author.name, 'Saved author');
  assert.equal(result.author.screen_name, 'saved');
  assert.equal(result.author.verified, false);
});

test('a 30,000-bookmark archive merges a small update without duplicates', () => {
  const base = snapshot(t1, Array.from({ length: 30_000 }, (_, i) => bm(String(i))));
  const delta = snapshot(t2, [bm('0', { full_text: 'Refreshed' }), bm('30000')]);
  delta.export_metadata.collection = { mode: 'quick', bookmarks: 'partial', folders: 'unknown' };
  const result = merge(base, delta);
  assert.equal(result.data.bookmarks.length, 30_001);
  assert.equal(result.summary.added, 1);
  assert.equal(result.summary.updated, 1);
  assert.equal(result.summary.retained, 29_999);
  assert.equal(merge(result.data, delta).changed, false);
});

test('content recovery uses its own date without reverting later unavailability', () => {
  const base = merge(snapshot(t1, [bm('1')]), snapshot(t3, [bm('1', { status: 'unavailable', full_text: undefined })])).data;
  const edited = snapshot(t2, [bm('1', { full_text: 'Intermediate edit' })]);
  const recovered = merge(base, edited).data;
  assert.equal(recovered.bookmarks[0].full_text, 'Intermediate edit');
  assert.equal(recovered.bookmarks[0].status, 'unavailable');
  assert.equal(recovered.bookmarks[0]._archive.content_updated_at, t2);
  assert.equal(merge(snapshot(t1, [bm('1')]), recovered).data.bookmarks[0].full_text, 'Intermediate edit');
});

test('unknown dates survive combined round trips and allow older folder history', () => {
  const quick = snapshot(t3, [bm('1')]);
  quick.export_metadata.collection = { mode: 'quick', bookmarks: 'partial', folders: 'unknown' };
  const combined = merge(null, quick).data;
  assert.equal(merge(null, combined).data.bookmarks[0]._archive.folders_updated_at, null);
  const older = snapshot(t1, [bm('1', { folder_ids: ['a'], folders: ['A'] })], { folders: [{ id: 'a', name: 'A' }] });
  assert.deepEqual(merge(combined, older).data.bookmarks[0].folder_ids, ['a']);
  const undated = merge(null, snapshot(null, [bm('2')])).data;
  const mixed = merge(undated, quick).data;
  assert.equal(merge(null, mixed).data.bookmarks.find(b => b.tweet_id === '2')._archive.last_seen_at, null);
});

test('malformed nested fields and observation metadata fail validation', () => {
  for (const extra of [{ media: [null] }, { media: [{ variants: {} }] }, { metrics: { likes: '<img>' } }, { card: { type: [] } }, { entities: { mentions: [null] } }, { quoted_tweet: { author: { name: {} } } }, { _archive: { last_seen_at: 'not a date' } }, { _archive: { folder_checks: [{ id: 'f', present: 'false' }] } }]) {
    assert.throws(() => validate(snapshot(t1, [bm('1', extra)])));
  }
  const account = snapshot(t1, []);
  account.export_metadata.user_id = 9007199254740993;
  assert.throws(() => validate(account), /user_id/);
});

test('older sparse imports fill gaps without replacing newer profile information', () => {
  const base = snapshot(t3, [bm('1', { full_text: '', author: { name: 'New name' } })]);
  // The profile was observed recently even though text is unavailable.
  base.bookmarks[0]._archive = { last_seen_at: t3, content_updated_at: t3 };
  const old = snapshot(t1, [bm('1', { author: { name: 'Old name', screen_name: 'handle' } })]);
  const record = merge(base, old).data.bookmarks[0];
  assert.equal(record.full_text, 'Post 1');
  assert.equal(record.author.name, 'New name');
  assert.equal(record.author.screen_name, 'handle');
});
