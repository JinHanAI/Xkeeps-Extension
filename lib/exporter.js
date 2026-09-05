/**
 * JSON assembly and download.
 *
 * {@link assembleExport} reads all bookmarks and folders from IndexedDB,
 * merges in folder assignments, and returns the final JSON structure.
 * {@link downloadJSON} triggers the browser download.
 */

import { getAllBookmarks, getAllFolders, buildFolderMap, getExportState } from './db.js';
import { VERSION } from '../version.js';

/**
 * Build the final export payload from IndexedDB.
 *
 * Merges folder assignments into each bookmark's `folders` array and
 * computes summary statistics for the metadata header.
 *
 * @param {object} opts
 * @param {string}      opts.userId          - Logged-in user's numeric ID.
 * @param {string|null} opts.screenName      - User's @handle (may be null).
 * @param {number}      opts.durationSeconds - How long the export took.
 * @returns {Promise<object>} Complete JSON-serialisable export object.
 */
export async function assembleExport({ userId, screenName, durationSeconds }) {
  const run = await getExportState('run_info');
  const bookmarks = await getAllBookmarks();
  const folders = await getAllFolders();
  const folderMap = await buildFolderMap();

  // Build id→name lookup so bookmarks get human-readable folder names.
  const folderNameById = new Map(folders.map((f) => [f.id, f.name]));

  // Merge folder names into each bookmark.
  for (const bm of bookmarks) {
    const folderIds = folderMap.get(bm.tweet_id);
    bm.folder_ids = [...new Set(folderIds || [])];
    bm.folders = bm.folder_ids.map((id) => folderNameById.get(id) || id);
  }

  const availableCount = bookmarks.filter((b) => b.status === 'available').length;

  return {
    export_metadata: {
      tool: 'xarchive',
      schema_version: 2,
      kind: 'snapshot',
      version: VERSION,
      exported_at: run?.finished_at || run?.observed_at || null,
      user_id: run ? run.user_id || 'unknown' : userId || 'unknown',
      screen_name: run ? run.screen_name || null : screenName || null,
      collection: run?.collection || { bookmarks: 'unknown', folders: 'unknown', reason: 'legacy_run' },
      stats: {
        total_bookmarks: bookmarks.length,
        available_bookmarks: availableCount,
        unavailable_bookmarks: bookmarks.length - availableCount,
        total_folders: folders.length,
        export_duration_seconds: durationSeconds,
      },
    },
    folders: folders.map((f) => ({ id: f.id, name: f.name })),
    bookmarks,
  };
}

/**
 * Trigger a browser download of the export JSON.
 *
 * Uses `chrome.downloads` (preferred in MV3) with a fallback to a
 * programmatic `<a>` click for environments where the API is unavailable.
 *
 * @param {object} data     - The export payload from {@link assembleExport}.
 * @param {string} nameHint - Screen name or user ID for the filename.
 * @returns {Promise<string>} The requested filename; rejects if Chrome refuses/cancels it.
 */
export async function downloadJSON(data, nameHint) {
  // Escape Unicode line/paragraph separators (U+2028, U+2029).
  // JSON.stringify preserves them as raw bytes, which is valid JSON but
  // triggers "unusual line terminators" warnings in editors like VS Code.
  const json = JSON.stringify(data, null, 2)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().split('T')[0];
  const safeName = String(nameHint || 'bookmarks').replace(/[^a-zA-Z0-9_-]/g, '_');
  const kind = data.export_metadata?.kind === 'cumulative' ? '_combined' : '';
  const filename = `xarchive_${safeName}_${date}${kind}.json`;

  try {
  if (globalThis.chrome?.downloads) {
    await new Promise((resolve, reject) => chrome.downloads.download({ url, filename, saveAs: true }, () => {
      const error = chrome.runtime?.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    }));
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  } finally { setTimeout(() => URL.revokeObjectURL(url), 60_000); }
  return filename;
}
