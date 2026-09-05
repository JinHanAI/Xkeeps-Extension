/**
 * IndexedDB storage layer via Dexie.
 *
 * The latest scan's staging data lives here:
 *   - **bookmarks** — one row per bookmarked tweet, keyed by `tweet_id`.
 *   - **folders** — bookmark folder metadata (X Premium feature).
 *   - **folder_tweets** — many-to-many mapping of tweets to folders.
 *   - **export_state** — key-value pairs for tracking export progress.
 *
 * These tables are cleared at the start of each scan via {@link clearAllData}.
 * Cumulative archives and undo copies live separately in lib/archive.js.
 */

import Dexie from '../vendor/dexie.mjs';
import './archive.js';

const db = new Dexie('xarchive');

db.version(1).stores({
  bookmarks: 'tweet_id, sort_index, status, created_at',
  folders: 'id, name',
  folder_tweets: '++id, tweet_id, folder_id, [tweet_id+folder_id]',
  export_state: 'key',
});

// ---------------------------------------------------------------------------
// Bookmark operations
// ---------------------------------------------------------------------------

/**
 * Bulk-upsert an array of bookmarks.
 * @param {object[]} bookmarks
 */
export async function upsertBookmarks(bookmarks) {
  await db.transaction('rw', db.bookmarks, async () => {
    const existing = await db.bookmarks.bulkGet(bookmarks.map(b => b.tweet_id));
    // A tweet may appear in several folders and the main timeline in one scan.
    // Preserve content if a later occurrence is a tombstone or sparse response.
    const records = new Map(existing.filter(Boolean).map(b => [b.tweet_id, b]));
    for (const b of bookmarks) {
      const old = records.get(b.tweet_id);
      const merged = old ? XArchive.mergeFields(old, b) : b;
      if (b.status === 'available') delete merged.unavailable_reason;
      records.set(b.tweet_id, merged);
    }
    await db.bookmarks.bulkPut([...records.values()]);
  });
}

/** Persist each folder page and its membership evidence together. */
export async function saveFolderPage(tweets, folderId) {
  await db.transaction('rw', db.bookmarks, db.folder_tweets, async () => {
    await upsertBookmarks(tweets);
    await addFolderTweets(tweets.map(b => ({ tweet_id: b.tweet_id, folder_id: folderId })));
  });
}

/** @returns {Promise<object[]>} All stored bookmarks. */
export async function getAllBookmarks() {
  return db.bookmarks.toArray();
}

/** @returns {Promise<number>} Total bookmark count. */
export async function getBookmarkCount() {
  return db.bookmarks.count();
}

// ---------------------------------------------------------------------------
// Folder operations
// ---------------------------------------------------------------------------

/**
 * Bulk-upsert an array of folders.
 * @param {Array<{id: string, name: string}>} folders
 */
export async function upsertFolders(folders) {
  await db.folders.bulkPut(folders);
}

/** @returns {Promise<Array<{id: string, name: string}>>} All folders. */
export async function getAllFolders() {
  return db.folders.toArray();
}

// ---------------------------------------------------------------------------
// Folder-tweet mapping
// ---------------------------------------------------------------------------

/**
 * Batch-add folder-tweet mappings.
 *
 * Pagination can repeat records. Export assembly deduplicates memberships.
 *
 * @param {Array<{tweet_id: string, folder_id: string}>} entries
 */
export async function addFolderTweets(entries) {
  if (entries.length > 0) {
    await db.folder_tweets.bulkAdd(entries);
  }
}

/**
 * Build a lookup map from tweet ID to an array of folder IDs.
 *
 * Used once during export assembly to merge folder assignments into
 * the final JSON without per-bookmark queries.
 *
 * @returns {Promise<Map<string, string[]>>}
 */
export async function buildFolderMap() {
  const allEntries = await db.folder_tweets.toArray();
  const map = new Map();
  for (const entry of allEntries) {
    if (!map.has(entry.tweet_id)) {
      map.set(entry.tweet_id, []);
    }
    map.get(entry.tweet_id).push(entry.folder_id);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Export state
// ---------------------------------------------------------------------------

/**
 * Persist a key-value pair for export state tracking.
 * @param {string} key
 * @param {*} value
 */
export async function saveExportState(key, value) {
  await db.export_state.put({ key, value, updated_at: Date.now() });
}

/**
 * Read a previously persisted export state value.
 * @param {string} key
 * @returns {Promise<*|null>}
 */
export async function getExportState(key) {
  const record = await db.export_state.get(key);
  return record ? record.value : null;
}

// ---------------------------------------------------------------------------
// Full reset
// ---------------------------------------------------------------------------

/** Atomically reset staging tables; never touches cumulative archive storage. */
export async function clearAllData() {
  await db.transaction('rw', db.tables, async () => {
    await Promise.all(db.tables.map(table => table.clear()));
  });
}
