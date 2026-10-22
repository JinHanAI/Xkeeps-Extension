import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEDULE_KEY, nextDelay, validConfig, configureSource, ensureAlarms, runScheduledSource } from '../lib/scheduled-sync.js';

function environment() {
  const storage = {};
  const alarms = new Map();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { async request(_name, options, fn) { return (fn || options)({}); } } } });
  globalThis.chrome = {
    storage: { local: { async get(key) { return { [key]: storage[key] }; }, async set(update) { Object.assign(storage, update); } } },
    permissions: { async contains() { return true; } },
    alarms: { async create(name, config) { alarms.set(name, config); }, async clear(name) { alarms.delete(name); } },
    cookies: { async get() { return { value: 'u=999' }; } },
  };
  return { storage, alarms };
}

test('schedules start disabled and enabling waits until next day', async () => {
  const { storage, alarms } = environment();
  await ensureAlarms();
  assert.equal(alarms.size, 0);
  const before = Date.now();
  const config = await configureSource('likes', { enabled: true, interval: 'daily', maxPages: 1, userId: '42' });
  assert.ok(config.nextAt >= before + nextDelay('daily'));
  assert.equal(alarms.size, 1);
  assert.equal(storage[SCHEDULE_KEY].likes.lastResult, null);
  assert.equal(validConfig({ enabled: true, interval: 'hourly', maxPages: 99, userId: '42' }), false);
});

test('account switching skips an overdue run without a network request', async () => {
  const { storage, alarms } = environment();
  storage[SCHEDULE_KEY] = { bookmarks: { enabled: true, interval: 'daily', maxPages: 1, userId: '42', nextAt: Date.now() - 1000, run: null } };
  await runScheduledSource('bookmarks');
  const result = storage[SCHEDULE_KEY].bookmarks.lastResult;
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'account_unavailable_or_changed');
  assert.equal(result.pages, 0);
  assert.equal(alarms.size, 1);
});

test('restart marks an in-flight page partial instead of replaying it', async () => {
  const { storage } = environment();
  storage[SCHEDULE_KEY] = { likes: { enabled: true, interval: 'weekly', maxPages: 2, userId: '42', nextAt: Date.now() - 1000,
    run: { phase: 'requesting', pages: 1, cursor: 'opaque', requestStartedAt: new Date().toISOString() } } };
  await ensureAlarms({ startup: true });
  const config = storage[SCHEDULE_KEY].likes;
  assert.equal(config.run, null);
  assert.equal(config.lastResult.reason, 'worker_interrupted');
  assert.equal(config.lastResult.pages, 1);
  assert.ok(config.nextAt > Date.now());
});

test('two-page quick sync checkpoints after each page and never retries a 429', async () => {
  const { storage } = environment();
  storage[SCHEDULE_KEY] = { bookmarks: { enabled: true, interval: 'daily', maxPages: 2, userId: '42', nextAt: Date.now() - 1000, run: null } };
  let requests = 0, saves = 0;
  const adapters = {
    async getSessionUserId() { return '42'; },
    async existingIds() { return { record: { revision: saves }, ids: new Set(['1']) }; },
    async getCredentials() { return { creds: { queryId_Bookmarks: 'synthetic-query' } }; },
    async getFreshCt0() { return 'synthetic'; },
    async graphqlRequest() { requests++; return { error: null, data: { page: requests } }; },
    parsePage(data) { return { valid: true, tweets: [{ tweet_id: String(10 + data.page) }], bottomCursor: data.page === 1 ? 'next' : null }; },
    async mergePage() { saves++; },
  };
  await runScheduledSource('bookmarks', adapters);
  assert.equal(requests, 1);
  assert.equal(saves, 1);
  assert.equal(storage[SCHEDULE_KEY].bookmarks.run.phase, 'waiting');
  storage[SCHEDULE_KEY].bookmarks.run.resumeAfter = Date.now() - 1;
  await runScheduledSource('bookmarks', adapters);
  assert.equal(requests, 2);
  assert.equal(saves, 2);
  assert.equal(storage[SCHEDULE_KEY].bookmarks.run, null);
  assert.equal(storage[SCHEDULE_KEY].bookmarks.lastResult.pages, 2);

  storage[SCHEDULE_KEY].bookmarks.nextAt = Date.now() - 1;
  adapters.graphqlRequest = async () => { requests++; return { error: 'rate_limited', status: 429 }; };
  await runScheduledSource('bookmarks', adapters);
  assert.equal(requests, 3);
  assert.equal(storage[SCHEDULE_KEY].bookmarks.lastResult.reason, 'rate_limited');
  assert.ok(storage[SCHEDULE_KEY].bookmarks.nextAt >= Date.now() + 59 * 60_000);
});

test('account switch after a response prevents any archive write', async () => {
  const { storage } = environment();
  storage[SCHEDULE_KEY] = { likes: { enabled: true, interval: 'daily', maxPages: 1, userId: '42', nextAt: Date.now() - 1, run: null } };
  let reads = 0, saves = 0;
  await runScheduledSource('likes', {
    async getSessionUserId() { reads++; return reads < 4 ? '42' : '99'; },
    async existingIds() { return { record: { revision: 0 }, ids: new Set() }; },
    async getCredentials() { return { creds: { queryId_Likes: 'synthetic-query' } }; },
    async getFreshCt0() { return 'synthetic'; },
    async graphqlRequest() { return { error: null, data: {} }; },
    parsePage() { return { valid: true, tweets: [{ tweet_id: '11' }], bottomCursor: null }; },
    async mergePage() { saves++; },
  });
  assert.equal(saves, 0);
  assert.equal(storage[SCHEDULE_KEY].likes.lastResult.reason, 'account_changed');
});

test('lock contention preserves an in-flight checkpoint and retries later', async () => {
  const { storage, alarms } = environment();
  const requesting = { phase: 'requesting', pages: 1, cursor: 'next', account: '42' };
  storage[SCHEDULE_KEY] = { likes: { enabled: true, interval: 'daily', maxPages: 2, userId: '42', nextAt: Date.now() - 1, run: requesting } };
  navigator.locks.request = async (_name, _options, fn) => fn(null);
  await runScheduledSource('likes');
  assert.deepEqual(storage[SCHEDULE_KEY].likes.run, requesting);
  assert.equal(storage[SCHEDULE_KEY].likes.lastResult, undefined);
  assert.ok(alarms.get('xkeeps-sync-likes').when > Date.now());
});

test('failed alarm registration leaves a new schedule disabled', async () => {
  const { storage } = environment();
  chrome.alarms.create = async () => { throw new Error('alarm_unavailable'); };
  await assert.rejects(configureSource('bookmarks', { enabled: true, interval: 'daily', maxPages: 1, userId: '42' }), /alarm_unavailable/);
  assert.equal(storage[SCHEDULE_KEY].bookmarks.enabled, false);
});

test('changing a schedule keeps its last visible result', async () => {
  const { storage } = environment();
  const previous = { status: 'partial', reason: 'rate_limited', pages: 1, at: new Date().toISOString() };
  storage[SCHEDULE_KEY] = { likes: { enabled: true, interval: 'daily', maxPages: 1, userId: '42',
    nextAt: Date.now() - 1, run: null, lastAttemptAt: previous.at, lastResult: previous } };
  await configureSource('likes', { enabled: false, interval: 'weekly', maxPages: 1, userId: '42' });
  assert.deepEqual(storage[SCHEDULE_KEY].likes.lastResult, previous);
  assert.equal(storage[SCHEDULE_KEY].likes.enabled, false);
});

test('credential and page failures record a visible result without retrying', async () => {
  for (const failure of ['credentials', 'null_response', 'parse', 'null_page', 'save']) {
    const { storage } = environment();
    storage[SCHEDULE_KEY] = { likes: { enabled: true, interval: 'daily', maxPages: 1, userId: '42', nextAt: Date.now() - 1, run: null } };
    let requests = 0;
    const adapters = {
      async getSessionUserId() { return '42'; },
      async existingIds() { return { record: { revision: 0, current: { account: {} } }, ids: new Set() }; },
      async getCredentials() {
        if (failure === 'credentials') throw new Error('storage temporarily unavailable');
        return { userId: '42', creds: { queryId_Likes: 'synthetic-query' } };
      },
      async getFreshCt0() { return 'synthetic'; },
      async graphqlRequest() { requests++; return failure === 'null_response' ? null : { error: null, data: {} }; },
      parsePage() {
        if (failure === 'parse') throw new Error('changed X response');
        if (failure === 'null_page') return null;
        return { valid: true, tweets: [{ tweet_id: '11' }], bottomCursor: null };
      },
      async mergePage() { if (failure === 'save') throw new Error('quota exceeded'); },
    };
    await runScheduledSource('likes', adapters);
    const config = storage[SCHEDULE_KEY].likes;
    assert.equal(requests, failure === 'credentials' ? 0 : 1);
    assert.equal(config.lastResult.status, failure === 'credentials' ? 'skipped' : 'partial');
    assert.equal(config.lastResult.reason, { credentials: 'login_or_query_unavailable', null_response: 'unrecognized_response', parse: 'unrecognized_response', null_page: 'unrecognized_response', save: 'storage_error' }[failure]);
    assert.equal(config.run, null);
    assert.ok(config.nextAt > Date.now());
  }
});

test('permission denial cannot persist an enabled plan', async () => {
  const { storage, alarms } = environment();
  chrome.permissions.contains = async () => false;
  await assert.rejects(configureSource('bookmarks', { enabled: true, interval: 'daily', maxPages: 1, userId: '42' }), /定时任务权限/);
  assert.notEqual(storage[SCHEDULE_KEY]?.bookmarks?.enabled, true);
  assert.equal(alarms.size, 0);
});

test('sources remain independent and disabling removes only its own alarm', async () => {
  const { storage, alarms } = environment();
  await configureSource('bookmarks', { enabled: true, interval: 'weekly', maxPages: 1, userId: '42' });
  await configureSource('likes', { enabled: true, interval: '30d', maxPages: 1, userId: '42' });
  const likes = structuredClone(storage[SCHEDULE_KEY].likes);
  await configureSource('bookmarks', { enabled: false, interval: 'daily', maxPages: 1, userId: '42' });
  assert.deepEqual(storage[SCHEDULE_KEY].likes, likes);
  assert.equal(alarms.has('xkeeps-sync-bookmarks'), false);
  assert.equal(alarms.has('xkeeps-sync-likes'), true);
});

test('one-page plan does not continue or replay on duplicate alarm', async () => {
  const { storage } = environment();
  storage[SCHEDULE_KEY] = { bookmarks: { enabled: true, interval: 'daily', maxPages: 1, userId: '42', nextAt: Date.now() - 1, run: null } };
  let requests = 0, saves = 0;
  const adapters = {
    getSessionUserId: async () => '42', existingIds: async () => ({ record: { revision: 0 }, ids: new Set(['1']) }),
    getCredentials: async () => ({ userId: '42', creds: { queryId_Bookmarks: 'synthetic-query' } }), getFreshCt0: async () => 'synthetic',
    graphqlRequest: async () => { requests++; return { data: {} }; },
    parsePage: () => ({ valid: true, tweets: [{ tweet_id: '2' }], bottomCursor: 'next' }),
    mergePage: async () => { saves++; },
  };
  await runScheduledSource('bookmarks', adapters);
  await runScheduledSource('bookmarks', adapters);
  assert.equal(requests, 1); assert.equal(saves, 1);
  assert.equal(storage[SCHEDULE_KEY].bookmarks.run, null);
  assert.equal(storage[SCHEDULE_KEY].bookmarks.lastResult.reason, 'page_limit');
  assert.equal(storage[SCHEDULE_KEY].bookmarks.lastResult.pages, 1);
});

test('missing saved archive skips without requesting and overdue restart restores an alarm', async () => {
  const { storage, alarms } = environment();
  storage[SCHEDULE_KEY] = { likes: { enabled: true, interval: 'daily', maxPages: 1, userId: '42', nextAt: Date.now() - 1, run: null } };
  await ensureAlarms({ startup: true });
  assert.ok(alarms.get('xkeeps-sync-likes').when >= Date.now() + 59_000);
  let requests = 0;
  await runScheduledSource('likes', { getSessionUserId: async () => '42', existingIds: async () => { throw new Error('no_cumulative_archive'); }, graphqlRequest: async () => { requests++; } });
  assert.equal(requests, 0);
  assert.equal(storage[SCHEDULE_KEY].likes.lastResult.reason, 'no_cumulative_archive');
});
