/** Read only the logged-in account's Likes timeline. No write operations. */
import { fetchWithRetry } from './fetcher.js';
import { parseLikesPage } from './parser.js';
import { waitForCollection, jitteredDelay, MAX_RETRIES } from './utils.js';

export async function fetchLikes({ queryId, creds, userId, mode = 'sample', knownIds = new Set(),
  beforeRequest, onPage, onLog, shouldStop, shouldPause }) {
  if (!/^\d+$/.test(userId || '') || !queryId) throw new Error('缺少已确认的账号或点赞查询接口。');
  if (!['full', 'quick', 'sample'].includes(mode)) throw new Error('未知的点赞采集模式。');
  const sample = mode === 'sample';
  const limit = sample ? 50 : Infinity;
  const state = { consecutive429s: 0 };
  const cursors = new Set();
  const observed = new Set();
  let cursor = null, pages = 0, total = 0;
  while (true) {
    if (shouldStop?.()) return { total, pages, reason: 'user_stopped', complete: false };
    const variables = { userId, count: 50, includePromotedContent: false,
      withClientEventToken: false, withBirdwatchNotes: false, withVoice: true };
    if (cursor) variables.cursor = cursor;
    const { result, abort, reason } = await fetchWithRetry({ queryId, operationName: 'Likes', variables, creds,
      state, beforeRequest, shouldStop, shouldPause, onLog, maxAttempts: sample ? 1 : MAX_RETRIES });
    if (abort) return { total, pages, reason, complete: false };
    const page = parseLikesPage(result.data);
    if (!page.valid || page.tweets.some(tweet => !tweet.tweet_id || typeof tweet.tweet_id !== 'string')) {
      return { total, pages, reason: 'unrecognized_response', complete: false };
    }
    // Account can switch while a response is in flight; never persist that page.
    await beforeRequest?.();
    pages++;
    const tweets = page.tweets.filter(tweet => !observed.has(tweet.tweet_id)).slice(0, limit - total);
    for (const tweet of tweets) observed.add(tweet.tweet_id);
    if (tweets.length) { await onPage?.(tweets, pages, page.bottomCursor); total += tweets.length; }
    if (sample) return { total, pages, reason: 'sample_limit', complete: false };
    if (mode === 'quick' && page.tweets.length && page.tweets.every(tweet => knownIds.has(tweet.tweet_id))) {
      return { total, pages, reason: 'quick_boundary', complete: false };
    }
    if (!page.bottomCursor) return { total, pages, reason: 'complete', complete: true };
    if (page.bottomCursor === cursor || cursors.has(page.bottomCursor) || !tweets.length) {
      return { total, pages, reason: 'pagination_guard', complete: false };
    }
    cursors.add(page.bottomCursor);
    cursor = page.bottomCursor;
    await waitForCollection(jitteredDelay(), shouldStop);
  }
}
