import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBookmarksPage, parseFolderList } from '../lib/parser.js';

const page = instructions => ({ data: { bookmark_timeline_v2: { timeline: { instructions } } } });
const entry = result => ({ entryId: 'tweet-123', content: { itemContent: { tweet_results: { result } } } });
const parse = result => parseBookmarksPage(page([{ type: 'TimelineAddEntries', entries: [entry(result)] }]));

test('null and nested missing visibility results preserve unavailable IDs', () => {
  for (const result of [null, { __typename: 'TweetWithVisibilityResults', tweet: null }, { __typename: 'TweetTombstone' }, { __typename: 'TweetUnavailable' }]) {
    assert.equal(parse(result).tweets[0].tweet_id, '123');
    assert.equal(parse(result).tweets[0].status, 'unavailable');
  }
  const quoted = parse({ rest_id: '123', quoted_status_result: { result: { __typename: 'TweetWithVisibilityResults' } } }).tweets[0];
  assert.equal(quoted.quoted_tweet.status, 'unavailable');
});

test('long posts retain matching long-form URL entities and modern author fields', () => {
  const tweet = parse({ rest_id: '123', legacy: { full_text: 'Truncated' }, note_tweet: { note_tweet_results: { result: { text: 'Full text', entity_set: { urls: [{ url: 'https://t.co/test', expanded_url: 'https://example.com' }] } } } }, core: { user_results: { result: { core: { name: 'Name', screen_name: 'handle' }, avatar: { image_url: 'https://example.com/avatar' } } } } }).tweets[0];
  assert.equal(tweet.full_text, 'Full text');
  assert.equal(tweet.entities.urls[0].expanded_url, 'https://example.com');
  assert.equal(tweet.author.screen_name, 'handle');
});

test('unknown instructions, invalid cursors and malformed entries are incomplete', () => {
  for (const instructions of [[{ type: 'ChangedAPI' }], [null], [{ type: 'TimelineAddEntries', entries: {} }], [{ type: 'TimelineAddEntries', entries: [null] }], [{ type: 'TimelineAddEntries', entries: [{ entryId: 'cursor-bottom-1', content: { value: 123 } }] }], [{ type: 'TimelineAddEntries', entries: [{ entryId: 'unknown-module' }] }]]) {
    assert.equal(parseBookmarksPage(page(instructions)).valid, false);
  }
});

test('replacement cursors and explicit termination are recognized', () => {
  const result = parseBookmarksPage(page([{ type: 'TimelineReplaceEntry', entry: { entryId: 'cursor-bottom-1', content: { value: 'next' } } }, { type: 'TimelineTerminateTimeline' }]));
  assert.equal(result.valid, true);
  assert.equal(result.bottomCursor, 'next');
});

test('malformed folder entries fail without dereferencing null', () => {
  const data = { data: { viewer: { user_results: { result: { bookmark_collections_slice: { items: [null] } } } } } };
  assert.equal(parseFolderList(data).valid, false);
});
