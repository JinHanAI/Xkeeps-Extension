import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvent, operationId, summarizeEvents, errorClass, recordEvent } from '../lib/analytics.js';

test('analytics events include correlating operation IDs and controlled values', () => {
  const id = operationId();
  const started = buildEvent('archive_export_started', { source: 'likes', format: 'json', scope: 'cumulative', period: 'all', item_count: 50 }, id);
  const finished = buildEvent('archive_export_completed', { source: 'likes', format: 'json', scope: 'cumulative', period: 'all', item_count: 50, duration_ms: 300, result: 'success' }, id);
  assert.equal(started.operation_id, finished.operation_id);
  assert.equal(started.session_id, finished.session_id);
  assert.notEqual(started.event_id, finished.event_id);
  assert.equal(started.schema_version, 1);
  assert.deepEqual(summarizeEvents([started, finished]), { total: 2,
    counts: { archive_export_started: 1, archive_export_completed: 1 }, successful_exports: 1,
    successful_updates: 0, successful_imports: 0, successful_media_backups: 0, active_days: 1 });
});

test('analytics schema refuses content, identity, paths, unknown enums and invalid counts', () => {
  const base = { source: 'bookmarks', format: 'json' };
  for (const [key, value] of Object.entries({ account_id: '42', username: 'someone', text: 'private', search_term: 'private', url: 'https://x.com/1', path: '/Downloads/private.json', filename: 'private.json' })) {
    assert.throws(() => buildEvent('archive_export_started', { ...base, [key]: value }), /Disallowed/);
  }
  assert.throws(() => buildEvent('archive_export_started', { ...base, format: 'PDF' }), /Disallowed/);
  assert.throws(() => buildEvent('archive_export_started', { ...base, item_count: -1 }), /Invalid/);
  assert.throws(() => buildEvent('archive_export_started', { ...base, item_count: 1.5 }), /Invalid/);
  assert.throws(() => buildEvent('unknown_event'), /Unknown/);
});

test('error categorization returns only an allowlisted class and never raw text', () => {
  assert.equal(errorClass(new Error('USER_CANCELED /Downloads/secret.json')), 'download_cancelled');
  assert.equal(errorClass(new Error('HTTP 429 rate limit')), 'rate_limit');
  assert.equal(errorClass(new Error('private account data')), 'account_mismatch');
  assert.equal(errorClass(new Error('unexpected private error')), 'unknown');
});

test('telemetry storage failure never blocks the user action', async () => {
  assert.equal(await recordEvent('page_viewed', { page: 'home' }), null);
});

test('media package outcomes remain analyzable without recording local paths', () => {
  const attributes = { source: 'bookmarks', result: 'partial', package_count: 3,
    complete_media_count: 10, failed_media_count: 2, duration_ms: 5000 };
  const event = buildEvent('media_backup_completed', attributes);
  for (const [key, value] of Object.entries(attributes)) assert.equal(event[key], value);
  assert.throws(() => buildEvent('media_backup_completed', { ...attributes, saved_path: '/private/file' }), /Disallowed/);
});


test('browse files, individual media and connection refresh use private-data-free outcomes', () => {
  for (const [name, details] of [
    ['browse_archive_opened', { source: 'likes', origin: 'file', item_count: 1 }],
    ['browse_media_download_completed', { source: 'bookmarks', media_type: 'video', result: 'success', actual_bytes: 100, duration_ms: 50 }],
    ['connection_refresh_completed', { result: 'error', duration_ms: 50, error_class: 'network' }],
  ]) {
    assert.equal(buildEvent(name, details).event_name, name);
    for (const field of ['filename', 'path', 'account_id', 'url']) assert.throws(() => buildEvent(name, { ...details, [field]: 'private' }), /Disallowed/);
  }
});

test('video playback telemetry is distinct from downloading and cannot retain URLs', () => {
  assert.equal(buildEvent('browse_video_preview_started', {source:'bookmarks'}).event_name, 'browse_video_preview_started');
  assert.equal(buildEvent('browse_video_preview_result', {source:'likes',result:'success'}).result,'success');
  assert.throws(()=>buildEvent('browse_video_preview_result',{source:'likes',result:'error',url:'https://video.twimg.com/example.mp4'}), /Disallowed analytics field/);
});
