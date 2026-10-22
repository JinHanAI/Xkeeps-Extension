import { ExportBatch, fileReceipt } from './lib/export-outcome.js';
import { offerSupport } from './lib/support-ui.js';
import { readBrowseArchive, browseSummary, selectedDocument, postInventory, writePostPackage, previewVideoUrl } from './lib/browse-archive.js';
import { formatPostTimestamp } from './lib/time-range.js';
import { LikesStore } from './lib/likes-archive.js';
import { buildCsv, buildMarkdown, buildLikesCsv, buildLikesMarkdown, exportFilename, likesFilename } from './lib/export-formats.js';
import { downloadBlob } from './lib/downloads.js';
import { safeMediaUrl, validatedMedia } from './lib/media-backup.js';
import { recordEvent, operationId, errorClass } from './lib/analytics.js';

const $ = id => document.getElementById(id);
const bookmarkStore = new XArchive.ArchiveStore();
const likesStore = new LikesStore();
let generation = 0;
let loaded = { items: [], folders: [], index: null, source: '', userId: '' };
let debounce;
let fileArchive = null;
const english = () => globalThis.XKeepsI18n?.language === 'en';
const copy = (zh, en) => english() ? en : zh;
const previewCache = new Map();
async function loadPreview(image, url, refresh = false) {
  if (refresh && previewCache.has(url)) {
    previewCache.get(url).then(value => URL.revokeObjectURL(value)).catch(() => {});
    previewCache.delete(url);
  }
  try {
    // Reuse already granted CDN access; never prompt just to show a preview.
    if (!await chrome.permissions.contains({ origins: [new URL(url).origin + '/*'] })) { const direct = new URL(url); if (refresh) direct.searchParams.set('xkeeps_preview_retry', String(Date.now())); image.src = direct.href; return; }
    if (!previewCache.has(url)) previewCache.set(url, (async () => {
      const response = await fetch(url, { credentials: 'omit', redirect: 'follow', ...(refresh ? { cache:'reload' } : {}) });
      const chunks = []; let bytes = 0;
      for await (const chunk of validatedMedia(response, 'photo')) {
        bytes += chunk.length; if (bytes > 5 * 1024 * 1024) throw new Error('preview_too_large'); chunks.push(chunk);
      }
      return URL.createObjectURL(new Blob(chunks, { type: response.headers.get('content-type') }));
    })());
    const local = await previewCache.get(url);
    if (image.isConnected) image.src = local;
    if (previewCache.size > 50) { const oldest = previewCache.keys().next().value; previewCache.get(oldest).then(value => URL.revokeObjectURL(value)).catch(() => {}); previewCache.delete(oldest); }
  } catch { if (image.isConnected) image.dispatchEvent(new Event('error')); }
}
window.addEventListener('pagehide', () => { for (const promise of previewCache.values()) promise.then(url => URL.revokeObjectURL(url)).catch(() => {}); previewCache.clear(); });

async function downloadOneMedia(item, medium, button) {
  if (button.disabled) return;
  const originalLabel = button.textContent; button.disabled = true;
  try {
  const video = ['video','animated_gif'].includes(medium.type);
  const variants = (medium.variants || []).filter(v => /video\/mp4/i.test(v.content_type || '') && safeMediaUrl(v.url));
  variants.sort((a,b) => (b.bitrate || 0) - (a.bitrate || 0));
  const url = video ? variants[0]?.url : medium.url;
  if (!safeMediaUrl(url)) throw new Error('这项媒体没有可下载的有效链接。');
  const origin = new URL(url).origin + '/*';
  if (!await chrome.permissions.contains({ origins: [origin] })) {
    if (!await chrome.permissions.request({ origins: [origin] })) throw new Error('未取得媒体域名访问权限。');
  }
  const started = Date.now(); const telemetryId = operationId(); let bytes = 0;
  const telemetry = { source: loaded.source, media_type: video ? 'video' : 'photo' };
  const batch = new ExportBatch({ operationId: telemetryId, entry: 'browse', itemCount: 1 }); batch.require('media');
  recordEvent('browse_media_download_started', telemetry, telemetryId);
  button.disabled = true; button.textContent = copy('下载中…', 'Downloading…');
  try {
    const response = await fetch(url, { credentials: 'omit', redirect: 'follow' });
    const chunks=[];
    for await (const chunk of validatedMedia(response, video ? 'video' : 'photo')) {
      bytes += chunk.length;
      if (bytes > 200 * 1024 * 1024) throw new Error('单个文件超过 200 MiB，请用首页的内容下载功能保存。');
      chunks.push(chunk);
    }
    const type = response.headers.get('content-type')?.split(';')[0] || (video ? 'video/mp4' : 'image/jpeg');
    const suffix = video ? 'mp4' : ({ 'image/png':'png','image/gif':'gif','image/webp':'webp' }[type] || 'jpg');
    const result = await downloadBlob(new Blob(chunks,{type}),`Xkeeps_${video ? 'video' : 'image'}_${item.tweet_id}.${suffix}`);
    batch.saved('media', result);
    batch.media({ status: 'complete', counts: { complete: 1 }, inventory: { items: [], rejected: [] } });
    $('search-status').textContent = result.state === 'complete' ? copy('下载完成。', 'Download complete.') : copy('已请求下载；请检查浏览器下载列表。', 'Download requested; check browser downloads.');
    recordEvent('browse_media_download_completed', { ...telemetry, actual_bytes: bytes, duration_ms: Date.now() - started, result: result.state === 'complete' ? 'success' : 'partial' }, telemetryId);
    await offerSupport(batch.finish(), $('search-status'));
  } catch (error) {
    recordEvent('browse_media_download_completed', { ...telemetry, actual_bytes: bytes, duration_ms: Date.now() - started, result: errorClass(error) === 'download_cancelled' ? 'cancelled' : 'error', error_class: errorClass(error) }, telemetryId); throw error;
  }
  } finally { button.disabled = false; button.textContent = originalLabel; }
}
const chosen = new Set();
let lastFiltered = [];
const toolbar = document.createElement('div');
toolbar.className = 'xk-selection-toolbar';
const selectPage = document.createElement('button'); selectPage.type = 'button'; selectPage.className = 'secondary'; selectPage.textContent = '全选本页';
const clearSelection = document.createElement('button'); clearSelection.type = 'button'; clearSelection.className = 'secondary'; clearSelection.textContent = '取消全选';
const exportSelection = document.createElement('button'); exportSelection.type = 'button'; exportSelection.textContent = '下载记录';
const selectionStatus = document.createElement('span'); selectionStatus.className = 'help';
toolbar.append(selectPage, clearSelection, exportSelection, selectionStatus);
$('search-results').before(toolbar);
const exportDialog = document.createElement('dialog');
exportDialog.className = 'xk-export-dialog';
exportDialog.innerHTML = '<form method="dialog"><h2>下载内容</h2><p class="help" id="xk-export-summary"></p><label>文件格式 <select id="xk-export-format"><option value="json">记录文件</option><option value="csv">表格文件</option><option value="markdown">阅读文件</option></select></label><p class="help" id="xk-export-message" role="status"></p><div class="button-row"><button value="cancel" class="secondary">取消</button><button id="xk-export-confirm" value="download">下载</button></div></form>';
document.body.append(exportDialog);
function updateSelection() { selectionStatus.textContent = copy(`已选择 ${chosen.size} 条`, `${chosen.size} selected`); exportSelection.disabled = !chosen.size; }
function selectionChanged() { updateSelection(); recordEvent('browse_selection_changed', { source: loaded.source, selected_count: chosen.size }); }
selectPage.addEventListener('click', () => { for (const position of lastFiltered.slice(0, 50)) chosen.add(loaded.items[position].tweet_id); render(); selectionChanged(); });
clearSelection.addEventListener('click', () => { chosen.clear(); render(); selectionChanged(); });
exportSelection.addEventListener('click', () => openExport([...chosen]));
exportDialog.addEventListener('close', () => { if (exportDialog.returnValue === 'download') submitExport().catch(error => { $('search-status').textContent = `导出失败：${error.message}`; }); });
let pendingIds = []; let pendingDocument; let pendingSource; let browseExportBusy = false;
function openExport(ids) { if (browseExportBusy) return; pendingIds = ids; pendingDocument = selectedDocument(loaded.document, ids); pendingSource = loaded.source; $('xk-export-summary').textContent = `准备导出 ${ids.length} 条${loaded.source === 'likes' ? '点赞' : '收藏'}。媒体文件不包含在这些格式中。`; $('xk-export-message').textContent = ''; exportDialog.showModal(); }
async function submitExport() {
  if (browseExportBusy) return;
  const frozenDocument = structuredClone(pendingDocument), frozenSource = pendingSource;
  const selected = frozenDocument?.bookmarks || frozenDocument?.likes || [];
  if (!selected.length) throw new Error('没有可导出的内容。');
  const format = $('xk-export-format').value;
  const telemetryId = operationId(); const telemetryStart = Date.now();
  const batch = new ExportBatch({ operationId: telemetryId, entry: 'browse', itemCount: selected.length }); batch.require(format);
  browseExportBusy = true;
  const telemetry = { source: frozenSource, format, scope: 'selection', period: 'all', item_count: selected.length };
  recordEvent('archive_export_started', telemetry, telemetryId);
  try {
  const now = new Date();
  const doc = frozenDocument;
  const likes = frozenSource === 'likes';
  const filename = likes ? likesFilename(doc, format, now) : exportFilename(doc, format, now);
  const body = format === 'json' ? JSON.stringify(doc, null, 2) + '\n'
    : format === 'csv' ? (likes ? buildLikesCsv(doc) : buildCsv(doc)) : (likes ? buildLikesMarkdown(doc) : buildMarkdown(doc));
  const mime = format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/markdown';
  const result = await downloadBlob(new Blob([body], { type: `${mime};charset=utf-8` }), filename,
    null);
  batch.saved(format, result);
  $('search-status').textContent = result.state === 'complete' ? `已下载 ${filename}，共 ${selected.length} 条。` : '已请求下载；请检查浏览器下载列表。';
  recordEvent('archive_export_completed', { ...telemetry, duration_ms: Date.now() - telemetryStart,
    result: result.state === 'complete' ? 'success' : 'partial' }, telemetryId);
  await offerSupport(batch.finish(), $('search-status'));
  } catch (error) {
    recordEvent('archive_export_completed', { ...telemetry, duration_ms: Date.now() - telemetryStart,
      result: 'error', error_class: errorClass(error) }, telemetryId);
    throw error;
  } finally { browseExportBusy = false; }
}

const archiveInfo = document.createElement('div'); archiveInfo.className = 'xk-browse-archive';
const archiveDetails = document.createElement('div');
const archiveActions = document.createElement('div'); archiveActions.className = 'button-row';
const changeArchive = document.createElement('button'); changeArchive.type = 'button'; changeArchive.className = 'secondary';
const returnArchive = document.createElement('button'); returnArchive.type = 'button'; returnArchive.className = 'secondary';
const browseFile = document.createElement('input'); browseFile.type = 'file'; browseFile.accept = '.json,application/json'; browseFile.hidden = true;
const browseFileStatus = document.createElement('p'); browseFileStatus.className = 'help'; browseFileStatus.setAttribute('role', 'status');
archiveActions.append(changeArchive, returnArchive); archiveInfo.append(archiveDetails, archiveActions, browseFileStatus, browseFile);
$('search-title').before(archiveInfo);
changeArchive.addEventListener('click', () => { browseFile.value = ''; browseFile.click(); });
returnArchive.addEventListener('click', () => { fileArchive = null; browseFileStatus.textContent = ''; reload(); });
browseFile.addEventListener('change', async () => {
  const file = browseFile.files?.[0]; if (!file) return;
  changeArchive.disabled = true;
  try {
    if (file.size > 100 * 1024 * 1024) throw new Error('存档文件超过 100 MiB，暂不支持在此打开。');
    const next = readBrowseArchive(JSON.parse(await file.text()));
    fileArchive = { ...next, fileName: file.name };
    $('content-source').value = next.source;
    $('content-source').dispatchEvent(new Event('change'));
    browseFileStatus.textContent = copy('仅浏览此文件，当前账号记录未改变。', 'Viewing this file only. Saved account records are unchanged.');
  } catch (error) { browseFileStatus.textContent = copy(`无法打开存档：${XArchive.errorTextZh(error.message)}`, `Cannot open archive: ${error.message}`); }
  finally { changeArchive.disabled = false; }
});
function renderArchiveSummary() {
  const summary = loaded.summary || { name: '', at: null, count: 0 };
  archiveDetails.replaceChildren();
  $('search-title').nextElementSibling.textContent = copy(fileArchive ? '搜索已保存的正文、作者或链接。' : '搜索已保存的正文、作者或链接。', fileArchive ? 'Search this archive. Searching does not contact X.' : 'Search saved items for this account. Searching does not contact X.');
  const account = document.createElement('strong'); account.className = 'search-hit-author xk-summary-account'; account.textContent = summary.name ? `@${summary.name}` : copy('昵称未知', 'Account name not recorded');
  const facts = document.createElement('p'); facts.className = 'help';
  const date = summary.at ? new Date(summary.at).toLocaleString(english() ? 'en-US' : 'zh-CN') : copy('未记录', 'Not recorded');
  facts.textContent = copy(`保存时间：${date} · ${summary.count.toLocaleString()} 条${loaded.source === 'likes' ? '点赞' : '收藏'}`, `Saved: ${date} · ${summary.count.toLocaleString()} ${loaded.source === 'likes' ? 'liked posts' : 'bookmarks'}`);
  const location = document.createElement('p'); location.className = 'help xk-archive-location';
  location.textContent = fileArchive ? copy(`文件：${fileArchive.fileName}\n浏览器未提供完整路径。`, `File: ${fileArchive.fileName} (the browser does not expose its full directory path)`)
    : copy('保存位置：此浏览器内。\n尚未关联电脑中的存档文件。', 'Location: extension storage in this browser; no external file is linked.');
  archiveDetails.append(account, facts, location);
  if (loaded.exportedFile) { const last = document.createElement('p'); last.className = 'help xk-archive-location'; last.textContent = copy(`最近下载：${loaded.exportedFile}`, `Last exported file: ${loaded.exportedFile}`); archiveDetails.append(last); }
  changeArchive.textContent = copy('更换存档', 'Change archive'); returnArchive.textContent = copy('账号存档', 'Back to account archive'); returnArchive.hidden = !fileArchive;
}
async function downloadPost(item, button) {
  if (button.disabled) return;
  const source = loaded.source;
  const telemetryId = operationId(); const started = Date.now();
  const batch = new ExportBatch({ operationId: telemetryId, entry: 'browse', itemCount: 1 }); batch.require('post.zip');
  const telemetry = { source, format: 'zip', scope: 'selection', period: 'all', item_count: 1 };
  let writable;
  button.disabled = true;
  try {
    if (!/^\d+$/.test(item.tweet_id)) throw new Error('此条记录缺少有效的帖子编号。');
    const document = selectedDocument(loaded.document, [item.tweet_id]);
    const inventory = postInventory(document);
    const origins = [...new Set(inventory.items.map(file => new URL(file.url).origin + '/*'))];
    if (origins.length && !await chrome.permissions.contains({ origins })) {
      if (!await chrome.permissions.request({ origins })) throw new Error('未取得媒体访问权限。');
      $('search-status').textContent = copy('媒体权限已就绪，请再次点击“下载整条”选择保存位置。', 'Media access is ready. Click Download post again to choose a save location.'); return;
    }
    const filename = `Xkeeps_post_${item.tweet_id}.zip`;
    const chunks = []; let bytes = 0;
    const streamToDisk = typeof window.showSaveFilePicker === 'function';
    if (streamToDisk) {
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }] });
      writable = await handle.createWritable();
    } else writable = { async write(chunk) { bytes += chunk.length; if (bytes > 200 * 1024 * 1024) throw new Error('当前浏览器仅支持 200 MiB 内的单条下载，请使用首页下载。'); chunks.push(chunk.slice()); }, async close() {}, async abort() { chunks.length = 0; } };
    recordEvent('archive_export_started', telemetry, telemetryId);
    button.textContent = copy('打包中…', 'Packaging…');
    const result = await writePostPackage({ document, inventory, writable, maxBytes: streamToDisk ? undefined : 200 * 1024 * 1024,
      language: english() ? 'en' : 'zh-CN', onProgress: progress => {
        $('search-status').textContent = copy(`正在打包整条内容：媒体 ${progress.index}/${progress.total}…`, `Packaging post: media ${progress.index}/${progress.total}…`);
      } });
    const saved = streamToDisk ? fileReceipt() : await downloadBlob(new Blob(chunks, { type: 'application/zip' }), filename);
    batch.saved('post.zip', saved); batch.media(result);
    const missing = result.counts.failed + result.counts.partial + result.inventory.rejected.length;
    $('search-status').textContent = saved.state !== 'complete' ? copy('已请求下载 ZIP；请检查浏览器下载列表。', 'ZIP download requested; check browser downloads.')
      : result.status === 'complete' ? copy('整条内容已保存为 ZIP，包含昵称、头像、正文和媒体；解压后打开“打开查看.html”。', 'Post saved as ZIP with author, avatar, text and media. Extract it and open 打开查看.html.')
      : copy(`已保存 ZIP；${missing} 项媒体未保存或未记录，请查看包内清单。`, `ZIP saved; ${missing} media items were unavailable or not recorded. See its manifest.`);
    recordEvent('archive_export_completed', { ...telemetry, duration_ms: Date.now() - started, result: result.status === 'complete' && saved.state === 'complete' ? 'success' : 'partial' }, telemetryId);
    await offerSupport(batch.finish(), $('search-status'));
  } catch (error) {
    await writable?.abort?.().catch(() => {});
    $('search-status').textContent = error.name === 'AbortError' ? copy('已取消下载。', 'Download cancelled.') : copy(`整条下载失败：${error.message}`, `Post download failed: ${error.message}`);
    recordEvent('archive_export_completed', { ...telemetry, duration_ms: Date.now() - started, result: error.name === 'AbortError' ? 'cancelled' : 'error', error_class: errorClass(error) }, telemetryId);
  } finally { button.disabled = false; button.textContent = copy('下载整条', 'Download post'); }
}

async function currentUserId() {
  const cookie = await chrome.cookies.get({ url: 'https://x.com', name: 'twid' });
  const id = decodeURIComponent(cookie?.value || '').replaceAll('"', '').replace(/^u=/, '');
  return /^\d+$/.test(id) ? id : null;
}

function stopPreviewVideos(release = false) { for (const video of $('search-results').querySelectorAll('video')) { video.pause(); if (release) { video.removeAttribute('src'); video.load(); } } }
function clear() { stopPreviewVideos(true); $('search-results').replaceChildren(); }
window.addEventListener('xkeeps:page-changed', event => { if (event.detail.page !== 'browse') stopPreviewVideos(); });
window.addEventListener('pagehide', () => stopPreviewVideos(true));

async function reload() {
  const request = ++generation;
  const source = $('content-source').value;
  loaded = { items: [], folders: [], index: null, source, userId: '' };
  clear();
  $('search-status').textContent = '正在读取存档…';
  $('search-folder-field').hidden = source !== 'bookmarks';
  try {
    const userId = fileArchive ? fileArchive.userId : sessionStorage.getItem('xkeeps:view-account') || await currentUserId();
    if (!userId && !fileArchive) throw new Error('请先在账号页选择本地存档，或登录 X。');
    const record = fileArchive ? null : source === 'likes' ? await likesStore.get(userId) : await bookmarkStore.get(`user:${userId}`);
    if (request !== generation) return;
    const data = fileArchive?.document || (source === 'likes' ? record?.current : record?.data);
    const items = source === 'likes' ? data?.likes || [] : data?.bookmarks || [];
    const folders = source === 'bookmarks' ? data?.folders || [] : [];
    const index = await XKeepsSearch.createIndexAsync(items);
    const local = await chrome.storage.local.get([`xarchive_profile_${userId}`, 'xkeeps_last_download']);
    if (request !== generation) return;
    loaded = { items, folders, index, source, userId, document: data, revision: record?.revision ?? null,
      summary: browseSummary(data, source, local[`xarchive_profile_${userId}`]),
      exportedFile: !fileArchive && local.xkeeps_last_download?.userId === userId && local.xkeeps_last_download?.source === source ? local.xkeeps_last_download.path : null };
    renderArchiveSummary();
    recordEvent('browse_archive_opened', { source, origin: fileArchive ? 'file' : 'browser', item_count: items.length });
    chosen.clear(); updateSelection();
    const select = $('search-folder');
    select.replaceChildren(new Option('全部文件夹', ''));
    for (const folder of folders) {
      if (typeof folder.id === 'string') select.add(new Option(folder.name || folder.id, folder.id));
    }
    select.value = '';
    render();
  } catch (error) {
    if (request === generation) { $('search-status').textContent = error.message; renderArchiveSummary(); }
  }
}

function render() {
  clear();
  renderArchiveSummary();
  const { items, index, source } = loaded;
  if (!index) return;
  const matches = index.search($('local-search').value);
  const folder = source === 'bookmarks' ? $('search-folder').value : '';
  const indices = matches ? [...matches] : items.map((_, position) => position);
  let filtered = folder ? indices.filter(position => items[position].folder_ids?.includes(folder)) : indices;
  const period = document.querySelector('#page-browse .xk-time-control .selected')?.dataset.period || 'all';
  const days = { week: 7, month: 30, half: 183, year: 365 }[period];
  if (days) { const from = Date.now() - days * 86400000; filtered = filtered.filter(position => Date.parse(items[position].created_at || '') >= from); }
  filtered.sort((left, right) => Date.parse(items[right].created_at || 0) - Date.parse(items[left].created_at || 0));
  lastFiltered = filtered;
  $('search-status').textContent = copy(`${fileArchive ? '当前存档' : '当前账号本地保存'} ${items.length.toLocaleString()} 条；匹配 ${filtered.length.toLocaleString()} 条${filtered.length > 50 ? '，显示前 50 条' : ''}。`, `${fileArchive ? 'Archive' : 'Saved locally'}: ${items.length.toLocaleString()}; matches: ${filtered.length.toLocaleString()}${filtered.length > 50 ? '; showing the first 50' : ''}.`);
  const fragment = document.createDocumentFragment();
  for (const position of filtered.slice(0, 50)) {
    const item = items[position];
    const card = document.createElement('article');
    card.className = 'search-hit';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = chosen.has(item.tweet_id);
    checkbox.setAttribute('aria-label', copy(`选择帖子 ${item.tweet_id}`, `Select post ${item.tweet_id}`));
    checkbox.addEventListener('change', () => { if (checkbox.checked) chosen.add(item.tweet_id); else chosen.delete(item.tweet_id); selectionChanged(); });
    const header = document.createElement('div');
    header.className = 'search-hit-header';
    const author = document.createElement('div'); author.className = 'search-hit-author xk-author';
    const portrait = document.createElement('span'); portrait.className = 'xk-avatar';
    const fallback = document.createElement('span'); fallback.textContent = Array.from(item.author?.name || '?')[0];
    portrait.append(fallback);
    const avatarUrl = safeMediaUrl(item.author?.profile_image_url);
    if (avatarUrl) {
      const image = document.createElement('img'); loadPreview(image, avatarUrl); image.alt = copy(`${item.author?.name || '作者'}的头像`, `${item.author?.name || 'Author'} avatar`); image.loading = 'lazy';
      image.addEventListener('error', () => { image.remove(); portrait.title = copy('头像暂不可用', 'Avatar unavailable'); }); portrait.append(image);
    }
    const identity = document.createElement('span'); identity.className = 'xk-author-identity';
    const name = document.createElement('strong'); name.textContent = item.author?.name || XKeepsI18n.translate('作者未知');
    const handle = document.createElement('span'); handle.className = 'help'; handle.textContent = item.author?.screen_name ? `@${item.author.screen_name}` : '';
    identity.append(name, handle); author.append(portrait, identity);
    const date = document.createElement('time');
    date.textContent = copy('发布时间：', 'Published: ') + formatPostTimestamp(item.created_at, english() ? 'en' : 'zh-CN');
    if (item.created_at && Number.isFinite(Date.parse(item.created_at))) date.dateTime = item.created_at;
    header.append(author, date);
    const body = document.createElement('p');
    body.className = 'search-hit-body';
    body.textContent = item.full_text || XKeepsI18n.translate('内容缺失');
    const link = document.createElement('a');
    link.href = `https://x.com/i/status/${item.tweet_id}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = '查看原帖 ↗';
    const actions = document.createElement('div'); actions.className = 'xk-hit-actions';
    const single = document.createElement('button'); single.type = 'button'; single.className = 'secondary'; single.textContent = '下载整条'; single.addEventListener('click', () => downloadPost(item, single));
    actions.append(link, single);
    const previews = document.createElement('div'); previews.className = 'xk-media-previews';
    for (const medium of (item.media || []).slice(0, 8)) {
      const video = ['video', 'animated_gif'].includes(medium.type);
      const candidate = safeMediaUrl(video ? medium.thumbnail_url : medium.url || medium.thumbnail_url);
      const mediaCard = document.createElement('div'); mediaCard.className = 'xk-media-card';
      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'xk-media-preview';
      const normalLabel = copy(video ? '播放视频' : '下载图片', video ? 'Play video' : 'Download image');
      preview.setAttribute('aria-label', normalLabel);
      let retryPreview = null;
      if (candidate) {
        const img = document.createElement('img');
        const unavailable = document.createElement('span'); unavailable.className = 'help xk-preview-retry'; unavailable.hidden = true;
        let failed = false;
        img.alt = medium.alt_text || copy(video ? '视频封面' : '文章配图', video ? 'Video thumbnail' : 'Post image'); img.loading = 'lazy';
        img.addEventListener('error', () => {
          failed = true; img.hidden = true; unavailable.hidden = false; preview.disabled = false;
          unavailable.textContent = copy('重新加载 ↻', 'Preview unavailable · Retry ↻');
          const retryLabel = copy('重新加载', 'Retry image preview');
          preview.setAttribute('data-i18n-original-aria-label', retryLabel); preview.setAttribute('aria-label', retryLabel); preview.classList.add('has-preview-error');
        });
        img.addEventListener('load', () => {
          failed = false; img.hidden = false; unavailable.hidden = true; preview.disabled = false;
          preview.setAttribute('data-i18n-original-aria-label', normalLabel); preview.setAttribute('aria-label', normalLabel); preview.classList.remove('has-preview-error');
        });
        retryPreview = () => {
          if (!failed) return false;
          preview.disabled = true; unavailable.textContent = copy('正在重新加载…', 'Reloading…');
          img.loading = 'eager'; img.removeAttribute('src'); loadPreview(img, candidate, true); return true;
        };
        preview.append(img, unavailable); loadPreview(img, candidate);
      }
      if (video) { const play = document.createElement('span'); play.className = 'xk-video-play'; play.textContent = '▶'; play.setAttribute('aria-hidden', 'true'); preview.append(play); }
      else if (!candidate) preview.textContent = copy('图片未保存', 'Image unavailable');
      const info = document.createElement('span'); info.className = 'help xk-media-info';
      const seconds = Math.round((medium.duration_ms || 0) / 1000);
      info.textContent = video ? `${medium.type === 'animated_gif' ? 'GIF' : copy('视频', 'Video')}${seconds ? ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : ''}` : copy('文章配图', 'Post image');
      const mediaButton = document.createElement('button'); mediaButton.type = 'button'; mediaButton.className = 'secondary'; mediaButton.textContent = copy(video ? '下载视频' : '下载图片', video ? 'Download video' : 'Download image');
      const download = async () => { if (mediaButton.disabled) return; preview.disabled = true;
        try { await downloadOneMedia(item, medium, mediaButton); }
        catch (error) { $('search-status').textContent = copy(`媒体下载失败：${error.message}`, `Media download failed: ${error.message}`); }
        finally { preview.disabled = false; } };
      mediaButton.addEventListener('click', download);
      if (video) preview.addEventListener('click', () => {
        if (retryPreview?.()) return;
        const url = previewVideoUrl(medium);
        if (!url) { info.textContent = copy('视频播放链接未记录，可尝试打开原帖。', 'Video URL not recorded; try opening the original post.'); return; }
        // Start native playback in the click gesture. Download remains separate.
        for (const other of $('search-results').querySelectorAll('video')) other.pause();
        const player = document.createElement('video'); player.className = 'xk-inline-video';
        player.controls = true; player.playsInline = true; player.preload = 'none';
        player.setAttribute('aria-label', copy('视频预览', 'Video preview'));
        const source = loaded.source; const telemetryId = operationId(); let reported = false;
        recordEvent('browse_video_preview_started', { source }, telemetryId);
        const report = result => { if (!reported) { reported = true; recordEvent('browse_video_preview_result', { source, result }, telemetryId); } };
        player.addEventListener('playing', () => report('success'), { once: true });
        player.addEventListener('error', () => {
          report('error'); player.remove(); preview.hidden = false; mediaCard.classList.remove('is-playing');
          info.textContent = copy('视频暂时无法播放，可下载后查看或打开原帖。', 'Video unavailable; download it or open the original post.');
        }, { once: true });
        preview.hidden = true; mediaCard.classList.add('is-playing'); preview.after(player); player.src = url;
        player.play().catch(error => {
          if (error.name !== 'AbortError' && player.isConnected) { report('error'); info.textContent = copy('请点击视频播放器的播放按钮；若无法播放，可下载后查看。', 'Use the player’s play button; if unavailable, download the video.'); }
        });
      });
      else preview.addEventListener('click', () => { if (!retryPreview?.()) download(); });
      mediaCard.append(preview, info, mediaButton); previews.append(mediaCard);
    }
    card.append(checkbox, header, body, previews, actions);
    fragment.append(card);
  }
  $('search-results').append(fragment);
  updateSelection();
}

$('content-source').addEventListener('change', () => { if (fileArchive && fileArchive.source !== $('content-source').value) fileArchive = null; reload(); });
$('local-search').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => {
  render(); recordEvent('browse_filter_applied', { source: loaded.source, filter_type: 'text', match_count: lastFiltered.length });
}, 300); });
$('search-folder').addEventListener('change', () => { render(); recordEvent('browse_filter_applied', { source: loaded.source, filter_type: 'folder', match_count: lastFiltered.length }); });
window.addEventListener('focus', () => {
  // Returning to an unchanged list must not reset selection or video playback.
  if (fileArchive) return;
  (async () => {
    const source = $('content-source').value;
    const userId = sessionStorage.getItem('xkeeps:view-account') || await currentUserId();
    if (source !== loaded.source || userId !== loaded.userId) return reload();
    const record = source === 'likes' ? await likesStore.get(userId) : await bookmarkStore.get(`user:${userId}`);
    if ((record?.revision ?? null) !== loaded.revision) await reload();
  })().catch(() => {});
});
window.addEventListener('xkeeps:archive-changed', reload);
window.addEventListener('xkeeps:language-changed', render);
window.addEventListener('xkeeps:view-account-changed', () => { fileArchive = null; reload(); });
window.addEventListener('xkeeps:time-change', event => { if (event.target.closest('#page-browse')) {
  render(); recordEvent('browse_filter_applied', { source: loaded.source, filter_type: 'time', match_count: lastFiltered.length });
} });
reload();
