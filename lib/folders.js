/**
 * Bookmark folder enumeration and cross-referencing.
 *
 * Phase 1 of the export fetches the folder list via
 * `BookmarkFoldersSlice`.  Phase 2 iterates through each folder with
 * {@link fetchFolderContents}, recording which tweet IDs belong to
 * which folders.  These mappings are merged into the final JSON in
 * the exporter module.
 *
 * Folders are an X Premium feature — free accounts will return an
 * empty list, which is handled gracefully.
 */

import { parseFolderList } from './parser.js';
import { upsertFolders, saveFolderPage } from './db.js';
import { fetchFolderBookmarks, fetchWithRetry } from './fetcher.js';
import { BASE_DELAY_MS, waitForCollection } from './utils.js';

/**
 * Fetch all bookmark folders for the logged-in user.
 *
 * Handles pagination (though folder lists are typically small) and
 * persists results into IndexedDB.
 *
 * @param {object} opts
 * @param {string}   opts.queryId - GraphQL query ID for "BookmarkFoldersSlice".
 * @param {object}   opts.creds   - Stored auth credentials.
 * @param {Function} [opts.onLog] - Logger callback (message, level).
 * @returns {Promise<{folders: object[], complete: boolean, reason: string}>} Collected folders and list coverage.
 */
export async function fetchAllFolders({ queryId, creds, onLog, beforeRequest, shouldStop, shouldPause, onRateLimit, onCooldown }) {
  if (!queryId) {
    onLog?.('No query ID for BookmarkFoldersSlice. Skipping folders.', 'warn');
    return { folders: [], complete: false, reason: 'missing_query_id' };
  }

  const allFolders = [];
  let cursor = null;
  let complete = false;
  let reason = 'interrupted';
  const cursors = new Set();
  const state = { consecutive429s: 0 };

  while (true) {
    if (shouldPause) await shouldPause();
    if (shouldStop?.()) { reason = 'user_stopped'; break; }
    const variables = {};
    if (cursor) variables.cursor = cursor;

    const request = await fetchWithRetry({ queryId, operationName: 'BookmarkFoldersSlice', variables, creds, state, onLog, beforeRequest, shouldStop, shouldPause, onRateLimit, onCooldown });
    if (request.abort) { reason = request.reason; break; }
    state.consecutive429s = 0;

    const { folders, cursor: nextCursor, valid } = parseFolderList(request.result.data);
    if (!valid) { reason = 'unrecognized_response'; break; }
    allFolders.push(...folders);
    // Persist each page, including when a later request or account check fails.
    await upsertFolders(folders);

    if (!nextCursor) { complete = true; reason = 'complete'; break; }
    if (cursors.has(nextCursor)) { reason = 'pagination_guard'; break; }
    cursors.add(nextCursor);
    cursor = nextCursor;
    await waitForCollection(BASE_DELAY_MS, shouldStop);
  }

  if (allFolders.length > 0) {
    onLog?.(`Found ${allFolders.length} bookmark folder(s).`, 'success');
  } else {
    onLog?.(complete ? 'No bookmark folders returned.' : 'Folder list could not be checked completely; previous assignments are kept.', complete ? 'info' : 'warn');
  }

  return { folders: [...new Map(allFolders.map(f => [f.id, f])).values()], complete, reason };
}

/**
 * Fetch bookmarks for every folder and store tweet-to-folder mappings.
 *
 * Iterates sequentially (one folder at a time) to stay within rate
 * limits.  Respects the caller's stop/pause signals between folders.
 *
 * @param {object} opts
 * @param {Array}    opts.folders          - Folders from {@link fetchAllFolders}.
 * @param {string}   opts.queryId          - Query ID for "BookmarkFolderTimeline".
 * @param {object}   opts.creds            - Stored auth credentials.
 * @param {Function} [opts.onLog]          - Logger callback.
 * @param {Function} [opts.onFolderProgress] - (current, total, folderName).
 * @param {Function} [opts.shouldStop]     - Returns true when user requests stop.
 * @param {Function} [opts.shouldPause]    - Promise that blocks while paused.
 * @param {Function} [opts.onRateLimit]    - Callback on back-off.
 * @param {Function} [opts.onCooldown]     - Callback on cooldown.
 */
export async function fetchFolderContents({
  folders,
  queryId,
  creds,
  onLog,
  onFolderProgress,
  shouldStop,
  shouldPause,
  onRateLimit,
  onCooldown,
  beforeRequest,
  onCoverage,
}) {
  if (!queryId) {
    onLog?.('No query ID for BookmarkFolderTimeline. Skipping folder contents.', 'warn');
    return {};
  }

  const coverage = Object.create(null);

  for (let i = 0; i < folders.length; i++) {
    if (shouldStop?.()) break;

    const folder = folders[i];
    onLog?.(`Fetching folder "${folder.name}" (${i + 1}/${folders.length})...`, 'info');
    onFolderProgress?.(i + 1, folders.length, folder.name);

    let folderTweetCount = 0;

    const result = await fetchFolderBookmarks({
      queryId,
      folderId: folder.id,
      creds,
      onPage: async (tweets) => {
        await saveFolderPage(tweets, folder.id);
        folderTweetCount += tweets.length;
      },
      onRateLimit,
      onCooldown,
      onLog,
      beforeRequest,
      shouldStop,
      shouldPause,
    });

    coverage[folder.id] = result.reason === 'complete' ? 'complete' : 'partial';

    // Persist whatever we collected before checking for early exit.
    if (folderTweetCount > 0) {
      onLog?.(`Folder "${folder.name}": ${folderTweetCount} bookmarks.`, 'info');
    } else {
      onLog?.(result.stopped ? `Folder "${folder.name}": could not finish checking; previous assignments are kept.` : `Folder "${folder.name}": empty.`, result.stopped ? 'warn' : 'info');
    }
    await onCoverage?.({ ...coverage });

    // Break immediately if the folder fetch was stopped mid-flight,
    // rather than sleeping and waiting for the next loop iteration.
    if (result.stopped) break;

    // Rate-limit delay between folders (skip after the last one).
    if (i < folders.length - 1) {
      await waitForCollection(BASE_DELAY_MS, shouldStop);
    }
  }
  return coverage;
}
