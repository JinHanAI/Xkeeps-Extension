import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ setTimeout, Promise });
vm.runInContext(readFileSync(new URL('../lib/search-index.js', import.meta.url), 'utf8'), context);
const { createIndex, createIndexAsync } = context.XKeepsSearch;

test('local search covers body, names, URLs, Chinese and emoji-adjacent text', () => {
  const items = [
    { full_text: '知识整理 ✨', author: { name: '测试作者', screen_name: 'DemoAuthor' }, entities: { urls: [{ expanded_url: 'https://example.com/article' }] } },
    { full_text: 'independent note', author: { name: 'Other' } },
  ];
  const index = createIndex(items);
  for (const query of ['知识', '测试作者', 'demoa', 'article']) assert.deepEqual([...index.search(query)], [0]);
  assert.deepEqual([...index.search('other')], [1]);
  assert.deepEqual([...index.search('知识 other')], []);
  assert.deepEqual([...index.search('✨')], [0]);
  assert.deepEqual([...index.search('知')], [0]);
});

test('30,000 items can be indexed in batches and a late match remains reachable', async () => {
  const items = Array.from({ length: 30_000 }, (_, index) => ({ full_text: index === 29_999 ? 'late unique marker' : `normal ${index}` }));
  const index = await createIndexAsync(items);
  assert.deepEqual([...index.search('marker')], [29_999]);
  assert.equal(index.size, 30_000);
});
