import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadBlob } from '../lib/downloads.js';

async function withFakeChrome(config, run) {
  const previousChrome = globalThis.chrome;
  const previousTimeout = globalThis.setTimeout;
  const previousClear = globalThis.clearTimeout;
  let listener;
  const downloads = {
    onChanged: { addListener(fn) { listener = fn; }, removeListener(fn) { if (listener === fn) listener = null; } },
    download(options, callback) {
      config.download?.(options, callback, delta => listener?.(delta));
    },
    search(query, callback) { config.search?.(query, callback); },
  };
  globalThis.chrome = { downloads, runtime: { lastError: config.lastError || null } };
  // Avoid real 60-second object-URL cleanup timers in these focused tests.
  globalThis.setTimeout = () => ({ fakeTimer: true });
  globalThis.clearTimeout = () => {};
  try { return await run(); }
  finally {
    globalThis.chrome = previousChrome;
    globalThis.setTimeout = previousTimeout;
    globalThis.clearTimeout = previousClear;
  }
}

test('download resolves only after Chrome reports complete', async () => {
  await withFakeChrome({
    download(_options, callback, emit) { callback(7); queueMicrotask(() => emit({ id: 7, state: { current: 'complete' } })); },
    search(_query, callback) { callback([{ id: 7, state: 'in_progress' }]); },
  }, async () => {
    const result = await downloadBlob(new Blob(['ok']), 'archive.csv');
    assert.deepEqual(result, { filename: 'archive.csv', downloadId: 7, state: 'complete' });
  });
});

test('download rejects when the user cancels or Chrome interrupts the file', async () => {
  await withFakeChrome({
    download(_options, callback, emit) { callback(8); queueMicrotask(() => emit({ id: 8, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } })); },
    search(_query, callback) { callback([{ id: 8, state: 'in_progress' }]); },
  }, async () => assert.rejects(downloadBlob(new Blob(['x']), 'cancelled.json'), /USER_CANCELED/));

});

test('download surfaces a synchronous Chrome rejection', async () => {
  await withFakeChrome({ lastError: { message: 'USER_CANCELED' }, download(_options, callback) { callback(undefined); } }, async () => {
    await assert.rejects(downloadBlob(new Blob(['x']), 'cancelled.csv'), /USER_CANCELED/);
  });
});

test('only a completed, account-scoped export records its chosen path', async () => {
  await withFakeChrome({
    download(_options, callback, emit) { callback(11); queueMicrotask(() => emit({ id: 11, state: { current: 'complete' } })); },
    search(_query, callback) { callback([{ id: 11, state: 'complete', filename: '/Downloads/example.json' }]); },
  }, async () => {
    const records = [];
    chrome.storage = { local: { async set(value) { records.push(value); } } };
    await downloadBlob(new Blob(['ok']), 'example.json');
    assert.equal(records.length, 0);
    await downloadBlob(new Blob(['ok']), 'example.json', { userId: '42', source: 'bookmarks' });
    assert.equal(records.length, 1);
    assert.equal(records[0].xkeeps_last_download.userId, '42');
    assert.equal(records[0].xkeeps_last_download.source, 'bookmarks');
    assert.equal(records[0].xkeeps_last_download.path, '/Downloads/example.json');
  });
});


test('unrelated completed download cannot settle the selected file', async () => {
  let send, settled=false;
  await withFakeChrome({
    download(_o,callback,emit){send=emit;callback(19);},
    search(_q,callback){callback([{id:19,state:'in_progress'}]);},
  },async()=>{
    const pending=downloadBlob(new Blob(['chosen']),'selected.json').then(r=>{settled=true;return r;});
    send({id:999,state:{current:'complete'}}); await Promise.resolve();
    assert.equal(settled,false);send({id:19,state:{current:'complete'}});
    assert.equal((await pending).downloadId,19);
  });
});
test('completion emitted before ID callback is still correlated to that ID', async () => {
  await withFakeChrome({download(_o,callback,emit){emit({id:21,state:{current:'complete'}});callback(21);}},async()=>{
    assert.equal((await downloadBlob(new Blob(['ok']),'early.json')).downloadId,21);
  });
});
test('missing download ID and timeout never become completed receipts',async()=>{
  await withFakeChrome({download(_o,callback){callback(undefined);}},async()=>{
    await assert.rejects(downloadBlob(new Blob(['ok']),'missing.json'),/有效的下载任务/);
  });
  const timers=[];
  await withFakeChrome({download(_o,callback){callback(23);},search(_q,callback){callback([{id:23,state:'in_progress'}]);}},async()=>{
    globalThis.setTimeout=fn=>{timers.push(fn);return timers.length;};
    const pending=downloadBlob(new Blob(['ok']),'timeout.json');timers[0]();
    await assert.rejects(pending,/超时/);
  });
});
