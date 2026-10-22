import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as utils from '../lib/utils.js';
import { parseLikesPage } from '../lib/parser.js';
import { likesDocument, validateLikes, mergeLikes } from '../lib/likes-archive.js';
import { buildLikesCsv, buildLikesMarkdown, likesFilename } from '../lib/export-formats.js';

const source = file => readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\s*$/gm, '').replace(/^export /gm, '');
const entry = id => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: {
  rest_id: String(id), legacy: { full_text: `正文 ${id} ✨`, created_at: '2026-09-01T00:00:00Z',
    extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/a.jpg' }] } },
  core: { user_results: { result: { core: { name: '作者 ✨', screen_name: 'writer' }, avatar: { image_url: 'https://pbs.twimg.com/avatar.jpg' } } } },
} } } } });
const page = (ids, cursor = null) => ({ error: null, data: { data: { user: { result: { timeline: { timeline: { instructions: [
  { type: 'TimelineAddEntries', entries: [ ...ids.map(entry), ...(cursor ? [{ entryId: 'cursor-bottom-1', content: { value: cursor } }] : []) ] },
] } } } } } } });

function context(responses) {
  const calls = [], saved = [];
  const globals = vm.createContext({ ...utils, parseLikesPage, waitForCollection: async () => {}, jitteredDelay: () => 0,
    graphqlRequest: async (...args) => { calls.push(args); assert.ok(responses.length, 'extra Likes request'); return responses.shift(); },
    upsertBookmarks: async () => { throw new Error('Likes wrote into bookmarks'); }, parseBookmarksPage: () => {}, });
  vm.runInContext(source('fetcher.js'), globals);
  vm.runInContext(source('likes-fetcher.js'), globals);
  return { globals, calls, saved };
}

test('Likes parser preserves author, avatar, text and media, rejects unknown roots', () => {
  const result = parseLikesPage(page(['123'], 'more').data);
  assert.equal(result.valid, true);
  assert.equal(result.bottomCursor, 'more');
  assert.equal(result.tweets[0].author.name, '作者 ✨');
  assert.equal(result.tweets[0].author.profile_image_url, 'https://pbs.twimg.com/avatar.jpg');
  assert.equal(result.tweets[0].full_text, '正文 123 ✨');
  assert.equal(result.tweets[0].media[0].type, 'photo');
  assert.equal(parseLikesPage({}).valid, false);
});

test('sample requests one page of 50 once and stores no more than 50', async () => {
  const { globals, calls } = context([page(Array.from({ length: 60 }, (_, i) => String(i + 1)), 'next')]);
  const stored = [];
  const result = await globals.fetchLikes({ queryId: 'captured', userId: '42', mode: 'sample', onPage: tweets => stored.push(...tweets) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'Likes');
  assert.equal(calls[0][2].count, 50);
  assert.equal(calls[0][2].userId, '42');
  assert.equal(stored.length, 50);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'sample_limit');
});

test('sample does not retry rate limit, malformed response or switched account', async () => {
  const rate = context([{ error: 'rate_limited', status: 429 }]);
  assert.equal((await rate.globals.fetchLikes({ queryId: 'id', userId: '42', mode: 'sample' })).reason, 'rate_limit_exceeded');
  assert.equal(rate.calls.length, 1);
  const malformed = context([{ error: null, data: {} }]);
  assert.equal((await malformed.globals.fetchLikes({ queryId: 'id', userId: '42' })).reason, 'unrecognized_response');
  const switched = context([page(['1'])]);
  let checks = 0, writes = 0;
  await assert.rejects(switched.globals.fetchLikes({ queryId: 'id', userId: '42',
    beforeRequest: () => { if (++checks === 2) throw new Error('account switched'); },
    onPage: () => { writes++; } }), /account switched/);
  assert.equal(writes, 0);
});

test('quick boundary and pagination loops stay partial', async () => {
  const quick = context([page(['1', '2'], 'next')]);
  const result = await quick.globals.fetchLikes({ queryId: 'id', userId: '42', mode: 'quick', knownIds: new Set(['1', '2']) });
  assert.equal(result.reason, 'quick_boundary');
  assert.equal(result.complete, false);
  assert.equal(quick.calls.length, 1);
  const loop = context([page(['1'], 'same'), page(['2'], 'same')]);
  assert.equal((await loop.globals.fetchLikes({ queryId: 'id', userId: '42', mode: 'full' })).reason, 'pagination_guard');
});

test('Likes archive is separate, retains absent posts, rejects wrong account, and formats identify source', () => {
  const at = '2026-09-29T00:00:00.000Z';
  const b = { ...parseLikesPage(page(['1']).data).tweets[0], first_seen_at: at, last_seen_at: at, liked_at: null };
  const base = likesDocument({ userId: '42', likes: [b], exportedAt: at });
  const next = likesDocument({ userId: '42', likes: [{ ...b, tweet_id: '2' }], exportedAt: at });
  const merged = mergeLikes(base, next);
  assert.deepEqual(merged.data.likes.map(tweet => tweet.tweet_id), ['1', '2']);
  assert.equal(merged.summary.retained, 1);
  assert.equal(merged.data.likes[0].liked_at, null);
  assert.equal(buildLikesCsv(merged.data).match(/\r\n/g).length, 3);
  assert.match(buildLikesCsv(merged.data), /来源,?/);
  assert.match(buildLikesMarkdown(merged.data), /X 点赞导出/);
  assert.match(likesFilename(merged.data, 'json'), /Likes_42/);
  assert.equal('bookmarks' in merged.data, false);
  assert.throws(() => mergeLikes(base, likesDocument({ userId: '43' })), /账号不一致/);
  assert.throws(() => validateLikes({ ...base, likes: [b, b] }), /重复/);
});

test('both Likes ranges round-trip across JSON, CSV and Markdown without executable spreadsheet cells', () => {
  const at = '2026-09-29T00:00:00.000Z';
  const firstSeen = '2026-09-28T10:11:12.000Z';
  const lastSeen = '2026-09-28T13:14:15.000Z';
  const tweet = { tweet_id: '1234567890123456789', full_text: '=HYPERLINK("bad")\n第二行', status: 'available',
    author: { name: '作者', screen_name: 'writer', profile_image_url: 'https://pbs.twimg.com/avatar.jpg' },
    media: [{ type: 'photo', url: 'https://pbs.twimg.com/photo.jpg' }],
    first_seen_at: firstSeen, last_seen_at: lastSeen, liked_at: null };
  for (const kind of ['snapshot', 'cumulative']) {
    const document = likesDocument({ userId: '42', kind, likes: [tweet], exportedAt: at });
    assert.equal(validateLikes(JSON.parse(JSON.stringify(document))).likes[0].tweet_id, tweet.tweet_id);
    const csv = buildLikesCsv(document);
    assert.match(csv, /'1234567890123456789/);
    assert.match(csv, /'=HYPERLINK/);
    assert.match(csv, /头像URL/);
    assert.ok(csv.includes(firstSeen), 'CSV should retain the Likes first-seen timestamp');
    assert.ok(csv.includes(lastSeen), 'CSV should retain the Likes last-seen timestamp');
    const markdown = buildLikesMarkdown(document);
    assert.match(markdown, /https:\/\/pbs\.twimg\.com\/photo\.jpg/);
    assert.match(markdown, /点赞时间：`未知`/);
    for (const format of ['json', 'csv', 'markdown']) assert.match(likesFilename(document, format), new RegExp(kind));
  }
});

test('older Likes imports fill history without reverting a newer full refresh', () => {
  const newer = likesDocument({ userId: '42', mode: 'full', coverage: 'complete', reason: 'complete',
    exportedAt: '2026-09-29T00:00:00.000Z', likes: [{ tweet_id: '2', full_text: 'new', status: 'available' }] });
  const older = likesDocument({ userId: '42', mode: 'sample', coverage: 'partial', reason: 'sample_limit',
    exportedAt: '2026-09-28T00:00:00.000Z', likes: [{ tweet_id: '1', full_text: 'older', status: 'available' }] });
  const current = mergeLikes(null, newer).data;
  const merged = mergeLikes(current, older).data;
  assert.deepEqual(merged.likes.map(tweet => tweet.tweet_id), ['1', '2']);
  assert.equal(merged.collection.coverage, 'complete');
  assert.equal(merged.last_full_refresh_at, newer.exported_at);
  assert.equal(merged.exported_at, newer.exported_at);
});

test('liked-post progress receives distinct counts and page numbers across pagination', async () => {
  const reader=context([page(['1','2'],'next'),page(['2','3'])]);
  const progress=[];let total=0;
  const result=await reader.globals.fetchLikes({queryId:'id',userId:'42',mode:'full',
    onPage: async (items,pages) => {total+=items.length;progress.push({total,pages});}});
  assert.deepEqual(progress,[{total:2,pages:1},{total:3,pages:2}]);
  assert.equal(result.total,3);assert.equal(result.pages,2);assert.equal(result.complete,true);
});
