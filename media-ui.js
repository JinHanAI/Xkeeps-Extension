import { ExportBatch, fileReceipt } from './lib/export-outcome.js';
import { offerSupport } from './lib/support-ui.js';
import { LikesStore } from './lib/likes-archive.js';
import { getBookmarkCount, getExportState } from './lib/db.js';
import { assembleExport } from './lib/exporter.js';
import { downloadBlob } from './lib/downloads.js';
import { filterPosts, selectedTimeOptions, postTimeCoverage } from './lib/time-range.js';
import { buildMediaInventory, sampleMediaSizes, summarizeEstimate, estimateArchiveBytes, MAX_ZIP_BYTES } from './lib/media-backup.js';
import { planMediaPackages, writeMediaPackages } from './lib/media-package.js';
import { mediaSaveMode, SIMPLE_ZIP_BYTES } from './lib/media-save.js';
import { offlineHtml } from './lib/offline-view.js';
import { buildCsv, buildMarkdown, buildLikesCsv, buildLikesMarkdown } from './lib/export-formats.js';
import { recordEvent, operationId, errorClass } from './lib/analytics.js';

const $ = id => document.getElementById(id);
const bookmarkStore = new XArchive.ArchiveStore();
const likesStore = new LikesStore();
let overview = null;
let prepared = null;
let downloading = false;
let controller = null;
let lastOutcome = null;
let overviewGeneration = 0;
const grantedOrigins = new Set();

function selection() {
  const source = $('content-source').value;
  const range = $(source === 'likes' ? 'likes-range' : 'export-range').value;
  const choices = { photos: $('media-photos').checked, videos: $('media-videos').checked,
    thumbnails: $('media-videos').checked, avatars: $('media-avatars').checked };
  return { source, range, choices };
}

async function accountId() {
  const cookie = await chrome.cookies.get({ url: 'https://x.com', name: 'twid' });
  const id = decodeURIComponent(cookie?.value || '').replaceAll('"', '').replace(/^u=/, '');
  if (!/^\d+$/.test(id)) throw new Error('请登录 X 并确认当前账号后重试。');
  return id;
}

async function selectedDocument(selected, userId, applyTime = true) {
  const time = selectedTimeOptions($(selected.source === 'likes' ? 'likes-export-time' : 'export-time'));
  const slice = document => applyTime ? filterPosts(document, time.period, time) : document;
  if (selected.source === 'likes') {
    const record = await likesStore.get(userId);
    const document = selected.range === 'snapshot' ? record?.snapshot : record?.current;
    if (!document || document.account.user_id !== userId) throw new Error('当前账号没有所选的点赞存档。');
    return slice(document);
  }
  if (selected.range === 'cumulative') {
    const record = await bookmarkStore.get(`user:${userId}`);
    if (!record?.data || record.data.export_metadata?.user_id !== userId) throw new Error('当前账号没有累计收藏存档。');
    return slice(record.data);
  }
  const runInfo = await getExportState('run_info');
  const count = await getBookmarkCount();
  if (runInfo?.user_id !== userId || !runInfo.finished_at || (!count && runInfo.collection?.bookmarks !== 'complete')) throw new Error('当前账号没有可用的收藏快照。');
  return slice(await assembleExport({ userId, screenName: runInfo.screen_name, durationSeconds: runInfo.duration_seconds || 0 }));
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${bytes ? Math.max(1, Math.round(bytes / 1024)) : 0} KiB`;
}
function english() { return XKeepsI18n.language === 'en'; }
function allowed(item, choices) {
  return item.type === 'photo' ? choices.photos : item.type === 'avatar' ? choices.avatars : choices.videos;
}
function selectedInventory(choices) {
  return { items: overview.inventory.items.filter(item => allowed(item, choices)).map(item => ({ ...item, tweet_ids: [...item.tweet_ids] })),
    rejected: overview.inventory.rejected.filter(item => allowed(item, choices)), tweet_count: overview.inventory.tweet_count };
}
function detail(count, bytes, extra = '') {
  return english() ? `${count} files · about ${formatBytes(bytes)}${extra ? ` · ${extra}` : ''}`
    : `${count} 件 · 约 ${formatBytes(bytes)}${extra ? ` · ${extra}` : ''}`;
}
function renderOverview() {
  if (downloading) return;
  const selected = selection();
  const hasMedia = Object.values(selected.choices).some(Boolean);
  const details = $('media-photos').closest('.xk-media-details');
  if (details) for (const selector of ['.media-total', '#media-estimate-result', '.media-actions']) details.querySelector(selector).hidden = !hasMedia;
  if (!overview || selected.source !== overview.source || selected.range !== overview.range) return;
  const all = summarizeEstimate(overview.inventory);
  const inventory = selectedInventory(selected.choices);
  const summary = summarizeEstimate(inventory);
  const textBytes = estimateArchiveBytes(overview.document, { items: [], rejected: [] });
  const count = overview.document.likes?.length ?? overview.document.bookmarks?.length ?? 0;
  const groups = all.byType;
  const photo = groups.photo || { count: 0, estimated_bytes: 0 };
  const video = groups.video || { count: 0, estimated_bytes: 0 };
  const thumbnail = groups.thumbnail || { count: 0, estimated_bytes: 0 };
  const avatar = groups.avatar || { count: 0, estimated_bytes: 0 };
  $('media-text-detail').textContent = english() ? `${count} posts · about ${formatBytes(textBytes)} (JSON, index, manifest)`
    : `${count} 条内容 · 约 ${formatBytes(textBytes)}（JSON、索引、清单）`;
  $('media-photo-detail').textContent = detail(photo.count, photo.estimated_bytes);
  $('media-video-detail').textContent = detail(video.count, video.estimated_bytes + thumbnail.estimated_bytes);
  $('media-avatar-detail').textContent = detail(avatar.count, avatar.estimated_bytes);
  const total = estimateArchiveBytes(overview.document, inventory) + summary.estimated_bytes;
  $('media-total-size').textContent = `${english() ? 'About' : '约'} ${formatBytes(total)}`;
  const plan = planMediaPackages(overview.document, inventory);
  const directoryAvailable = typeof showDirectoryPicker === 'function';
  const singleFileAvailable = typeof showSaveFilePicker === 'function';
  const mode = mediaSaveMode(total, {filePicker:singleFileAvailable, folderPicker:directoryAvailable});
  const directoryMode = mode === 'directory';
  const limit = plan.mediaBudget <= 0 || mode === 'unavailable';
  const tooMany = inventory.items.length > 100000;
  $('media-estimate-result').textContent = tooMany
    ? (english() ? 'Over 100,000 files. Choose a smaller range.' : '媒体超过 100,000 件，请缩小范围。')
    : plan.mediaBudget <= 0
      ? (english() ? 'The records alone are too large. Choose a smaller range.' : '记录数据本身过大，请缩小下载范围。')
      : !directoryAvailable && limit
        ? (english() ? 'This browser cannot save a folder. Select media below 50 MiB.' : '当前浏览器不支持保存文件夹，请将所选媒体缩至 50 MiB 以下。')
        : !directoryMode ? (english() ? 'One ZIP containing records, selected media and a reader. Choose where to save the file.'
          : '可在下载窗口选择保存位置。')
          : (english() ? `About ${plan.partCount} ZIP(s), with an offline reader. Large files require an authorized export subfolder.`
          : `预计 ${plan.partCount} 个压缩包。\n请选择可读取的保存位置。\n请将所有压缩包解压到同一位置。`);
  prepared = { selected, userId: overview.userId, document: overview.document, inventory, summary, total, plan };
  $('media-download').disabled = limit || tooMany;
  window.dispatchEvent(new CustomEvent('xkeeps:media-plan', { detail: { ready: true, partCount: plan.partCount,
    oversizedCount: plan.oversizedCount, directoryMode,
    unavailable: limit || tooMany, message: $('media-estimate-result').textContent } }));
  const needsAccess = inventory.items.some(item => item.url.startsWith('https://pbs.twimg.com/') && !grantedOrigins.has('https://pbs.twimg.com/*')
    || item.url.startsWith('https://video.twimg.com/') && !grantedOrigins.has('https://video.twimg.com/*'));
  $('media-download').textContent = needsAccess ? (english() ? 'Allow media access' : '允许下载')
    : (english() ? 'Download content and media ZIP' : '下载内容和媒体 ZIP');
  $('media-estimate').disabled = !inventory.items.length;
}
async function loadOverview() {
  if (downloading) return;
  const generation = ++overviewGeneration;
  overview = prepared = null;
  window.dispatchEvent(new CustomEvent('xkeeps:media-plan', { detail: { ready: false } }));
  $('media-download').disabled = $('media-estimate').disabled = true;
  for (const id of ['media-text-detail', 'media-photo-detail', 'media-video-detail', 'media-avatar-detail', 'media-total-size']) $(id).textContent = '—';
  $('media-estimate-result').textContent = english() ? 'Reading this account’s local archive…' : '正在读取存档…';
  try {
    const selected = selection();
    const userId = await accountId();
    const raw = await selectedDocument(selected, userId, false);
    const time = selectedTimeOptions($(selected.source === 'likes' ? 'likes-export-time' : 'export-time'));
    const document = filterPosts(raw, time.period, time);
    let snapshotAt = null;
    if (selected.source === 'likes') {
      const record = await likesStore.get(userId);
      snapshotAt = record?.snapshot?.exported_at || null;
    } else {
      const run = await getExportState('run_info');
      snapshotAt = run?.user_id === userId ? run.finished_at || null : null;
    }
    const inventory = buildMediaInventory(document, { photos: true, videos: true, thumbnails: true, avatars: true });
    if (generation !== overviewGeneration || userId !== await accountId()) return;
    overview = { source: selected.source, range: selected.range, userId, document, inventory };
    window.dispatchEvent(new CustomEvent('xkeeps:export-preview', { detail: { source: selected.source, range: selected.range,
      count: document.likes?.length ?? document.bookmarks?.length ?? 0,
      snapshotAt, coverage: postTimeCoverage(raw) } }));
    grantedOrigins.clear();
    renderOverview();
    for (const origin of ['https://pbs.twimg.com/*', 'https://video.twimg.com/*']) {
      if (await chrome.permissions.contains({ origins: [origin] })) grantedOrigins.add(origin);
    }
    if (generation === overviewGeneration) renderOverview();
  } catch (error) {
    if (generation === overviewGeneration) {
      $('media-estimate-result').textContent = error.message;
      const selected = selection();
      window.dispatchEvent(new CustomEvent('xkeeps:export-preview', { detail: { source: selected.source, range: selected.range, error: true } }));
    }
  }
}
for (const id of ['content-source', 'export-range', 'likes-range']) $(id).addEventListener('change', loadOverview);
window.addEventListener('xkeeps:time-change', event => {
  if (event.target.id === 'export-time' || event.target.id === 'likes-export-time') loadOverview();
});
for (const id of ['media-photos', 'media-videos', 'media-avatars']) $(id).addEventListener('change', () => {
  if (downloading) return;
  lastOutcome = null; $('media-progress').textContent = ''; renderOverview();
});
window.addEventListener('xkeeps:archive-changed', loadOverview);
window.addEventListener('xkeeps:language-changed', () => { renderOverview(); renderOutcome(); });
loadOverview();
function renderOutcome() {
  if (!lastOutcome) return;
  const result = lastOutcome;
  if (result.kind === 'cancelled') $('media-progress').textContent = result.partCount
    ? (english() ? `Cancelled. ${result.partCount} saved ZIP(s) were retained; the reader shows saved media only.`
      : `已取消；保留 ${result.partCount} 个已保存 ZIP，查看页仅显示已保存的媒体。`)
    : (english() ? 'Save cancelled. Check browser downloads; previously saved files were retained.' : '已取消保存，请检查下载列表；已保存文件保留。');
  else if (result.kind === 'saved') $('media-progress').textContent = english()
    ? `Saved ${result.partCount} ZIP(s): ${result.completed} media complete, ${result.failed} failed. Extract all ZIPs and open 打开查看.html.`
    : `已保存 ${result.partCount} 个 ZIP：${result.completed} 件媒体完整、${result.failed} 件失败。全部解压后双击“打开查看.html”。`;
  else $('media-progress').textContent = english()
    ? `ZIP incomplete: ${XKeepsI18n.translate(result.message)}. Check the save location or choose fewer media types, then retry.`
    : `ZIP 未完成：${result.message}。请检查保存位置或减少媒体类别后重试。`;
}

$('media-estimate').addEventListener('click', async () => {
  if (downloading || !prepared?.inventory.items.length) return;
  recordEvent('media_estimate_viewed', { source: prepared.selected.source,
    item_count: prepared.document.likes?.length ?? prepared.document.bookmarks?.length ?? 0,
    media_count: prepared.inventory.items.length, estimated_bytes: Math.round(prepared.total) });
  const selected = selection();
  const origins = [];
  if (prepared.inventory.items.some(item => item.url.startsWith('https://pbs.twimg.com/'))) origins.push('https://pbs.twimg.com/*');
  if (prepared.inventory.items.some(item => item.url.startsWith('https://video.twimg.com/'))) origins.push('https://video.twimg.com/*');
  // Optional refinement is the explicit gesture for CDN permission and a few HEAD requests.
  const permissionPromise = chrome.permissions.request({ origins });
  $('media-estimate').disabled = true;
  $('media-estimate-result').textContent = english() ? 'Checking a small media sample…' : '正在检查少量媒体样本…';
  try {
    if (!await permissionPromise) throw new Error('媒体主机权限未授予；本地粗估仍可用于选择。');
    for (const origin of origins) grantedOrigins.add(origin);
    const inventory = selectedInventory(selected.choices);
    await sampleMediaSizes(inventory);
    if (selected.source !== overview?.source || selected.range !== overview?.range || JSON.stringify(selected) !== JSON.stringify(selection())) return;
    const sampled = new Map(inventory.items.map(item => [item.url, item]));
    for (const item of overview.inventory.items) {
      const updated = sampled.get(item.url);
      if (updated?.estimate_source === 'head') { item.expected_bytes = updated.expected_bytes; item.estimate_source = 'head'; }
    }
    renderOverview();
  } catch (error) { $('media-estimate-result').textContent = english() ? XKeepsI18n.translate(error.message) : error.message; }
  finally { if (overview) $('media-estimate').disabled = false; }
});

class MemoryWritable {
  constructor() { this.chunks = []; this.size = 0; }
  async write(bytes) { this.chunks.push(bytes.slice()); this.size += bytes.length; }
  async close() {}
  async abort() { this.chunks = []; this.size = 0; }
  blob() { return new Blob(this.chunks, { type: 'application/zip' }); }
}

$('media-cancel').addEventListener('click', () => controller?.abort());
async function downloadMediaSelected(request = {}) {
  const batch = new ExportBatch({ operationId: request.operationId || operationId(), entry: request.operationId ? 'home' : 'media', itemCount: prepared?.document.likes?.length ?? prepared?.document.bookmarks?.length ?? 0 });
  if (!prepared || downloading || $('media-download').disabled) return batch.finish('error');
  const selected = selection();
  if (JSON.stringify(selected) !== JSON.stringify(prepared.selected)) { renderOverview(); return batch.finish('error'); }
  const origins = [];
  if (prepared.inventory.items.some(item => item.url.startsWith('https://pbs.twimg.com/'))) origins.push('https://pbs.twimg.com/*');
  if (prepared.inventory.items.some(item => item.url.startsWith('https://video.twimg.com/'))) origins.push('https://video.twimg.com/*');
  const missing = origins.filter(origin => !grantedOrigins.has(origin));
  if (missing.length) {
    // Permission prompts and the system save picker both need a user gesture; keep them separate.
    const permissionPromise = chrome.permissions.request({ origins: missing });
    if (await permissionPromise) {
      for (const origin of missing) grantedOrigins.add(origin);
      renderOverview();
      $('media-progress').textContent = english() ? 'Media access ready. Click Download selected content again to choose a save location.'
        : '已允许读取媒体。\n再次点击“开始下载”选择位置。';
    } else $('media-progress').textContent = english() ? 'Media access was not granted. Uncheck media types to download the data files.'
      : '未允许读取媒体。\n取消媒体勾选后可下载记录。';
    return batch.finish('cancelled');
  }
  const data = structuredClone({ ...prepared, document: request.document || prepared.document });
  // Keep the folder picker directly in the click gesture. Each export gets a
  // unique child folder, never overwriting files already owned by the user.
  const mode = mediaSaveMode(data.total, {filePicker:typeof showSaveFilePicker === 'function', folderPicker:typeof showDirectoryPicker === 'function'});
  const streamFile = mode === 'file';
  const directoryMode = mode === 'directory';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const handle = (data.document.account?.screen_name || data.document.export_metadata?.screen_name || 'account').replace(/[^A-Za-z0-9_-]/g, '_');
  const name = `Xkeeps_${handle}_${selected.source}_${stamp}_${crypto.randomUUID().slice(0, 8)}`;
  let pickerPromise;
  try { pickerPromise = directoryMode ? showDirectoryPicker({ mode: 'readwrite' })
    : streamFile ? showSaveFilePicker({ suggestedName: name + '.zip', types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }] }) : null; }
  catch (error) { lastOutcome = { kind: 'error', message: error.message }; renderOutcome(); return batch.finish('error'); }
  downloading = true;
  $('media-download').disabled = $('media-estimate').disabled = true;
  $('media-cancel').hidden = false;
  controller = new AbortController();
  let telemetryId = null, telemetryStart = 0, result = null;
  const telemetry = { source: selected.source,
    item_count: data.document.likes?.length ?? data.document.bookmarks?.length ?? 0,
    media_count: data.inventory.items.length, estimated_bytes: Math.round(data.total) };
  try {
    const destination = pickerPromise ? await pickerPromise : null;
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (data.userId !== await accountId()) throw new Error('X 账号已经切换，未开始下载。');
    if (!directoryMode && !streamFile && data.total > SIMPLE_ZIP_BYTES) throw new Error('当前浏览器不支持流式保存文件，请将所选媒体缩至 50 MiB 以下。');
    telemetryId = batch.outcome.operationId; telemetryStart = Date.now();
    recordEvent('media_backup_started', telemetry, telemetryId);
    const folder = directoryMode ? await destination.getDirectoryHandle(name, { create: true }) : null;
    let memory = null;
    async function createFile(path) {
      const segments = path.split('/');
      let destination = folder;
      for (const segment of segments.slice(0, -1)) destination = await destination.getDirectoryHandle(segment, { create: true });
      batch.require(path);
      const handle = await destination.getFileHandle(segments.at(-1), { create: true });
      const writable = await handle.createWritable();
      return { write: bytes => writable.write(bytes), abort: () => writable.abort(),
        async close() { await writable.close(); batch.saved(path, fileReceipt()); } };
    }
    const formats = request.formats || [];
    const likes = selected.source === 'likes';
    const additionalFiles = formats.filter(format => ['csv', 'markdown'].includes(format)).map(format => ({
      name: format === 'csv' ? 'archive.csv' : 'archive.md',
      body: format === 'csv' ? (likes ? buildLikesCsv(data.document) : buildCsv(data.document))
        : (likes ? buildLikesMarkdown(data.document) : buildMarkdown(data.document)),
    }));
    result = await writeMediaPackages({ document: data.document, inventory: data.inventory, additionalFiles,
      directoryMode, language: english() ? 'en' : 'zh-CN', signal: controller.signal,
      maxBytes: directoryMode || streamFile ? MAX_ZIP_BYTES : SIMPLE_ZIP_BYTES,
      openPart: async index => {
        if (folder) return createFile(`part-${String(index).padStart(3, '0')}.zip`);
        if (streamFile) {
          batch.require('media.zip'); const writable = await destination.createWritable();
          return { write: bytes => writable.write(bytes), abort: () => writable.abort(),
            async close() { await writable.close(); batch.saved('media.zip', fileReceipt()); } };
        }
        batch.require('media.zip'); memory = new MemoryWritable(); return memory;
      },
      openLarge: folder ? item => createFile(`large/${item.path}`) : null,
      onProgress: progress => {
        const labels = { avatar: ['作者头像', 'author avatars'], photo: ['文章配图', 'post images'], video: ['视频 / GIF', 'videos / GIFs'], thumbnail: ['视频封面', 'video thumbnails'] };
        const label = labels[progress.type] || ['媒体', 'media'];
        $('media-progress').textContent = english()
          ? `Downloading and packaging ${label[1]} · ${progress.index}/${progress.total}${directoryMode ? ` · ZIP ${progress.part}` : ' · one ZIP with records and reader'}`
          : `正在下载并打包${label[0]} · ${progress.index}/${progress.total}${directoryMode ? ` · 第 ${progress.part} 个 ZIP` : ' · 与 JSON、查看页合并为一个 ZIP'}`;
      },
    });
    if (folder) {
      const manifest = { format: 'xkeeps-media-backup', schema_version: 2, status: result.status,
        source: selected.source, range: selected.range, exported_at: new Date().toISOString(),
        parts: result.parts, counts: result.counts, media: result.inventory.items, rejected: result.inventory.rejected };
      const files = [
        ['打开查看.html', offlineHtml(data.document, result.inventory, { language: english() ? 'en' : 'zh-CN', root: true, status: result.status })],
        ['media-manifest.json', JSON.stringify(manifest, null, 2) + '\n'],
        ['README.txt', english() ? 'Extract all part-*.zip files into this export folder. Then double-click 打开查看.html. Keep the part-* and large folders beside the reader.\n'
          : '将所有 part-*.zip 解压到当前保存文件夹内，再双击 打开查看.html。保留查看页旁的 part-* 和 large 文件夹。\n'],
      ];
      for (const [path, body] of files) {
        const writable = await createFile(path);
        try { await writable.write(body); await writable.close(); }
        catch (error) { await writable.abort().catch(() => {}); throw error; }
      }
    } else if (!streamFile) {
      const downloaded = await downloadBlob(memory.blob(), name + '.zip', { userId: data.userId, source: selected.source });
      batch.saved('media.zip', downloaded);
      if (downloaded.state !== 'complete') throw new Error('浏览器无法确认下载完成，请检查下载列表。');
    }
    batch.media(result);
    lastOutcome = { kind: result.cancelled ? 'cancelled' : 'saved', completed: result.counts.complete,
      failed: result.counts.failed + result.counts.partial + (result.inventory.rejected?.length || 0),
      partCount: result.parts.length, status: result.status };
    renderOutcome();
  } catch (error) {
    const cancelled = error?.name === 'AbortError' || errorClass(error) === 'download_cancelled';
    batch.outcome.result = cancelled ? 'cancelled' : 'error';
    lastOutcome = cancelled ? { kind: 'cancelled' } : { kind: 'error', message: error.message };
    renderOutcome();
  } finally {
    if (telemetryId) recordEvent('media_backup_completed', { ...telemetry, actual_bytes: result?.actualBytes || 0,
      package_count: result?.parts.length || 0, complete_media_count: result?.counts.complete || 0,
      failed_media_count: (result?.counts.failed || 0) + (result?.counts.partial || 0) + (result?.inventory.rejected?.length || 0),
      duration_ms: Date.now() - telemetryStart,
      result: lastOutcome?.kind === 'saved' ? (lastOutcome.status === 'complete' ? 'success' : 'partial')
        : lastOutcome?.kind === 'cancelled' ? 'cancelled' : 'error',
      ...(lastOutcome?.kind === 'error' ? { error_class: errorClass(lastOutcome.message) } : {}),
    }, telemetryId);
    downloading = false; controller = null;
    $('media-cancel').hidden = true;
    if (overview && (selection().source !== overview.source || selection().range !== overview.range)) loadOverview();
    else renderOverview();
  }
  const outcome = batch.finish();
  if (!request.operationId) await offerSupport(outcome, $('media-progress'));
  return outcome;
}
$('media-download').addEventListener('click', () => downloadMediaSelected());
window.addEventListener('xkeeps:download-media-request', event => {
  downloadMediaSelected(event.detail).then(event.detail.resolve, () => event.detail.resolve(null));
});

window.addEventListener('xkeeps:export-document', event => {
  if (prepared && JSON.stringify(prepared.selected) === JSON.stringify(selection())) event.detail.document = structuredClone(prepared.document);
});
