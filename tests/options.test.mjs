import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as updateStatus from '../lib/update-status.js';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const code = read('options.js').replace(/^import[\s\S]*?;\s*$/gm, '').replace(/\ninit\(\)\.catch[\s\S]*$/, '');

function setup() {
  const elements = new Map();
  const handlers = new Map();
  let openedUrl = null;
  let navigation = null;
  const element = id => {
    if (!elements.has(id)) {
      const attributes = new Map();
      const el = { style: {}, value: 'full', textContent: '', dataset: {}, className: '', querySelector: () => ({ disabled: false }), addEventListener(type, handler) { handlers.set(`${id}:${type}`, handler); }, dispatchEvent(event) { handlers.get(`${id}:${event.type}`)?.call(this, event); return true; }, appendChild() {}, replaceChildren() {}, setAttribute(name, value) { attributes.set(name, value); }, getAttribute(name) { return attributes.get(name) ?? null; } };
      el.classList = { add() {}, remove() {}, contains(name) { return el.className.split(/\s+/).includes(name); } };
      elements.set(id, el);
    }
    return elements.get(id);
  };
  let session = '42';
  const records = new Map(['42', '43'].map(id => [`user:${id}`, { key: `user:${id}`, revision: 1, data: { export_metadata: { user_id: id }, bookmarks: [{ tweet_id: id }] } }]));
  const store = { get: async key => records.get(key) };
  const context = vm.createContext({ ...updateStatus, console, setTimeout, clearTimeout, setInterval, clearInterval,
    sessionStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ matches: true }),
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    dispatchEvent: event => { navigation = event.detail?.page || (event.type === 'xkeeps:open-browse' ? `browse:${event.detail.source}` : null); },
    document: { getElementById: element, createElement: () => ({}) },
    navigator: { locks: { request: async (name, options, fn) => fn(null) } },
    chrome: { storage: { local: { get: async key => ({ [key]: `handle_${session}` }) } }, runtime: { getURL: path => `chrome-extension://test/${path}` }, tabs: { create: ({ url }) => { openedUrl = url; } } },
    getCredentials: async () => ({ userId: session, creds: {} }), getFreshCt0: async () => 'csrf',
    getStoredQueryIds: () => ({}), hasRequiredQueryIds: () => false,
    getExportState: () => { throw new Error('staging read without lock'); },
  });
  context.window = { addEventListener() {} };
  vm.runInContext(read('lib/archive.js'), context);
  context.XArchive.ArchiveStore = class { constructor() { return store; } };
  vm.runInContext(code, context);
  return { context, store, records, element, selectSession: id => { session = id; }, openViewer: () => handlers.get('btn-viewer:click')(), openedUrl: () => openedUrl,
    clickGoHome: () => handlers.get('connection-go-home:click')(), toggleLog: () => handlers.get('log-toggle:click')(), navigation: () => navigation };
}

test('finished scan replaces progress with results and folds successful activity log', () => {
  const { context, element, toggleLog } = setup();
  context.setUIState('exporting');
  assert.equal(element('progress-section').style.display, '');
  assert.equal(element('result-section').style.display, 'none');
  context.setUIState('complete');
  assert.equal(element('progress-section').style.display, 'none');
  assert.equal(element('result-section').style.display, '');
  assert.equal(element('log').hidden, true);
  assert.equal(element('log-toggle').getAttribute('aria-expanded'), 'false');
  toggleLog();
  assert.equal(element('log').hidden, false);
  assert.equal(element('log').style.maxHeight, 'none');
  context.setUIState('stopped');
  assert.equal(element('log').hidden, false);
});

test('completed incremental results show persisted archive changes, not the scanned count', async () => {
  const { context, element } = setup();
  await context.checkCredentials();
  context.getAllBookmarks = async () => Array.from({ length: 197 }, (_, i) => ({ tweet_id: String(i), status: 'available' }));
  context.getAllFolders = async () => [];
  vm.runInContext(`runInfo = { user_id: '42', screen_name: 'test', archive_merged: true,
    duration_seconds: 7, finished_at: '2026-10-01T00:00:00Z', collection: { mode: 'quick', reason: 'quick_boundary' },
    update_summary: { before_count: 1630, after_count: 1631, added: 1, updated: 196,
      before_at: '2026-09-30T00:00:00Z', finished_at: '2026-10-01T00:00:00Z' } };`, context);
  await context.showResult('stopped');
  assert.equal(element('result-before').textContent, '1,630');
  assert.equal(element('result-after').textContent, '1,631');
  assert.equal(element('result-changes').textContent, '新增内容 1 条 · 更新已有 196 条');
  assert.equal(element('result-observations').hidden, true);
  assert.equal(element('result-duration').textContent, '0:07');
  assert.equal(element('btn-recover').hidden, true);
  assert.equal(element('export-range').value, 'snapshot');
  element('export-range').value = 'cumulative';
  vm.runInContext('libraryRecord.data.bookmarks.push({ tweet_id: "later" })', context);
  await context.showResult('stopped');
  assert.equal(element('result-after').textContent, '1,631');
  assert.equal(element('export-range').value, 'cumulative');
  vm.runInContext("runInfo.finished_at = '2026-10-02T00:00:00Z'", context);
  await context.showResult('stopped');
  assert.equal(element('export-range').value, 'snapshot');
  element('export-range').value = 'cumulative';
  vm.runInContext("runInfo.finished_at = '2026-10-03T00:00:00Z'", context);
  vm.runInContext('runInfo.collection = { mode: "full", reason: "complete", bookmarks: "complete", folders: "partial" }', context);
  await context.showResult('complete');
  assert.equal(element('result-coverage').hidden, false);
  assert.equal(element('log').hidden, false);
  assert.equal(element('export-range').value, 'cumulative');
});

test('connection checklist completes only when all three checks are ready and returns home', async () => {
  const { context, element, clickGoHome, navigation } = setup();
  await context.checkCredentials();
  assert.equal(element('connection-ready').hidden, true);
  context.getCredentials = async () => ({ userId: '42', creds: { authorization: 'synthetic' } });
  context.getStoredQueryIds = () => ({ Bookmarks: 'synthetic' });
  context.hasRequiredQueryIds = () => true;
  await context.checkCredentials();
  for (const id of ['cred-check', 'queryid-check', 'user-check']) assert.equal(element(id).hidden, false);
  assert.equal(element('connection-ready').hidden, false);
  clickGoHome();
  assert.equal(navigation(), 'home');
});

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

test('a staged snapshot for another account is not rendered', async () => {
  const { context, element } = setup();
  await context.checkCredentials();
  context.navigator.locks.request = async (_name, _options, fn) => fn({});
  context.getExportState = async () => ({ user_id: '43', started_at: '2026-09-29T00:00:00Z' });
  context.getBookmarkCount = async () => 2;
  await context.checkPriorExport();
  assert.equal(element('result-section').style.display, 'none');
  assert.equal(vm.runInContext('stagedSnapshotAvailable', context), false);
});

test('the saved-records entry opens the browse page for bookmarks', () => {
  const { openViewer, navigation } = setup();
  openViewer();
  assert.equal(navigation(), 'browse:bookmarks');
});

test('runtime collection logs and query operations are localized for users', () => {
  const { context } = setup();
  assert.equal(context.logTextZh('Found 1 bookmark folder(s).'), '发现 1 个收藏文件夹。');
  assert.equal(context.logTextZh('Fetching folder "Read later" (1/1)...'), '正在检查文件夹“Read later”（1/1）…');
  assert.equal(context.logTextZh('Page 1: 2 bookmarks (total: 2)'), '第 1 页：本页 2 条书签，累计 2 条。');
  assert.equal(context.formatQueryOperations({ Bookmarks: 'id', BookmarkFoldersSlice: 'id' }), '书签列表、收藏夹列表');
});
