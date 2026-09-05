import test from 'node:test';
import assert from 'node:assert/strict';
import { graphqlRequest, getCredentials } from '../lib/api.js';
import { getSessionUserId } from '../lib/identity.js';
import { extractIdsFromBundle, scrapeQueryIdsFromBundles } from '../lib/query-ids.js';

function session(t, value = 'u%3D42') {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  const previous = globalThis.chrome;
  globalThis.chrome = { cookies: { get: async ({ name }) => ({ value: name === 'twid' ? value : 'fresh-csrf' }) }, storage: { local: { get: async key => ({ [key]: { marker: key } }) } } };
  t.after(() => { globalThis.chrome = previous; });
}

test('session identity comes from the current cookie and stays a string', async t => {
  for (const value of ['u%3D12345678901234567890', '"u=12345678901234567890"']) {
    session(t, value);
    assert.equal(await getSessionUserId(), '12345678901234567890');
    const credentials = await getCredentials();
    assert.equal(credentials.creds.marker, 'xarchive_creds_12345678901234567890');
  }
});

test('invalid or missing session cookies cannot select an account', async t => {
  session(t, '%invalid');
  assert.equal(await getSessionUserId(), null);
  assert.equal((await getCredentials()).creds, null);
});

test('requests use fresh CSRF, operation flags and unmodified captured transaction IDs', async t => {
  session(t);
  let request;
  globalThis.fetch = async (url, options) => { request = { url: new URL(url), ...options }; return new Response('{"errors":[],"data":{}}'); };
  const creds = { authorization: 'Bearer live-token', 'x-csrf-token': 'stale', 'x-client-transaction-id': 'ID123', features_Bookmarks: '{"custom":true}', captured_features: '{"unrelated":true}' };
  assert.equal((await graphqlRequest('query', 'Bookmarks', { count: 100 }, creds)).error, null);
  assert.equal(request.headers['X-Csrf-Token'], 'fresh-csrf');
  assert.equal(request.headers.Authorization, 'Bearer live-token');
  assert.equal(request.headers['X-Client-Transaction-Id'], 'ID123');
  const flags = JSON.parse(request.url.searchParams.get('features'));
  assert.equal(flags.custom, true);
  assert.equal(flags.unrelated, undefined);
  assert.ok(request.signal);
});

test('network and JSON failures return retryable errors; expired cookies send nothing', async t => {
  session(t);
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  assert.equal((await graphqlRequest('q', 'Bookmarks', {}, {})).error, 'network_error');
  globalThis.fetch = async () => new Response('<html>');
  assert.equal((await graphqlRequest('q', 'Bookmarks', {}, {})).error, 'invalid_response');
  globalThis.chrome.cookies.get = async () => null;
  globalThis.fetch = async () => { assert.fail('must not fetch without CSRF cookie'); };
  assert.equal((await graphqlRequest('q', 'Bookmarks', {}, {})).error, 'auth_error');
});

test('query extraction uses key order and rejects unrelated nearby identifiers', () => {
  const result = extractIdsFromBundle('{queryId:"ABC123",operationName:"Bookmarks"}; {"operationName":"BookmarkFoldersSlice","queryId":"xyz456"}; {operationName:"BookmarkFolderTimeline",unrelated:"NotAnEndpoint12345"}');
  assert.deepEqual(result, { Bookmarks: 'ABC123', BookmarkFoldersSlice: 'xyz456' });
});

test('bundle discovery does not fetch arbitrary hosts or forward session credentials', async t => {
  session(t);
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, credentials: options.credentials });
    return new Response(url.startsWith('https://x.com') ? '<script src="https://evil.example/test.js"></script><script src="https://abs.twimg.com/client-web.js"></script>' : '{queryId:"Q",operationName:"Bookmarks"}');
  };
  assert.equal((await scrapeQueryIdsFromBundles()).Bookmarks, 'Q');
  assert.equal(calls.some(c => c.url.includes('evil.example')), false);
  assert.equal(calls.find(c => c.url.includes('abs.twimg.com')).credentials, 'omit');
});
