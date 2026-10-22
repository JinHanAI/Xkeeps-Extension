import './archive.js';
import { validateLikes } from './likes-archive.js';
import { safeMediaUrl, buildMediaInventory, MAX_ZIP_BYTES } from './media-backup.js';
import { writeMediaPackages } from './media-package.js';

export function readBrowseArchive(data) {
  const source = data?.source === 'likes' || data?.format === 'xkeeps-likes' ? 'likes' : 'bookmarks';
  if (source === 'likes') validateLikes(data); else XArchive.validate(data);
  return { document: data, source, userId: source === 'likes' ? data.account.user_id : XArchive.accountId(data) || '',
    items: source === 'likes' ? data.likes : data.bookmarks, folders: source === 'likes' ? [] : data.folders || [] };
}

export function browseSummary(data, source, fallbackName = '') {
  const meta = source === 'likes' ? data?.account : data?.export_metadata;
  const rawDate = source === 'likes' ? data?.exported_at : data?.export_metadata?.exported_at;
  return { name: meta?.screen_name || fallbackName || '',
    at: rawDate && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null,
    count: (source === 'likes' ? data?.likes : data?.bookmarks)?.length || 0 };
}

export function selectedDocument(data, ids) {
  const { source, items } = readBrowseArchive(data);
  const selected = new Set(ids);
  const doc = structuredClone(data);
  const field = source === 'likes' ? 'likes' : 'bookmarks';
  doc[field] = items.filter(item => selected.has(item.tweet_id));
  if (!doc[field].length) throw new Error('没有可下载的内容。');
  if (source === 'likes') {
    doc.collection = { ...doc.collection, coverage: 'partial', reason: 'selected_items' };
    doc.last_full_refresh_at = null;
  } else {
    doc.export_metadata = { ...doc.export_metadata, collection: { ...doc.export_metadata?.collection,
      bookmarks: 'partial', folders: 'unknown', folder_list: 'unknown', folder_contents: {}, reason: 'selected_items' } };
    const folders = new Set(doc.bookmarks.flatMap(item => item.folder_ids || []));
    doc.folders = (doc.folders || []).filter(folder => folders.has(folder.id));
    if (doc.archive_metadata) doc.archive_metadata.last_full_refresh_at = null;
  }
  return doc;
}

export function postInventory(document) {
  const inventory = buildMediaInventory(document, { photos: true, videos: true, thumbnails: true, avatars: true });
  for (const item of document.bookmarks || document.likes || []) {
    if (!item.author?.profile_image_url) inventory.rejected.push({ tweet_id: item.tweet_id, type: 'avatar', reason: 'avatar_not_recorded' });
  }
  return inventory;
}

// The same ZIP writer as Home. A single post never silently switches to
// multiple files; unavailable media remain explicit in the manifest/reader.
export async function writePostPackage({ document, inventory = postInventory(document), writable,
  fetchImpl, signal, onProgress, maxBytes = MAX_ZIP_BYTES, language }) {
  return writeMediaPackages({ document, inventory, openPart: async () => writable,
    fetchImpl, signal, onProgress, maxBytes, language, directoryMode: false });
}

export function previewVideoUrl(medium) {
  const variants = (medium.variants || []).filter(v => v.content_type === 'video/mp4' && safeMediaUrl(v.url));
  variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return safeMediaUrl((variants.find(v => v.bitrate <= 1200000) || variants.at(-1))?.url);
}
