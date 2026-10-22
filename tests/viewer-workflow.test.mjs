import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const base = JSON.parse(read('fixtures/base.json'));
const update = JSON.parse(read('fixtures/update.json'));

function setup({ renderFailure = false, saveFailure = false } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', disabled: false, value: '', replaceChildren() {}, appendChild() {}, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  let writes = 0, renders = 0;
  const context = vm.createContext({ console, URL, setTimeout, crypto, archiveBusy: false, importIntent: 'update', pendingImport: null,
    document: { getElementById: element, createElement: () => ({}) },
    setStatus() {}, showError() {}, showFilePicker() {},
    processData: async () => { if (renderFailure && renders++ === 0) throw new Error('index failed'); },
  });
  vm.runInContext(read('../lib/archive.js'), context);
  context.archiveRecord = { key: 'user:42', revision: 1, data: context.XArchive.merge(null, base).data, previous: null };
  context.archiveStore = {
    list: async () => [],
    save: async (key, data, revision) => { writes++; if (saveFailure) throw new Error('quota exceeded'); return { key, data, previous: context.archiveRecord.data, revision: revision + 1 }; },
    undo: async () => { throw new Error('stale revision'); },
  };
  vm.runInContext(read('../lib/viewer-workflow.js'), context);
  return { context, element, writes: () => writes };
}

test('a File import is reviewed before any write, then saves a cumulative archive', async () => {
  const { context, element, writes } = setup();
  await context.loadFromFile(new File([JSON.stringify(update)], 'update.json', { type: 'application/json' }));
  assert.equal(writes(), 0);
  assert.equal(element('import-review').open, true);
  assert.match(element('import-summary').textContent, /新增内容 1 条.*更新已有 1 条.*保留内容 1 条/);
  await context.saveImport();
  assert.equal(writes(), 1);
  assert.equal(context.archiveRecord.data.bookmarks.length, 3);
  assert.equal(context.archiveRecord.previous.bookmarks.length, 2);
  assert.equal(element('import-review').open, false);
});

test('malformed File import leaves the existing archive unchanged', async () => {
  const { context, element, writes } = setup();
  await context.loadFromFile(new File(['{broken'], 'broken.json'));
  assert.equal(writes(), 0);
  assert.equal(context.archiveRecord.data.bookmarks.length, 2);
  assert.match(element('archive-status').textContent, /无法导入/);
});

test('indexing failures cannot replace the saved data', async () => {
  const { context, element, writes } = setup({ renderFailure: true });
  await context.loadFromFile(new File([JSON.stringify(update)], 'update.json'));
  await context.saveImport();
  assert.equal(writes(), 0);
  assert.equal(context.archiveRecord.data.bookmarks.length, 2);
  assert.match(element('import-error').textContent, /搜索索引未能重建/);
});

test('storage failures restore the previous view and report unsaved changes', async () => {
  const { context, element } = setup({ saveFailure: true });
  await context.loadFromFile(new File([JSON.stringify(update)], 'update.json'));
  await context.saveImport();
  assert.equal(context.archiveRecord.data.bookmarks.length, 2);
  assert.match(element('import-error').textContent, /存储空间不足/);
  assert.equal(element('import-review').open, true);
});

test('undo uses the same explicit review and fails safely on a stale revision', async () => {
  const { context, element } = setup();
  context.archiveRecord.previous = context.archiveRecord.data;
  await context.undoArchive();
  assert.equal(element('import-review').open, true);
  assert.match(element('import-title').textContent, /恢复存档/);
  await context.saveImport();
  assert.match(element('import-error').textContent, /其他页面发生变化/);
  assert.equal(context.archiveRecord.data.bookmarks.length, 2);
});
