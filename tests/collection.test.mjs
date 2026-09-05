import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { parseBookmarksPage, parseFolderList } from '../lib/parser.js';
import * as utils from '../lib/utils.js';

const source = file => readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8').replace(/^import[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const page = (ids, cursor = null) => ({ error: null, data: { data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
  ...ids.map(id => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: { rest_id: id, legacy: { full_text: `Post ${id}` } } } } } })),
  ...(cursor ? [{ entryId: 'cursor-bottom-1', content: { value: cursor } }] : []),
] }] } } } } });

function fetchContext(responses) {
  const stored = [], calls = [];
  const context = vm.createContext({ ...utils, waitForCollection: async () => {}, jitteredDelay: () => 0,
    parseBookmarksPage, parseFolderList,
    upsertBookmarks: async records => stored.push(...records),
    graphqlRequest: async (...args) => { calls.push(args); assert.ok(responses.length, 'unexpected extra request'); return responses.shift(); },
    upsertFolders: async () => {}, saveFolderPage: async tweets => stored.push(...tweets),
  });
  vm.runInContext(source('fetcher.js'), context);
  vm.runInContext(source('folders.js'), context);
  return { context, stored, calls };
}

test('full collection continues beyond known bookmarks and completes only at end', async () => {
  const { context, stored, calls } = fetchContext([page(['1'], 'a'), page(['2'])]);
  const result = await context.fetchAllBookmarks({ queryId: 'test' });
  assert.equal(result.reason, 'complete');
  assert.deepEqual(stored.map(b => b.tweet_id), ['1', '2']);
  assert.equal(calls.length, 2);
});

test('quick boundary requires an entire known page, which is still refreshed', async () => {
  const { context, stored, calls } = fetchContext([page(['3', '1'], 'a'), page(['1', '2'], 'b')]);
  const result = await context.fetchAllBookmarks({ knownIds: new Set(['1', '2']) });
  assert.equal(result.reason, 'quick_boundary');
  assert.equal(calls.length, 2);
  assert.deepEqual(stored.map(b => b.tweet_id), ['3', '1', '1', '2']);
});

test('unrecognized responses and looping cursors never claim complete', async () => {
  const bad = fetchContext([{ error: null, data: {} }]);
  assert.equal((await bad.context.fetchAllBookmarks({})).reason, 'unrecognized_response');
  assert.equal(bad.stored.length, 0);
  const loop = fetchContext([page(['1'], 'a'), page(['2'], 'b'), page(['3'], 'a')]);
  assert.equal((await loop.context.fetchAllBookmarks({})).reason, 'pagination_guard');
});

test('Stop while paused does not issue another request', async () => {
  const { context, calls } = fetchContext([]);
  let stopped = false;
  const result = await context.fetchAllBookmarks({ shouldStop: () => stopped, shouldPause: async () => { stopped = true; } });
  assert.equal(result.reason, 'user_stopped');
  assert.equal(calls.length, 0);
});

test('account changes during a request prevent storing its response', async () => {
  const { context, stored } = fetchContext([page(['1'])]);
  let checks = 0;
  await assert.rejects(context.fetchAllBookmarks({ beforeRequest: async () => { if (++checks === 2) throw new Error('account changed'); } }), /account changed/);
  assert.equal(stored.length, 0);
});

test('folder list errors and missing IDs have explicit incomplete results', async () => {
  const { context } = fetchContext([{ error: 'auth_error' }]);
  assert.equal((await context.fetchAllFolders({})).complete, false);
  const result = await context.fetchAllFolders({ queryId: 'test' });
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'auth_error');
});

test('folder list and per-folder contents report success separately', async () => {
  const list = { error: null, data: { data: { viewer: { user_results: { result: { bookmark_collections_slice: { items: [{ id: 'f1', name: 'Folder' }] } } } } } } };
  const { context } = fetchContext([list, page(['1'])]);
  const result = await context.fetchAllFolders({ queryId: 'test' });
  assert.equal(result.complete, true);
  const coverage = await context.fetchFolderContents({ folders: result.folders, queryId: 'test' });
  assert.equal(coverage.f1, 'complete');
});

test('a failed folder timeline reports partial coverage', async () => {
  const { context } = fetchContext([{ error: 'auth_error' }]);
  const coverage = await context.fetchFolderContents({ folders: [{ id: 'f1', name: 'Folder' }], queryId: 'test' });
  assert.equal(coverage.f1, 'partial');
});

test('Stop during backoff prevents another request, including folder lists', async () => {
  for (const method of ['fetchAllBookmarks', 'fetchFolderBookmarks', 'fetchAllFolders']) {
    const { context, calls } = fetchContext([{ error: 'rate_limited' }]);
    let stopped = false;
    context.waitForCollection = async () => { stopped = true; };
    const result = await context[method]({ queryId: 'test', shouldStop: () => stopped });
    assert.equal(result.reason, 'user_stopped');
    assert.equal(calls.length, 1);
  }
});

test('Pause is respected between retry attempts', async () => {
  const { context, calls } = fetchContext([{ error: 'rate_limited' }, page(['1'])]);
  let waiting = false, release;
  context.waitForCollection = async () => { waiting = true; };
  const run = context.fetchAllBookmarks({ shouldPause: async () => { if (waiting) await new Promise(r => { release = r; }); } });
  while (!release) await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1);
  release();
  assert.equal((await run).reason, 'complete');
});

test('folder pages survive a later account-check failure', async () => {
  const { context, stored } = fetchContext([page(['1'], 'a'), page(['2'])]);
  let checks = 0;
  await assert.rejects(context.fetchFolderContents({ folders: [{ id: 'f', name: 'Folder' }], queryId: 'test', beforeRequest: async () => { if (++checks === 4) throw new Error('account changed'); } }), /account changed/);
  assert.deepEqual(stored.map(b => b.tweet_id), ['1']);
});

test('invalid query requests stop without repeating identical failures', async () => {
  const { context, calls } = fetchContext([{ error: 'http_error', status: 422 }]);
  assert.equal((await context.fetchAllBookmarks({})).reason, 'query_error');
  assert.equal(calls.length, 1);
});
