import { MAX_ZIP_BYTES, ZipStream, bytesOf, estimateArchiveBytes, summarizeEstimate, validatedMedia, markdownIndex } from './media-backup.js';
import { avatarPrefetch } from './avatar-prefetch.js';
import { offlineHtml } from './offline-view.js';

export function planMediaPackages(document, inventory, maxBytes = MAX_ZIP_BYTES) {
  const metadataBytes = estimateArchiveBytes(document, inventory);
  const mediaBudget = maxBytes - metadataBytes * 2;
  let partCount = 1, used = 0, oversizedCount = 0;
  if (mediaBudget <= 0) return { partCount, oversizedCount, metadataBytes, mediaBudget };
  for (const item of inventory.items) {
    const size = summarizeEstimate({ items: [item], rejected: [] }).estimated_bytes + 256;
    if (size > mediaBudget) { oversizedCount++; continue; }
    if (used && used + size > mediaBudget) { partCount++; used = 0; }
    used += size;
  }
  return { partCount, oversizedCount, metadataBytes, mediaBudget };
}

// Streams independent ZIPs. Directory exports have unique part folders, so
// extracting all parts together cannot overwrite another part's media.
export async function writeMediaPackages({ document, inventory, openPart, openLarge = null,
  fetchImpl = fetch, signal, onProgress = () => {}, maxBytes = MAX_ZIP_BYTES,
  directoryMode = false, language = 'zh-CN', additionalFiles = [] }) {
  const selected = { ...inventory, items: inventory.items.map(item => ({ ...item, tweet_ids: [...item.tweet_ids], status: 'pending', actual_bytes: null })) };
  const plan = planMediaPackages(document, selected, maxBytes);
  const extraBytes = additionalFiles.reduce((total, file) => total + bytesOf(file.body)[0].length + 256, 0);
  plan.metadataBytes += extraBytes;
  plan.mediaBudget -= extraBytes * 2;
  if (plan.mediaBudget <= 0) throw new Error('package_metadata_too_large');
  const reserve = plan.metadataBytes;
  const parts = [];
  let current = null, largeBytes = 0;
  const json = JSON.stringify(document, null, 2) + '\n';
  const aborted = () => signal?.aborted;
  const avatars = avatarPrefetch(selected.items, { fetchImpl, signal });
  async function addText(path, text) {
    const result = await current.zip.add(current.prefix + path, bytesOf(text));
    if (result.failure) throw result.failure;
  }
  async function startPart() {
    const index = parts.length + 1;
    const folder = `part-${String(index).padStart(3, '0')}`;
    const writable = await openPart(index);
    current = { index, folder, prefix: directoryMode ? folder + '/' : '', writable,
      zip: new ZipStream(writable, maxBytes), media: [] };
    await addText('archive.json', json);
    for (const file of additionalFiles) {
      if (!/^archive\.(?:csv|md)$/.test(file.name)) throw new Error('invalid_export_filename');
      await addText(file.name, file.body);
    }
  }
  async function finishPart() {
    const status = (current.media.some(item => item.status !== 'complete') || selected.rejected?.length) ? 'partial' : 'complete';
    const local = { ...selected, items: current.media };
    const manifest = { format: 'xkeeps-media-backup', schema_version: 2, part: current.index,
      status, media: current.media, rejected: selected.rejected || [] };
    await addText('打开查看.html', offlineHtml(document, local, { language, part: directoryMode ? current.index : null, status }));
    await addText('index.md', markdownIndex(document, local));
    await addText('media-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
    await addText('README.txt', language === 'en'
      ? 'Extract the ZIP before opening 打开查看.html. For multiple parts, extract all ZIPs into the selected export folder and open the HTML in that folder. Text and names are included; only complete local media are displayed.\n'
      : '先解压 ZIP，再双击 打开查看.html。多个分包请全部解压到保存文件夹内，再打开该文件夹内的查看页。正文和昵称始终包含，只有成功下载的媒体会显示。\n');
    await current.zip.finish();
    parts.push({ index: current.index, folder: current.folder, bytes: current.zip.offset, status,
      media_count: current.media.filter(item => item.status === 'complete').length });
    current = null;
  }
  async function nextPart() {
    if (!directoryMode) throw new Error('package_requires_directory');
    await finishPart();
    await startPart();
  }
  async function saveLarge(item, response) {
    if (!openLarge) throw new Error('media_file_exceeds_package');
    let writable;
    try { writable = await openLarge(item); }
    catch (error) { throw new Error('storage_write_failed', { cause: error }); }
    let bytes = 0;
    try {
      for await (const chunk of validatedMedia(response, item.type)) {
        if (aborted()) throw new DOMException('Cancelled', 'AbortError');
        try { await writable.write(chunk); }
        catch (error) { throw new Error('storage_write_failed', { cause: error }); }
        bytes += chunk.length;
      }
      try { await writable.close(); }
      catch (error) { throw new Error('storage_write_failed', { cause: error }); }
      item.status = 'complete'; item.actual_bytes = bytes; item.saved_path = `large/${item.path}`;
      largeBytes += bytes;
    } catch (error) { await writable.abort?.().catch(() => {}); throw error; }
  }
  try {
    await startPart();
    for (let index = 0; index < selected.items.length; index++) {
      const item = selected.items[index];
      if (aborted()) { item.status = 'cancelled'; current.media.push({ ...item }); continue; }
      onProgress({ index: index + 1, total: selected.items.length, part: current.index, type: item.type });
      try {
        let response = await avatars.take(index) || await fetchImpl(item.url, { credentials: 'omit', redirect: 'follow', signal });
        const contentLength = Number(response.headers.get('content-length'));
        const knownSize = Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : 0;
        if (knownSize > plan.mediaBudget) { await saveLarge(item, response); continue; }
        if (current.zip.entries.length > 9000 || (knownSize && knownSize > maxBytes - current.zip.offset - reserve - 256)) await nextPart();
        for (let attempt = 0; attempt < 2; attempt++) {
          async function* bounded() {
            for await (const chunk of validatedMedia(response, item.type)) {
              if (aborted()) throw new DOMException('Cancelled', 'AbortError');
              if (current.zip.offset + chunk.length + reserve + 256 > maxBytes) throw new Error('package_limit');
              yield chunk;
            }
          }
          const result = await current.zip.add(current.prefix + item.path, bounded());
          const local = { ...item, actual_bytes: result.size, status: result.failure ? 'partial' : 'complete' };
          current.media.push(local);
          if (!result.failure) {
            item.status = 'complete'; item.actual_bytes = result.size;
            item.saved_path = current.prefix + item.path;
            break;
          }
          if (result.failure.message !== 'package_limit') throw result.failure;
          if (attempt === 0 && directoryMode) {
            await nextPart();
            response = await fetchImpl(item.url, { credentials: 'omit', redirect: 'follow', signal });
          } else {
            if (!openLarge) throw new Error('media_file_exceeds_package');
            response = await fetchImpl(item.url, { credentials: 'omit', redirect: 'follow', signal });
            await saveLarge(item, response);
          }
        }
      } catch (error) {
        // Storage failures are fatal; a failed CDN file remains a visible partial result.
        if (error.name === 'NotAllowedError' || error.name === 'QuotaExceededError'
          || ['storage_write_failed', 'zip_budget_exceeded', 'package_requires_directory'].includes(error.message)) throw error;
        item.status = aborted() || error.name === 'AbortError' ? 'cancelled' : 'failed';
        item.error = String(error.message || error).slice(0, 160);
        const local = current.media.find(record => record.path === item.path);
        if (local) local.error = item.error;
        else current.media.push({ ...item });
      }
    }
    await finishPart();
  } catch (error) {
    await current?.writable.abort?.().catch(() => {});
    throw error;
  } finally { avatars.close(); }
  const counts = Object.fromEntries(['complete', 'failed', 'partial', 'cancelled'].map(status => [status, selected.items.filter(item => item.status === status).length]));
  return { inventory: selected, parts, counts, cancelled: !!signal?.aborted,
    status: selected.items.some(item => item.status !== 'complete') || (selected.rejected || []).length ? 'partial' : 'complete',
    actualBytes: parts.reduce((total, part) => total + part.bytes, largeBytes) };
}
