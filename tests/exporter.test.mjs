import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const code = readFileSync(new URL('../lib/exporter.js', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');

test('snapshots preserve scan identity, time, folder IDs and incomplete coverage', async () => {
  const run = { user_id: '42', screen_name: 'original', finished_at: '2026-09-01T00:00:00.000Z', collection: { mode: 'full', bookmarks: 'complete', folders: 'partial', folder_contents: { f1: 'partial' } } };
  const context = vm.createContext({
    VERSION: 'test', getExportState: async () => run,
    getAllBookmarks: async () => [{ tweet_id: '1', status: 'available', folders: [] }],
    getAllFolders: async () => [{ id: 'f1', name: 'Reading' }],
    buildFolderMap: async () => new Map([['1', ['f1']]]),
  });
  vm.runInContext(code, context);
  const snapshot = await context.assembleExport({ userId: 'different-account', screenName: 'different', durationSeconds: 7 });
  assert.equal(snapshot.export_metadata.user_id, '42');
  assert.equal(snapshot.export_metadata.screen_name, 'original');
  assert.equal(snapshot.export_metadata.exported_at, run.finished_at);
  assert.equal(snapshot.export_metadata.kind, 'snapshot');
  assert.equal(snapshot.export_metadata.schema_version, 2);
  assert.equal(snapshot.export_metadata.collection.folders, 'partial');
  assert.equal(snapshot.bookmarks[0].folder_ids[0], 'f1');
  assert.equal(snapshot.bookmarks[0].folders[0], 'Reading');
});

test('combined downloads use a safe filename and keep the JSON content', async () => {
  let downloaded, blob;
  const data = { export_metadata: { kind: 'cumulative' }, bookmarks: [{ tweet_id: '1', full_text: 'text\u2028text' }] };
  const context = vm.createContext({ VERSION: 'test', Blob, setTimeout() {},
    URL: { createObjectURL: value => { blob = value; return 'blob:test'; }, revokeObjectURL() {} },
    chrome: { downloads: { download: (options, callback) => { downloaded = options; callback(); } } },
  });
  vm.runInContext(code, context);
  const name = await context.downloadJSON(data, '../account');
  assert.match(name, /^xarchive____account_\d{4}-\d{2}-\d{2}_combined\.json$/);
  assert.equal(downloaded.saveAs, true);
  assert.deepEqual(JSON.parse(await blob.text()), data);
});

test('Chrome download failures are surfaced instead of reporting success', async () => {
  const context = vm.createContext({ VERSION: 'test', Blob, setTimeout() {}, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} }, chrome: { runtime: { lastError: { message: 'User canceled' } }, downloads: { download: (options, callback) => callback() } } });
  vm.runInContext(code, context);
  await assert.rejects(context.downloadJSON({ bookmarks: [] }, 'account'), /User canceled/);
});

test('a staged account with no captured handle cannot borrow another account label', async () => {
  const context = vm.createContext({ VERSION: 'test', getExportState: async () => ({ user_id: '42', screen_name: null }), getAllBookmarks: async () => [], getAllFolders: async () => [], buildFolderMap: async () => new Map() });
  vm.runInContext(code, context);
  const result = await context.assembleExport({ userId: '43', screenName: 'other' });
  assert.equal(result.export_metadata.user_id, '42');
  assert.equal(result.export_metadata.screen_name, null);
  assert.equal(result.export_metadata.exported_at, null);
});
