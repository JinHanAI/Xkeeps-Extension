import { VERSION } from '../version.js';

// This store is local to the extension. No account, content, URL, search term,
// filename, or filesystem path is accepted by the event schema.
const DB_NAME = 'xkeeps-analytics-v1';
const STORE = 'events';
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 5000;
const NAMES = new Set([
  'app_opened', 'page_viewed', 'source_selected',
  'support_prompt_shown', 'support_prompt_dismissed', 'support_link_clicked', 'review_link_clicked',
  'feedback_link_clicked', 'feedback_template_copied', 'creator_link_clicked', 'external_link_open_failed',
  'archive_import_started', 'archive_import_completed',
  'archive_update_started', 'archive_update_completed',
  'archive_export_started', 'archive_export_completed',
  'browse_filter_applied', 'browse_selection_changed', 'browse_archive_opened',
  'browse_media_download_started', 'browse_media_download_completed',
  'browse_video_preview_started', 'browse_video_preview_result',
  'connection_refresh_started', 'connection_refresh_completed',
  'media_estimate_viewed', 'media_backup_started', 'media_backup_completed',
  'schedule_configured', 'scheduled_check_completed', 'account_archive_deleted',
]);
const ENUMS = {
  entry: ['home', 'browse', 'media'], placement: ['success_card', 'settings', 'sidebar'],
  channel: ['website', 'github', 'x'], target: ['support', 'review', 'feedback', 'creator'],
  page: ['home', 'browse', 'accounts', 'settings', 'feedback', 'author'],
  source: ['bookmarks', 'likes'],
  origin: ['browser', 'file'],
  media_type: ['photo', 'video'],
  mode: ['sample', 'quick', 'full', 'import', 'scheduled'],
  format: ['json', 'csv', 'markdown', 'zip'],
  result: ['success', 'partial', 'cancelled', 'error', 'skipped'],
  error_class: ['auth', 'rate_limit', 'network', 'invalid_file', 'account_mismatch', 'permission', 'storage', 'download_cancelled', 'media_unavailable', 'unknown'],
  scope: ['cumulative', 'snapshot', 'selection'],
  period: ['all', 'year', 'half', 'month', 'week', 'custom'],
  filter_type: ['text', 'folder', 'time', 'source'],
};
const COUNTS = new Set(['prompt_version', 'item_count', 'page_count', 'match_count', 'selected_count', 'media_count', 'estimated_bytes', 'actual_bytes', 'duration_ms', 'interval_days', 'package_count', 'complete_media_count', 'failed_media_count']);
const FLAGS = new Set(['enabled', 'had_bookmarks', 'had_likes']);
const EVENT_FIELDS = {
  support_prompt_shown: ['entry', 'prompt_version'], support_prompt_dismissed: ['prompt_version'],
  support_link_clicked: ['placement'], review_link_clicked: ['placement'], feedback_link_clicked: ['placement'],
  feedback_template_copied: ['placement'], creator_link_clicked: ['placement', 'channel'],
  external_link_open_failed: ['target', 'error_class'],
  app_opened: ['page'], page_viewed: ['page'], source_selected: ['source'],
  archive_import_started: ['source', 'format'],
  archive_import_completed: ['source', 'format', 'result', 'item_count', 'error_class'],
  archive_update_started: ['source', 'mode'],
  archive_update_completed: ['source', 'mode', 'result', 'item_count', 'page_count', 'duration_ms', 'error_class'],
  archive_export_started: ['source', 'format', 'scope', 'period', 'item_count'],
  archive_export_completed: ['source', 'format', 'scope', 'period', 'item_count', 'duration_ms', 'result', 'error_class'],
  browse_filter_applied: ['source', 'filter_type', 'match_count'],
  browse_selection_changed: ['source', 'selected_count'],
  browse_archive_opened: ['source', 'origin', 'item_count'],
  browse_media_download_started: ['source', 'media_type'],
  browse_media_download_completed: ['source', 'media_type', 'actual_bytes', 'duration_ms', 'result', 'error_class'],
  browse_video_preview_started: ['source'], browse_video_preview_result: ['source', 'result'],
  connection_refresh_started: [],
  connection_refresh_completed: ['result', 'duration_ms', 'error_class'],
  media_estimate_viewed: ['source', 'item_count', 'media_count', 'estimated_bytes'],
  media_backup_started: ['source', 'item_count', 'media_count', 'estimated_bytes'],
  media_backup_completed: ['source', 'item_count', 'media_count', 'estimated_bytes', 'actual_bytes', 'duration_ms', 'package_count', 'complete_media_count', 'failed_media_count', 'result', 'error_class'],
  schedule_configured: ['source', 'enabled', 'interval_days', 'result', 'error_class'],
  scheduled_check_completed: ['source', 'result', 'page_count', 'item_count', 'error_class'],
  account_archive_deleted: ['had_bookmarks', 'had_likes'],
};

let sessionId;
function randomId() { return globalThis.crypto.randomUUID(); }
function currentSessionId() {
  if (sessionId) return sessionId;
  try {
    const saved = globalThis.sessionStorage?.getItem('xkeeps:analytics-session');
    sessionId = saved || randomId();
    if (!saved) globalThis.sessionStorage?.setItem('xkeeps:analytics-session', sessionId);
  } catch { sessionId = randomId(); }
  return sessionId;
}
export function operationId() { return randomId(); }

export function buildEvent(name, details = {}, operation = operationId(), now = Date.now()) {
  if (!NAMES.has(name)) throw new TypeError('Unknown analytics event');
  if (!details || typeof details !== 'object' || Array.isArray(details)) throw new TypeError('Invalid event details');
  if (typeof operation !== 'string' || !/^[0-9a-f-]{36}$/i.test(operation)) throw new TypeError('Invalid operation ID');
  const clean = {};
  for (const [key, value] of Object.entries(details)) {
    if (!EVENT_FIELDS[name].includes(key)) throw new TypeError('Disallowed analytics field');
    if (ENUMS[key] && !ENUMS[key].includes(value)) throw new TypeError('Disallowed analytics value');
    if (COUNTS.has(key) && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError('Invalid analytics count');
    if (FLAGS.has(key) && typeof value !== 'boolean') throw new TypeError('Invalid analytics flag');
    clean[key] = value;
  }
  return {
    schema_version: 1, event_id: randomId(), occurred_at: new Date(now).toISOString(),
    session_id: currentSessionId(), operation_id: operation, app_version: VERSION,
    event_name: name, ...clean,
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: 'event_id' });
      store.createIndex('occurred_at', 'occurred_at');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Analytics storage failed'));
  });
}
export async function track(name, details = {}, operation) {
  const event = buildEvent(name, details, operation);
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const done = transactionDone(tx);
    const store = tx.objectStore(STORE);
    store.put(event);
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      let excess = Math.max(0, countRequest.result - MAX_EVENTS);
      store.index('occurred_at').openCursor().onsuccess = e => {
        const cursor = e.target.result;
        if (!cursor) return;
        if (cursor.key < cutoff || excess > 0) {
          cursor.delete();
          if (excess > 0) excess--;
          cursor.continue();
        }
      };
    };
    await done;
    return event;
  } finally { db.close(); }
}
// Telemetry is never allowed to interrupt a product action.
export function recordEvent(name, details = {}, operation) {
  return track(name, details, operation).catch(() => null);
}
export async function listEvents() {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readonly');
    const done = transactionDone(tx);
    const request = tx.objectStore(STORE).index('occurred_at').getAll();
    await done;
    return request.result;
  } finally { db.close(); }
}
export async function clearEvents() {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore(STORE).clear();
    await done;
  } finally { db.close(); }
}
export function summarizeEvents(events) {
  const counts = {};
  for (const event of events) counts[event.event_name] = (counts[event.event_name] || 0) + 1;
  const successful = name => events.filter(event => event.event_name === name && event.result === 'success').length;
  return { total: events.length, counts,
    successful_exports: successful('archive_export_completed'),
    successful_updates: successful('archive_update_completed'),
    successful_imports: successful('archive_import_completed'),
    successful_media_backups: successful('media_backup_completed'),
    active_days: new Set(events.map(event => event.occurred_at?.slice(0, 10)).filter(Boolean)).size,
  };
}

export function errorClass(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (/429|频率|rate.limit/.test(message)) return 'rate_limit';
  if (/401|403|登录|认证|auth|cookie/.test(message)) return 'auth';
  if (/账号|account/.test(message)) return 'account_mismatch';
  if (/权限|permission|denied|授权/.test(message)) return 'permission';
  if (/取消|cancel|interrupted|中断/.test(message)) return 'download_cancelled';
  if (/json|文件|格式|invalid|parse/.test(message)) return 'invalid_file';
  if (/存储|indexeddb|quota|storage/.test(message)) return 'storage';
  if (/媒体|media|cdn/.test(message)) return 'media_unavailable';
  if (/网络|network|fetch|timeout|超时/.test(message)) return 'network';
  return 'unknown';
}
