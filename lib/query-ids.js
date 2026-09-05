/** Discover private GraphQL operation IDs from real requests or X's bundles.
 * IDs can rotate without notice. Never guess an ID from an unrelated string. */
import { updateCredentials } from './identity.js';

const OPERATIONS = ['Bookmarks', 'BookmarkFoldersSlice', 'BookmarkFolderTimeline'];
const BUNDLE_HOSTS = new Set(['abs.twimg.com', 'x.com']);

export function getStoredQueryIds(creds) {
  return Object.fromEntries(OPERATIONS.filter(op => typeof creds?.[`queryId_${op}`] === 'string').map(op => [op, creds[`queryId_${op}`]]));
}

export function hasRequiredQueryIds(ids) { return !!ids.Bookmarks; }

/** Both key orders are explicit; query IDs themselves may start uppercase. */
export function extractIdsFromBundle(js) {
  const ids = {};
  const patterns = [
    /["']?queryId["']?\s*:\s*["']([A-Za-z0-9_-]+)["'][^}]{0,500}?["']?operationName["']?\s*:\s*["']([^"']+)["']/g,
    /["']?operationName["']?\s*:\s*["']([^"']+)["'][^}]{0,500}?["']?queryId["']?\s*:\s*["']([A-Za-z0-9_-]+)["']/g,
  ];
  patterns.forEach((pattern, index) => {
    for (const match of js.matchAll(pattern)) {
      const op = match[index === 0 ? 2 : 1];
      if (OPERATIONS.includes(op)) ids[op] = match[index === 0 ? 1 : 2];
    }
  });
  return ids;
}

async function mayContinue(control) {
  await control.shouldPause?.();
  return !control.shouldStop?.();
}

async function fetchText(url, credentials) {
  const response = await fetch(url, { credentials, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** Fetch only X page HTML and known bundle hosts; never execute bundle code. */
export async function scrapeQueryIdsFromBundles(onLog, control = {}) {
  const ids = {}, visited = new Set();
  for (const page of ['https://x.com', 'https://x.com/i/bookmarks']) {
    if (!await mayContinue(control)) break;
    try {
      onLog?.(`Looking for query IDs in ${page} bundles…`, 'info');
      const html = await fetchText(page, 'include');
      const urls = [...new Set(html.match(/https:\/\/[^"'\s<>]+\.js(?:\?[^"'\s<>]*)?/g) || [])]
        .filter(value => { try { return BUNDLE_HOSTS.has(new URL(value).hostname); } catch { return false; } })
        .sort((a, b) => Number(/client-web|responsive-web/.test(b)) - Number(/client-web|responsive-web/.test(a)))
        .slice(0, 30);
      for (const url of urls) {
        if (!await mayContinue(control)) return Object.keys(ids).length ? ids : null;
        if (visited.has(url)) continue;
        visited.add(url);
        try { Object.assign(ids, extractIdsFromBundle(await fetchText(url, 'omit'))); }
        catch (err) { onLog?.(`Bundle could not be read: ${err.message}`, 'warn'); }
        if (OPERATIONS.every(op => ids[op])) return ids;
      }
    } catch (err) { onLog?.(`Query discovery failed: ${err.message}`, 'warn'); }
  }
  return Object.keys(ids).length ? ids : null;
}

async function captureViaTab(url, userId, wanted, onLog, control) {
  let tabId;
  const started = Date.now();
  try {
    if (!await mayContinue(control)) return null;
    onLog?.('Opening an X tab briefly to capture current query IDs…', 'info');
    tabId = (await chrome.tabs.create({ url, active: false })).id;
    const key = `xarchive_creds_${userId}`;
    while (Date.now() - started < 15_000) {
      if (!await mayContinue(control)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
      const creds = (await chrome.storage.local.get(key))[key];
      // Old cached IDs must not terminate discovery before the tab loads.
      if (wanted.every(op => creds?.[`queryCapturedAt_${op}`] >= started)) return Object.fromEntries(Object.entries(getStoredQueryIds(creds)).filter(([op]) => creds[`queryCapturedAt_${op}`] >= started));
    }
    onLog?.('Current query IDs were not captured. Browse X bookmarks or a folder and try again.', 'warn');
  } catch (err) { onLog?.(`Query capture failed: ${err.message}`, 'warn'); }
  finally { if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {}); }
  return null;
}

export function captureQueryIdsViaTab(userId, onLog, control = {}) {
  return captureViaTab('https://x.com/i/bookmarks', userId, ['Bookmarks'], onLog, control);
}

export async function captureFolderQueryIdViaTab(folderId, userId, onLog, control = {}) {
  // Routing is private and has used both forms. Each attempt is bounded.
  for (const path of [`folder/${encodeURIComponent(folderId)}`, encodeURIComponent(folderId)]) {
    const ids = await captureViaTab(`https://x.com/i/bookmarks/${path}`, userId, ['BookmarkFolderTimeline'], onLog, control);
    if (ids?.BookmarkFolderTimeline) return ids.BookmarkFolderTimeline;
    if (control.shouldStop?.()) break;
  }
  return null;
}

export function storeQueryIds(userId, ids) {
  return updateCredentials(userId, Object.fromEntries(OPERATIONS.filter(op => ids[op]).map(op => [`queryId_${op}`, ids[op]])));
}
