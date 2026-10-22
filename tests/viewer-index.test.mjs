import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Initialization needs a browser. The index-building code can run in a small
// VM context, which keeps this regression test dependency-free.
const viewerCode = readFileSync(new URL('../viewer.js', import.meta.url), 'utf8').replace(/\/\/ ---- Start ----[\s\S]*$/, '');

function createViewerContext({ extensionId = null } = {}) {
  const element = {
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    value: '',
  };
  const context = vm.createContext({
    clearTimeout() {},
    console,
    document: {
      activeElement: null,
      addEventListener() {},
      getElementById() { return element; },
      createElement() { return { style: {}, dataset: {}, querySelector() { return null; }, querySelectorAll() { return []; } }; },
    },
    navigator: { userAgent: 'node-test' },
    chrome: extensionId ? { runtime: { id: extensionId } } : undefined,
    setTimeout() { return 0; },
    URL,
    window: { location: { href: 'file:///viewer.html', protocol: 'file:' } },
  });

  vm.runInContext(readFileSync(new URL('../lib/archive.js', import.meta.url), 'utf8'), context);
  vm.runInContext(readFileSync(new URL('../lib/search-index.js', import.meta.url), 'utf8'), context);
  const storeNames = [];
  context.storeNames = storeNames;
  context.XArchive.ArchiveStore = class { constructor(name) { storeNames.push(name); } };
  vm.runInContext(viewerCode, context);
  vm.runInContext(`
    sleep = async () => {};
    renderFolders = () => {};
    renderTags = () => {};
    applyFilters = () => {};
  `, context);
  return context;
}

async function processData(context, data) {
  context.testData = data;
  await vm.runInContext('processData(testData)', context);
  delete context.testData;
}

function snapshotIndices(context) {
  return JSON.parse(vm.runInContext(`JSON.stringify({
    constructorFolder: folderMap.get('constructor'),
    protoFolder: folderMap.get('__proto__'),
    toStringFolder: folderMap.get('toString'),
    constructorSearch: Array.from(searchBookmarks('constructor')),
    protoSearch: Array.from(searchBookmarks('__proto__')),
    ordinarySearch: Array.from(searchBookmarks('ordinary')),
  })`, context));
}

test('viewer indexes names that collide with Object prototype properties', async () => {
  const context = createViewerContext();
  await processData(context, {
    folders: [
      { name: 'constructor' },
      { name: '__proto__' },
      { name: 'toString' },
    ],
    bookmarks: [
      {
        created_at: '2026-04-29T00:00:00.000Z',
        folders: ['constructor', '__proto__', 'toString'],
        full_text: 'constructor __proto__ ordinary',
      },
    ],
  });

  assert.deepEqual(snapshotIndices(context), {
    constructorFolder: [0],
    protoFolder: [0],
    toStringFolder: [0],
    constructorSearch: [0],
    protoSearch: [0],
    ordinarySearch: [0],
  });
});

test('extension viewer uses a separate archive database from the collection page', () => {
  const context = createViewerContext({ extensionId: 'synthetic-extension-id' });
  assert.deepEqual(Array.from(context.storeNames), ['xarchive-viewer-library']);
});

test('viewer handles a colliding token late in a 30,000-bookmark export', async () => {
  const context = createViewerContext();
  const bookmarks = Array.from({ length: 30_000 }, (_, index) => ({
    created_at: '2026-04-29T00:00:00.000Z',
    full_text: index === 29_999
      ? `bookmark ${index} constructor __proto__`
      : `bookmark ${index}`,
  }));

  await processData(context, { folders: [], bookmarks });

  const result = JSON.parse(vm.runInContext(`JSON.stringify({
    constructor: Array.from(searchBookmarks('constructor')),
    proto: Array.from(searchBookmarks('__proto__')),
  })`, context));

  assert.deepEqual(result, { constructor: [29_999], proto: [29_999] });
});

test('retrying after a failed load starts with fresh indices', async () => {
  const context = createViewerContext();
  await processData(context, {
    folders: [],
    bookmarks: [{ created_at: '2026-04-29T00:00:00.000Z', full_text: 'firstonly' }],
  });
  await processData(context, {
    folders: [],
    bookmarks: [{ created_at: '2026-04-30T00:00:00.000Z', full_text: 'secondonly' }],
  });

  const result = JSON.parse(vm.runInContext(`JSON.stringify({
    first: Array.from(searchBookmarks('firstonly')),
    second: Array.from(searchBookmarks('secondonly')),
  })`, context));

  assert.deepEqual(result, { first: [], second: [0] });
});

test('folder IDs keep duplicate names separate, including the old unfiled sentinel', async () => {
  const context = createViewerContext();
  await processData(context, { folders: [{ id: 'a', name: 'Same' }, { id: '__unfiled__', name: 'Same' }], bookmarks: [{ full_text: 'one', folder_ids: ['a'], folders: ['Same'] }, { full_text: 'two', folder_ids: ['__unfiled__'], folders: ['Same'] }] });
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify([...folderMap])', context)), [['a', [0]], ['__unfiled__', [1]]]);
});

test('search includes expanded URLs and non-Latin text', async () => {
  const context = createViewerContext();
  await processData(context, { bookmarks: [{ full_text: '日本語 café', entities: { urls: [{ expanded_url: 'https://example.org/research' }] } }] });
  for (const query of ['日本語', 'café', 'research']) assert.deepEqual(Array.from(vm.runInContext(`searchBookmarks(${JSON.stringify(query)})`, context)), [0]);
});

test('untrusted URLs and display text cannot inject attributes or executable links', () => {
  const context = createViewerContext();
  context.input = { tweet_id: '1" onclick="alert(1)', full_text: 'https://t.co/link <img src=x onerror=alert(1)> @name #tag', author: { name: "'", profile_image_url: 'javascript:alert(1)' }, entities: { urls: [{ url: 'https://t.co/link', expanded_url: 'javascript:alert(1)', display_url: '"<svg onload=alert(1)>' }] }, metrics: { likes: '<img onerror=alert(1)>' } };
  const html = vm.runInContext('createTweetElement(input, 0, 0).innerHTML', context);
  assert.doesNotMatch(html, /href="javascript:|src="javascript:| onclick=|<img|<svg onload=/);
  assert.match(html, /&lt;img/);
  assert.match(html, /%22%20onclick%3D%22/);
  assert.equal(vm.runInContext("safeUrl('file:///private.txt')", context), '');
  assert.equal(vm.runInContext("safeUrl('data:text/html,test')", context), '');
});

test('viewer retains Chinese text, author identity, emoji and safe avatar URLs', () => {
  const context = createViewerContext();
  context.input = {
    tweet_id: '88', full_text: '中文正文 ✨ long-form ✅', in_reply_to_tweet_id: '77',
    entities: { mentions: [{ screen_name: 'helper' }] },
    author: { name: '作者✨', screen_name: 'writer', user_id: '123', profile_image_url: 'https://pbs.twimg.com/avatar.jpg' },
  };
  const html = vm.runInContext('createTweetElement(input, 0, 0).innerHTML', context);
  assert.match(html, /作者✨/);
  assert.match(html, /@writer/);
  assert.match(html, /https:\/\/pbs\.twimg\.com\/avatar\.jpg/);
  assert.match(html, /中文正文 ✨ long-form ✅/);
  assert.match(html, /回复给 <a/);
  assert.doesNotMatch(html, /Replying to/);
});

test('linkification does not rewrite URL fragments or escaped HTML entities', () => {
  const context = createViewerContext();
  context.input = { full_text: 'https://example.org/a#fragment?a=1&b=2 <tag> @name' };
  vm.runInContext("searchQuery = 'tag'", context);
  const html = vm.runInContext('renderTweetText(input)', context);
  assert.match(html, /href="https:\/\/example.org\/a#fragment\?a=1&amp;b=2"/);
  assert.match(html, /&lt;<mark>tag<\/mark>&gt;/);
  assert.doesNotMatch(html, /href="[^\"]*<a/);
});
