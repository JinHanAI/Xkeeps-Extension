/* Optional, account-bound, one-page-per-alarm quick checks. No live task is enabled on upgrade. */
import './archive.js';
import { getSessionUserId } from './identity.js';
import { getCredentials, getFreshCt0, graphqlRequest } from './api.js';
import { getStoredQueryIds } from './query-ids.js';
import { parseBookmarksPage, parseLikesPage } from './parser.js';
import { LikesStore, likesDocument } from './likes-archive.js';
import { recordEvent, errorClass } from './analytics.js';

export const SCHEDULE_KEY = 'xkeeps_schedule_v1';
export const SOURCES = ['bookmarks', 'likes'];
const archiveStore = new XArchive.ArchiveStore();
const likesStore = new LikesStore();
const DAY = 24 * 60 * 60 * 1000;
const CONTINUE_DELAY = 30_000;
const COOLDOWN = 60 * 60 * 1000;

const INTERVAL_DAYS = { daily: 1, weekly: 7, '30d': 30, '90d': 90, '180d': 180 };
export function nextDelay(interval) { return (INTERVAL_DAYS[interval] || 1) * DAY; }
export function validConfig(config) {
  return !!config && typeof config === 'object' && typeof config.enabled === 'boolean'
    && Object.hasOwn(INTERVAL_DAYS, config.interval) && [1, 2].includes(config.maxPages)
    && /^\d+$/.test(config.userId || '');
}
export function alarmName(source) { return `xkeeps-sync-${source}`; }

async function allSchedules() { return (await chrome.storage.local.get(SCHEDULE_KEY))[SCHEDULE_KEY] || {}; }
async function updateSource(source, transform) {
  return navigator.locks.request('xkeeps-schedule-state', async () => {
    const all = await allSchedules();
    const next = transform(all[source] || null);
    all[source] = next;
    await chrome.storage.local.set({ [SCHEDULE_KEY]: all });
    return next;
  });
}

export async function configureSource(source, config) {
  if (!SOURCES.includes(source) || !validConfig(config)) throw new Error('Invalid schedule configuration.');
  if (config.enabled && !await chrome.permissions.contains({ permissions: ['alarms'] })) {
    throw new Error('未授予定时任务权限；计划仍保持关闭。');
  }
  const now = Date.now();
  const next = await updateSource(source, previous => ({ ...config, nextAt: now + nextDelay(config.interval), run: null,
    lastAttemptAt: previous?.lastAttemptAt || null, lastResult: previous?.lastResult || null }));
  try { await ensureAlarms(); }
  catch (error) {
    // A failed alarm registration must never leave a visible "enabled" plan.
    if (config.enabled) await updateSource(source, previous => ({ ...previous, enabled: false }));
    throw error;
  }
  return next;
}

export async function ensureAlarms({ startup = false } = {}) {
  const permitted = await chrome.permissions.contains({ permissions: ['alarms'] });
  if (!permitted) return;
  const all = await allSchedules();
  for (const source of SOURCES) {
    const name = alarmName(source);
    const config = all[source];
    if (!validConfig(config) || !config.enabled) { await chrome.alarms.clear(name); continue; }
    if (startup && config.run?.phase === 'requesting') {
      // The worker was interrupted after marking a request. Never replay it.
      await updateSource(source, previous => ({ ...previous, run: null,
        nextAt: Date.now() + nextDelay(previous.interval),
        lastResult: { status: 'partial', reason: 'worker_interrupted', pages: previous.run.pages || 0, at: new Date().toISOString() } }));
    }
    const current = (await allSchedules())[source];
    const due = current.run?.phase === 'waiting' ? current.run.resumeAfter : current.nextAt;
    await chrome.alarms.create(name, { when: Math.max(Date.now() + 60_000, due || Date.now() + 60_000) });
  }
}

async function finish(source, result, delay = null) {
  await updateSource(source, previous => ({ ...previous, run: null, nextAt: Date.now() + (delay ?? nextDelay(previous.interval)),
    lastResult: { ...result, at: new Date().toISOString() } }));
  await ensureAlarms();
  recordEvent('scheduled_check_completed', { source,
    result: result.status === 'success' ? 'success' : result.status === 'partial' ? 'partial' : result.status === 'skipped' ? 'skipped' : 'error',
    page_count: result.pages || 0,
    ...(result.status === 'failed' ? { error_class: errorClass(result.reason) } : {}),
  });
}

function snapshot(source, userId, screenName, tweets, reason) {
  const now = new Date().toISOString();
  if (source === 'likes') {
    const normalized = tweets.map(tweet => ({ ...tweet, liked_at: null, first_seen_at: now, last_seen_at: now }));
    return likesDocument({ userId, screenName, mode: 'quick', reason, coverage: 'partial', likes: normalized, kind: 'snapshot', exportedAt: now });
  }
  return { export_metadata: { user_id: userId, screen_name: screenName, kind: 'snapshot', exported_at: now,
    collection: { mode: 'quick', bookmarks: 'partial', folders: 'unknown', reason } }, folders: [], bookmarks: tweets };
}

async function existingIds(source, userId) {
  if (source === 'likes') {
    const record = await likesStore.get(userId);
    if (record.snapshot?.likes?.length && !record.snapshot.merged_at) throw new Error('unfinished_snapshot');
    if (!record.current?.likes?.length) throw new Error('no_cumulative_archive');
    return { record, ids: new Set(record.current.likes.map(item => item.tweet_id)) };
  }
  const databases = await indexedDB.databases();
  if (databases.some(db => db.name === 'xarchive')) {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('xarchive');
      request.onupgradeneeded = () => request.transaction.abort();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('staging_unavailable'));
    });
    try {
      if (database.objectStoreNames.contains('export_state')) {
        const run = await new Promise((resolve, reject) => {
          const tx = database.transaction('export_state', 'readonly');
          const request = tx.objectStore('export_state').get('run_info');
          request.onsuccess = () => resolve(request.result?.value || null);
          request.onerror = () => reject(request.error || new Error('staging_unavailable'));
        });
        if (run?.user_id === userId && run.started_at && !run.finished_at) throw new Error('unfinished_snapshot');
      }
    } finally { database.close(); }
  }
  const record = await archiveStore.get(`user:${userId}`);
  if (!record?.data.bookmarks?.length) throw new Error('no_cumulative_archive');
  return { record, ids: new Set(record.data.bookmarks.map(item => item.tweet_id)) };
}

async function mergePage(source, userId, screenName, tweets, record) {
  if (!tweets.length) return;
  if (await getSessionUserId() !== userId) throw new Error('account_changed');
  const incoming = snapshot(source, userId, screenName, tweets, 'scheduled_page');
  if (source === 'likes') await likesStore.import(userId, incoming, record.revision);
  else {
    const merged = XArchive.merge(record.data, incoming);
    if (merged.changed) await archiveStore.save(`user:${userId}`, merged.data, record.revision);
  }
}

export async function runScheduledSource(source, adapters = {}) {
  if (!SOURCES.includes(source)) return;
  const currentUser = adapters.getSessionUserId || getSessionUserId;
  const readArchive = adapters.existingIds || existingIds;
  const credentials = adapters.getCredentials || getCredentials;
  const csrf = adapters.getFreshCt0 || getFreshCt0;
  const request = adapters.graphqlRequest || graphqlRequest;
  const savePage = adapters.mergePage || mergePage;
  const parse = adapters.parsePage || (source === 'likes' ? parseLikesPage : parseBookmarksPage);
  return navigator.locks.request('xarchive-export', { ifAvailable: true }, async lock => {
    const all = await allSchedules();
    const config = all[source];
    if (!validConfig(config) || !config.enabled) return;
    if (!lock) {
      // A running task owns the state. Moving its checkpoint here could turn
      // an in-flight response into a duplicate request after the next alarm.
      await chrome.alarms.create(alarmName(source), { when: Date.now() + (config.run?.phase === 'requesting' ? 60_000 : 30 * 60_000) });
      return;
    }
    const now = Date.now();
    if (config.run?.phase === 'requesting') return finish(source, { status: 'partial', reason: 'request_state_unresolved', pages: config.run.pages || 0 });
    if (config.run?.phase === 'waiting' && now < config.run.resumeAfter) return ensureAlarms();
    if (!config.run && now < config.nextAt) return ensureAlarms();
    const pages = config.run?.pages || 0;
    let userId;
    try { userId = await currentUser(); }
    catch { return finish(source, { status: 'skipped', reason: 'account_unavailable_or_changed', pages }); }
    if (!userId || userId !== config.userId) return finish(source, { status: 'skipped', reason: 'account_unavailable_or_changed', pages });
    let archive;
    try { archive = await readArchive(source, userId); }
    catch (error) { return finish(source, { status: 'skipped', reason: error.message, pages }); }
    let identity;
    try { identity = await credentials(); }
    catch { return finish(source, { status: 'skipped', reason: 'login_or_query_unavailable', pages }); }
    if (!identity) return finish(source, { status: 'skipped', reason: 'login_or_query_unavailable', pages });
    if (identity.userId != null && identity.userId !== userId) return finish(source, { status: 'skipped', reason: 'account_changed', pages });
    const operation = source === 'likes' ? 'Likes' : 'Bookmarks';
    const queryId = getStoredQueryIds(identity.creds)[operation];
    if (!queryId) return finish(source, { status: 'skipped', reason: 'login_or_query_unavailable', pages });
    let csrfToken;
    try { csrfToken = await csrf(); }
    catch { return finish(source, { status: 'skipped', reason: 'login_or_query_unavailable', pages }); }
    if (!csrfToken) return finish(source, { status: 'skipped', reason: 'login_or_query_unavailable', pages });
    try { if (await currentUser() !== userId) return finish(source, { status: 'skipped', reason: 'account_changed', pages }); }
    catch { return finish(source, { status: 'skipped', reason: 'account_unavailable_or_changed', pages }); }
    const cursor = config.run?.cursor || null;
    const seenCursors = config.run?.seenCursors || [];
    const startedAt = new Date().toISOString();
    await updateSource(source, previous => ({ ...previous, lastAttemptAt: startedAt,
      run: { phase: 'requesting', cursor, pages, seenCursors, account: userId, requestStartedAt: startedAt } }));
    // If the worker dies after marking a request, this watchdog records an
    // interrupted partial run without issuing the same page request again.
    await chrome.alarms.create(alarmName(source), { when: Date.now() + 10 * 60_000 });
    const variables = source === 'likes'
      ? { userId, count: 50, includePromotedContent: false, withClientEventToken: false, withBirdwatchNotes: false, withVoice: true }
      : { count: 100 };
    if (cursor) variables.cursor = cursor;
    let result;
    try { if (await currentUser() !== userId) return finish(source, { status: 'skipped', reason: 'account_changed', pages }); }
    catch { return finish(source, { status: 'skipped', reason: 'account_unavailable_or_changed', pages }); }
    try { result = await request(queryId, operation, variables, identity.creds); }
    catch (error) { return finish(source, { status: 'failed', reason: `request_error:${error.message}`, pages }); }
    if (!result || typeof result !== 'object') return finish(source, { status: 'partial', reason: 'unrecognized_response', pages });
    if (result.error) return finish(source, { status: 'failed', reason: result.error, pages }, result.error === 'rate_limited' ? COOLDOWN : null);
    try { if (await currentUser() !== userId) return finish(source, { status: 'failed', reason: 'account_changed', pages }); }
    catch { return finish(source, { status: 'failed', reason: 'account_unavailable_or_changed', pages }); }
    let page;
    try { page = parse(result.data); }
    catch { return finish(source, { status: 'partial', reason: 'unrecognized_response', pages }); }
    if (!page?.valid || !Array.isArray(page.tweets) || page.tweets.some(tweet => !/^\d+$/.test(tweet?.tweet_id || ''))) return finish(source, { status: 'partial', reason: 'unrecognized_response', pages });
    const profileKey = `xarchive_profile_${userId}`;
    let profile = null;
    try { profile = (await chrome.storage.local.get(profileKey))[profileKey]; }
    catch { /* A missing display name does not prevent saving a valid page. */ }
    const screenName = profile || (source === 'likes' ? archive.record.current?.account?.screen_name : archive.record.data?.export_metadata?.screen_name) || null;
    try { await savePage(source, userId, screenName, page.tweets, archive.record); }
    catch (error) { return finish(source, { status: 'partial', reason: error?.message === 'account_changed' ? 'account_changed' : 'storage_error', pages }); }
    if (page.tweets.length) {
      const notification = chrome.runtime?.sendMessage?.({ type: 'xkeeps:archive-updated', source, userId });
      await notification?.catch?.(() => {});
    }
    const nextPages = pages + 1;
    const allKnown = page.tweets.length > 0 && page.tweets.every(tweet => archive.ids.has(tweet.tweet_id));
    const guard = !!page.bottomCursor && (page.bottomCursor === cursor || seenCursors.includes(page.bottomCursor));
    if (!page.bottomCursor || allKnown || guard || nextPages >= config.maxPages) {
      return finish(source, { status: guard ? 'partial' : 'success',
        reason: guard ? 'pagination_guard' : !page.bottomCursor ? 'timeline_end' : allKnown ? 'quick_boundary' : 'page_limit',
        pages: nextPages, coverage: !page.bottomCursor ? 'timeline_end' : 'partial' });
    }
    await updateSource(source, previous => ({ ...previous, run: { phase: 'waiting', account: userId,
      cursor: page.bottomCursor, pages: nextPages, seenCursors: [...seenCursors, page.bottomCursor], resumeAfter: Date.now() + CONTINUE_DELAY } }));
    await ensureAlarms();
  });
}
