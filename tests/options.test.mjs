import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const code = read('options.js').replace(/^import[\s\S]*?;\s*$/gm, '').replace(/\ninit\(\)\.catch[\s\S]*$/, '');

function setup() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, value: 'full', textContent: '', classList: { add() {}, remove() {} }, querySelector: () => ({}), addEventListener() {}, appendChild() {} });
    return elements.get(id);
  };
  let session = '42';
  const records = new Map(['42', '43'].map(id => [`user:${id}`, { key: `user:${id}`, revision: 1, data: { export_metadata: { user_id: id }, bookmarks: [{ tweet_id: id }] } }]));
  const store = { get: async key => records.get(key) };
  const context = vm.createContext({ console, setTimeout, clearTimeout, setInterval, clearInterval,
    document: { getElementById: element, createElement: () => ({}) },
    navigator: { locks: { request: async (name, options, fn) => fn(null) } },
    chrome: { storage: { local: { get: async key => ({ [key]: `handle_${session}` }) } } },
    getCredentials: async () => ({ userId: session, creds: {} }), getFreshCt0: async () => 'csrf',
    getStoredQueryIds: () => ({}), hasRequiredQueryIds: () => false,
    getExportState: () => { throw new Error('staging read without lock'); },
  });
  vm.runInContext(read('lib/archive.js'), context);
  context.XArchive.ArchiveStore = class { constructor() { return store; } };
  vm.runInContext(code, context);
  return { context, store, records, element, selectSession: id => { session = id; } };
}

test('refreshing credentials switches the archive and undo target together', async () => {
  const { context, selectSession } = setup();
  await context.checkCredentials();
  assert.equal(vm.runInContext('libraryRecord.key', context), 'user:42');
  selectSession('43');
  await context.checkCredentials();
  assert.equal(vm.runInContext('libraryRecord.key', context), 'user:43');
  assert.equal(vm.runInContext('currentUserId', context), '43');
});

test('an older asynchronous archive read cannot replace the newly selected account', async () => {
  const { context, store, records, selectSession } = setup();
  await context.checkCredentials();
  let release;
  store.get = key => key === 'user:42' ? new Promise(resolve => { release = () => resolve(records.get(key)); }) : Promise.resolve(records.get(key));
  const olderRead = context.loadLibrary();
  selectSession('43');
  await context.checkCredentials();
  release();
  await olderRead;
  assert.equal(vm.runInContext('libraryRecord.key', context), 'user:43');
});

test('opening a second extension tab cannot inspect or relabel active staging', async () => {
  const { context } = setup();
  await context.checkPriorExport();
  assert.equal(vm.runInContext('runInfo', context), null);
});
