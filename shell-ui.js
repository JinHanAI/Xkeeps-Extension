import { ExportBatch } from './lib/export-outcome.js';
import { offerSupport, mountSupportSettings } from './lib/support-ui.js';
import { LikesStore } from './lib/likes-archive.js';
import { getExportState, clearAllData } from './lib/db.js';
import { recordEvent, operationId, listEvents, clearEvents, summarizeEvents } from './lib/analytics.js';
import { downloadBlob } from './lib/downloads.js';
import { formatUpdateTime } from './lib/update-status.js';
import { VERSION } from './version.js';

// The existing collector and archive modules keep their DOM nodes and state.
// This shell only gives those modules a coherent navigation with a separate feedback entry.
const $ = id => document.getElementById(id);
const oldRoot = document.querySelector('.container');
const node = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
};
const pages = {};
const titles = {
  home: ['首页', 'Home'], browse: ['浏览', 'Browse'],
  accounts: ['账号', 'Accounts'], settings: ['设置', 'Settings'],
  feedback: ['问题反馈', 'Feedback'], author: ['关于作者', 'About the author'],
};
const icons = {
  home: '<path d="m3 10 9-7 9 7v11h-7v-7h-4v7H3z"/>',
  browse: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
  accounts: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m19 13 2 1-2 4-2-1a8 8 0 0 1-3 2l-.5 2h-4L9 19a8 8 0 0 1-3-2l-2 1-2-4 2-1a8 8 0 0 1 0-3l-2-1 2-4 2 1a8 8 0 0 1 3 2l2-1 2 4-2 1a8 8 0 0 1 0 3Z"/>',
};
icons.feedback = '<path d="M21 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 19 0Z"/><path d="M7 9h9M7 13h6"/>';
icons.author = '<rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="8" cy="10" r="2"/><path d="M5 16a3 3 0 0 1 6 0M15 9h4M15 13h4"/>';
const footerPages = new Set(['feedback', 'author']);
const english = () => globalThis.XKeepsI18n?.language === 'en';

const original = {
  header: oldRoot.querySelector('header'), source: oldRoot.querySelector('.source-card'),
  search: $('search-title').closest('section'), media: $('media-backup-section'),
  connection: $('status-section'), schedule: $('schedule-section'),
  library: $('library-section'), likes: $('likes-panel'), progress: $('progress-section'),
  log: $('log-section'), result: $('result-section'), footer: oldRoot.querySelector('footer'),
};

const sidebar = node('aside', 'xk-sidebar');
const brand = node('div', 'xk-brand');
brand.innerHTML = `<img class="xk-brand-icon" src="icons/icon48.png" alt=""><span class="xk-brand-copy"><span>Xkeeps</span><small class="xk-version">v${VERSION}</small></span>`;
const nav = node('nav', 'xk-nav');
nav.setAttribute('aria-label', 'Xkeeps');
const footerNav = node('nav', 'xk-sidebar-footer');
footerNav.setAttribute('aria-label', '反馈与作者');
const main = node('main', 'xk-main');
for (const [id, labels] of Object.entries(titles)) {
  const button = node('button', 'xk-nav-item');
  button.type = 'button'; button.dataset.page = id;
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[id]}</svg><span>${labels[0]}</span>`;
  (footerPages.has(id) ? footerNav : nav).append(button);
  if (footerPages.has(id)) continue;
  const page = node('section', 'xk-page'); page.id = `page-${id}`;
  page.setAttribute('aria-label', labels[0]);
  pages[id] = page;
  main.append(page);
}
sidebar.append(brand, nav, footerNav);
oldRoot.replaceChildren(sidebar, main);
oldRoot.classList.add('xk-shell');

const homeLead = node('div', 'xk-page-lead');
const homeTitle = node('h1', '', '我的内容');
const homeDescription = node('p', 'help', '保存和下载你的收藏与点赞。');
homeLead.append(homeTitle, homeDescription);
pages.home.append(homeLead, original.source);
original.header.classList.add('xk-legacy-header');
pages.home.append(original.header);

const archiveBanner = node('div', 'xk-archive-banner');
const bannerText = node('div', 'xk-archive-copy');
bannerText.append(node('strong', '', '正在读取存档…'), node('p', 'help', '存档保存在此 Chrome 的扩展存储中。'));
const importButton = node('button', 'secondary xk-small', '导入存档');
importButton.type = 'button';
importButton.title = 'JSON 可合并存档；CSV 和 Markdown 仅供预览';
const clearButton = node('button', 'secondary xk-small xk-danger', '清空记录');
clearButton.type = 'button';
clearButton.disabled = true;
const filePicker = node('input'); filePicker.type = 'file'; filePicker.accept = '.json,.csv,.md,application/json,text/csv,text/markdown'; filePicker.hidden = true;
const filePreview = node('dialog','xk-file-preview');
const previewTitle = node('h2'); const previewText = node('pre');
const closePreview = node('button','secondary','关闭'); closePreview.type = 'button'; closePreview.addEventListener('click',()=>filePreview.close());
filePreview.append(previewTitle,previewText,closePreview); document.body.append(filePreview);
function receiveFile(file) {
  if (!file) return;
  if (/\.json$/i.test(file.name)) {
    const target = $('content-source').value === 'likes' ? $('likes-file') : $('library-file');
    const transfer = new DataTransfer(); transfer.items.add(file); target.files = transfer.files;
    target.dispatchEvent(new Event('change',{bubbles:true}));
  } else if (/\.(csv|md)$/i.test(file.name)) {
    file.text().then(content => { previewTitle.textContent = `${file.name} · 只读预览`;
      previewText.textContent = `${content.slice(0,100000)}${content.length > 100000 ? '\n…文件较长，仅显示前 100000 字符' : ''}`;
      filePreview.showModal(); });
  } else alert('请选择 JSON、CSV 或 Markdown 文件。');
}
filePicker.addEventListener('change',()=>{receiveFile(filePicker.files?.[0]);filePicker.value='';});
importButton.addEventListener('click', () => filePicker.click());
const bannerActions = node('div', 'xk-banner-actions');
bannerActions.append(importButton, clearButton);
archiveBanner.append(bannerText, bannerActions);
archiveBanner.append(filePicker);
const updateGroup = node('section', 'card xk-update-group');
pages.home.append(updateGroup);
const updateStage = node('div', 'xk-stage');
const updateTitle = node('h2');
const updateDescription = node('p', 'help');
updateStage.append(updateTitle, updateDescription);
updateGroup.append(updateStage, archiveBanner, original.library, original.likes);
original.library.classList.remove('card');
original.likes.querySelector('section').classList.remove('card');
for (const section of [original.library, original.likes.querySelector('section')]) {
  const scan = section.querySelector('.workflow-update');
  const exportTitle = section.querySelector('.export-controls')?.previousElementSibling;
  if (scan && exportTitle) section.insertBefore(scan, exportTitle);
  if (exportTitle?.tagName === 'H3') exportTitle.remove();
}
const bookmarkWorkflow = original.library.querySelector('.workflow-update');
bookmarkWorkflow?.append(original.progress, original.result, original.log);
bookmarkWorkflow?.querySelector('.section-label')?.after($('library-refresh'));
original.library.querySelector('.archive-actions')?.after($('library-status'));
$('library-status').after(bookmarkWorkflow);
original.likes.querySelector('.archive-actions')?.after($('likes-status'));
$('likes-status').after(original.likes.querySelector('.workflow-update'));
for (const section of [original.progress, original.log, original.result]) section.classList.remove('card');
const exportTime = makeTimeControl('export-time', true);
const likesExportTime = makeTimeControl('likes-export-time', true);
const downloadGroup = node('section', 'xk-download-group');
const downloadLead = node('div', 'xk-stage');
const downloadTitle = node('h2');
const downloadDescription = node('p', 'help');
downloadLead.append(downloadTitle, downloadDescription);
const scopeCard = node('section', 'card xk-download-scope');
scopeCard.append(node('h2', '', '下载范围'));
const scopeHelp = node('p', 'help', '按原帖发布时间筛选。');
scopeCard.append(scopeHelp);
const snapshotHelp = node('p', 'help xk-snapshot-time'); snapshotHelp.hidden = true;
scopeCard.append(snapshotHelp);
const bookmarkScope = node('div', 'xk-scope-fields');
const likesScope = node('div', 'xk-scope-fields');
bookmarkScope.append($('export-range').closest('.form-field'), exportTime.wrapper);
likesScope.append($('likes-range').closest('.form-field'), likesExportTime.wrapper);
scopeCard.append(bookmarkScope, likesScope);
const exportPreview = node('p', 'help xk-export-preview', '正在统计内容…');
exportPreview.setAttribute('role', 'status');
scopeCard.append(exportPreview);

const fileCard = node('section', 'card xk-file-download');
fileCard.append(node('h2', '', '下载选项'));
const formatOptions = node('div', 'xk-format-options');
const formatChecks = new Map();
for (const [format, title, description] of [
  ['json', '记录文件', 'JSON格式，便于再次导入和对比。'],
  ['csv', '表格文件', 'CSV格式，便于表格整理和查看。'],
  ['markdown', '阅读文件', 'Markdown格式，便于阅读正文。'],
]) {
  const label = node('label', 'xk-download-option');
  const input = node('input'); input.type = 'checkbox'; input.checked = format === 'json';
  label.append(input, node('span', '', title), node('small', 'help', description));
  formatChecks.set(format, input);
  formatOptions.append(label);
}
fileCard.append(node('h3', 'section-label', '文件类型'), formatOptions,
  node('p', 'help', '记录含正文和昵称；下方可保存媒体。'));
const bookmarkFile = node('div');
bookmarkFile.append(original.library.querySelector('.export-controls'), $('export-status'));
const likesFile = node('div');
likesFile.append(original.likes.querySelector('.export-controls'), $('likes-export-status'));
bookmarkFile.className = likesFile.className = 'xk-internal-export';
fileCard.append(bookmarkFile, likesFile);
const mediaDetails = node('div', 'xk-media-details');
for (const selector of ['.media-breakdown', '.media-total', '#media-estimate-result', '.media-actions', '#media-progress']) {
  const item = original.media.querySelector(selector);
  if (item) mediaDetails.append(item);
}
mediaDetails.querySelector('#media-download').hidden = true;
mediaDetails.querySelector('.media-fixed').hidden = true;
for (const selector of ['.media-total', '#media-estimate-result', '.media-actions']) mediaDetails.querySelector(selector).hidden = true;
for (const id of ['media-avatars', 'media-photos', 'media-videos']) mediaDetails.querySelector(`#${id}`).checked = id === 'media-avatars';
mediaDetails.querySelector('#media-avatars').closest('label').querySelector('strong').textContent = '作者头像';
const mediaChecks = ['media-avatars', 'media-photos', 'media-videos'].map(id => mediaDetails.querySelector(`#${id}`));
const hasMediaSelected = () => mediaChecks.some(input => input.checked);
fileCard.append(mediaDetails);
const downloadOutput = node('p', 'help xk-download-output'); downloadOutput.id = 'xk-download-output';
downloadOutput.setAttribute('role', 'status');
let mediaPlan = null;
function renderDownloadOutput() {
  if (hasMediaSelected() && mediaPlan?.unavailable) { downloadOutput.textContent = mediaPlan.message; return; }
  const formats = [...formatChecks].filter(([, check]) => check.checked).map(([format]) => format === 'markdown' ? 'Markdown' : format.toUpperCase());
  const labels = formats.map(format => {
    const label = english() ? `1 ${format} file` : `1 个 ${format} 文件`;
    return format === 'JSON' && mediaChecks[0].checked
      ? label + (english() ? ' (including text, names and author avatar information)' : '（包含正文、昵称和作者头像信息）') : label;
  });
  if (hasMediaSelected()) {
    if (mediaPlan?.directoryMode === false) {
      const names = ['JSON', ...formats.filter(format => format !== 'JSON')].join('、');
      downloadOutput.textContent = english()
        ? `Will save one ZIP containing ${names}, selected media and 打开查看.html. Choose where to save the file; extract the ZIP to read it.`
        : (formats.length === 1 && formats[0] === 'JSON' && mediaChecks[0].checked && !mediaChecks[1].checked && !mediaChecks[2].checked
          ? 'ZIP含JSON、头像和查看页。\n解压后打开“打开查看.html”。'
          : '压缩包含所选文件、媒体和查看页。\n解压后打开“打开查看.html”。');
      return;
    }
    labels.push(mediaPlan?.ready
      ? (english() ? `about ${mediaPlan.partCount} media ZIP(s) and a reader${mediaPlan.oversizedCount ? ` + ${mediaPlan.oversizedCount} separate large file(s)` : ''}` : `预计 ${mediaPlan.partCount} 个 ZIP 和查看页${mediaPlan.oversizedCount ? ` + ${mediaPlan.oversizedCount} 个独立大文件` : ''}`)
      : (english() ? 'media package (calculating)' : '媒体包（正在计算）'));
  }
  downloadOutput.textContent = labels.length ? `${english() ? 'Will save: ' : '将保存：'}${labels.join(' + ')}${hasMediaSelected()
    ? (english() ? '. Large exports require an authorized export subfolder. Extract all parts there.' : '。大文件需选择可授权的导出子文件夹；所有分包解压到一起。')
    : (english() ? '. Includes text and names, without media files.' : '。\n包含正文和昵称，不含媒体文件。')}`
    : (english() ? 'Choose at least one item.' : '请至少选择一项。');
}
window.addEventListener('xkeeps:media-plan', event => { mediaPlan = event.detail; renderDownloadOutput(); });
for (const input of [...formatChecks.values(), ...mediaChecks]) input.addEventListener('change', renderDownloadOutput);
window.addEventListener('xkeeps:language-changed', renderDownloadOutput);
renderDownloadOutput();
fileCard.append(downloadOutput);
const downloadButton = node('button', 'xk-download-submit', '开始下载'); downloadButton.type = 'button';
const downloadStatus = node('p', 'help xk-download-status'); downloadStatus.setAttribute('role', 'status');
fileCard.append(downloadButton, downloadStatus);
function renderDownloadChoice() {
  const likes = $('content-source').value === 'likes';
  bookmarkScope.hidden = bookmarkFile.hidden = likes;
  likesScope.hidden = likesFile.hidden = !likes;
}
original.media.hidden = true;
downloadGroup.append(downloadLead, scopeCard, fileCard, original.media);
pages.home.append(downloadGroup);
let downloadBusy = false;
downloadButton.addEventListener('click', async () => {
  if (downloadBusy) return;
  const source = $('content-source').value;
  const formats = [...formatChecks].filter(([, check]) => check.checked).map(([format]) => format);
  if (!formats.length && !hasMediaSelected()) {
    downloadStatus.textContent = english() ? 'Choose at least one item to download.' : '请至少选择一项。'; return;
  }
  if (formats.length && $(source === 'likes' ? 'likes-export' : 'btn-export').disabled) {
    downloadStatus.textContent = english() ? 'This selection is not ready to download yet.' : '暂无内容，请导入存档或更新内容。'; return;
  }
  if (hasMediaSelected() && $('media-download').disabled) {
    downloadStatus.textContent = english() ? 'Media preparation is not ready for this selection.' : '媒体内容尚未准备好，请检查所选范围或稍后重试。'; return;
  }
  const captured = {}; window.dispatchEvent(new CustomEvent('xkeeps:export-document', { detail: captured }));
  if (!captured.document) { downloadStatus.textContent = english() ? 'The selection is still loading. Try again.' : '所选内容仍在读取，请稍后重试。'; return; }
  const id = operationId();
  const batch = new ExportBatch({ operationId: id, entry: 'home', itemCount: captured.document.likes?.length ?? captured.document.bookmarks?.length ?? 0 });
  const selectedMedia = hasMediaSelected();
  const locked = [...document.querySelectorAll('#content-source, #export-range, #likes-range, .xk-time-control button, .xk-time-control input'), ...formatChecks.values(), ...mediaChecks].map(control => [control, control.disabled]);
  for (const [control] of locked) control.disabled = true;
  // Legacy export handlers refresh their controls after each file. Keep the
  // whole selection locked until every format in this batch has settled.
  const selectionLock = new MutationObserver(records => {
    for (const { target } of records) if (!target.disabled) target.disabled = true;
  });
  for (const [control] of locked) selectionLock.observe(control, { attributes: true, attributeFilter: ['disabled'] });
  downloadBusy = true; downloadButton.disabled = true;
  downloadStatus.textContent = english() ? 'Preparing your selection…' : '正在准备所选内容…';
  try {
    if (selectedMedia) {
      const outcome = await new Promise(resolve => window.dispatchEvent(new CustomEvent('xkeeps:download-media-request', { detail: { resolve, operationId: id, document: captured.document, formats } })));
      batch.include('media', outcome);
      if (outcome?.result !== 'complete') { downloadStatus.textContent = $('media-progress').textContent || (english() ? 'Media download did not finish.' : '媒体下载尚未完成。'); return; }
    }
    for (const format of selectedMedia ? [] : formats) {
      if (source !== $('content-source').value) throw new Error('内容来源已改变，请重新选择。');
      downloadStatus.textContent = english() ? `Downloading ${format.toUpperCase()}…` : `正在下载 ${format.toUpperCase()}…`;
      const outcome = await new Promise(resolve => window.dispatchEvent(new CustomEvent('xkeeps:download-format', { detail: { source, format, resolve, operationId: id, document: captured.document } })));
      batch.include(format, outcome);
      if (outcome?.result !== 'complete') { downloadStatus.textContent = $(source === 'likes' ? 'likes-export-status' : 'export-status').textContent; return; }
    }
    const outcome = batch.finish();
    downloadStatus.textContent = outcome.result === 'complete' ? (english() ? 'Selected downloads finished. Check the saved files.' : '下载完成，请查看保存的文件。') : (english() ? 'Downloads could not be confirmed complete.' : '尚无法确认所选内容全部保存完成。');
    await offerSupport(outcome, downloadStatus);
  } catch (error) { downloadStatus.textContent = english() ? `Download stopped: ${error.message}` : `下载中止：${error.message}`; }
  finally { selectionLock.disconnect(); for (const [control, previous] of locked) control.disabled = previous; downloadBusy = false; downloadButton.disabled = false; }
});
window.addEventListener('xkeeps:export-preview', event => {
  const { source, range, count, error, snapshotAt, coverage } = event.detail;
  const selectedSource = $('content-source').value;
  const selectedRange = $(selectedSource === 'likes' ? 'likes-range' : 'export-range').value;
  if (source !== selectedSource || range !== selectedRange) return;
  const rangeSelect = $(source === 'likes' ? 'likes-range' : 'export-range');
  const snapshotOption = rangeSelect.querySelector('[value="snapshot"]');
  snapshotOption.title = english() ? 'Includes every item read in the latest update. Available after an update.' : '包含最近一次读取的全部内容。\n完成一次更新后可选。';
  snapshotOption.setAttribute('data-i18n-original-title', snapshotOption.title);
  snapshotOption.textContent = snapshotAt
    ? `${english() ? 'Latest collection' : '最近获取'} · ${formatUpdateTime(snapshotAt, english())}`
    : (english() ? 'Latest collection' : '最近获取');
  snapshotHelp.hidden = range !== 'snapshot' || error;
  snapshotHelp.textContent = snapshotAt
    ? `${english() ? 'Collected' : '获取时间'}：${formatUpdateTime(snapshotAt, english())}${coverage?.oldest ? ` · ${english() ? 'Posts published' : '发布时间'}：${formatUpdateTime(coverage.oldest, english())} — ${formatUpdateTime(coverage.newest, english())}` : ''}`
    : '';
  const scope = $(selectedSource === 'likes' ? 'likes-range' : 'export-range').selectedOptions[0]?.textContent || '';
  const time = $(selectedSource === 'likes' ? 'likes-export-time' : 'export-time');
  let hasRedundantPeriod = false;
  // Collection time does not bound publication time. Disable only redundant
  // snapshot periods that cover every saved post, not periods based on its age.
  for (const button of time.querySelectorAll('[data-period]')) {
    const redundant = !error && range === 'snapshot' && coverage?.total > 0
      && coverage.counts[button.dataset.period] === coverage.total;
    button.disabled = !!redundant;
    hasRedundantPeriod ||= redundant;
    button.title = redundant ? (english() ? 'Same contents as All. Choose All or a custom date range.' : '内容与全部时间相同，请自选日期。') : '';
    button.setAttribute('data-i18n-original-title', button.title);
    if (redundant && button.classList.contains('selected')) {
      time.querySelector('[data-period="all"]').click(); return;
    }
  }
  if (hasRedundantPeriod) snapshotHelp.textContent += english() ? ' · Dimmed date ranges contain the same posts as All.' : '\n灰色时间项与全部时间内容相同。';
  const selectedPeriod = time.querySelector('.selected')?.textContent || '';
  const dates = [...time.querySelectorAll('input[type="date"]')].map(input => input.value).filter(Boolean);
  const period = dates.length ? `${selectedPeriod} ${dates.join(' — ')}` : selectedPeriod;
  exportPreview.textContent = error
    ? (english() ? 'No downloadable archive for this selection. Import a JSON file or complete a scan.' : '暂无内容，请导入存档或更新内容。')
    : (english() ? `Content: ${scope} · Date range: ${period} · ${count.toLocaleString()} items`
      : `内容范围：${scope} · 时间范围：${period} · 共 ${count.toLocaleString()} 条内容`);
  if (!error && /暂无内容|暂无可下载|not ready to download|no downloadable archive/i.test(downloadStatus.textContent)) downloadStatus.textContent = '';
});
for (const id of ['export-range', 'likes-range']) $(id).addEventListener('change', () => {
  exportPreview.textContent = english() ? 'Calculating the selected items…' : '正在统计内容…';
});
window.addEventListener('xkeeps:time-change', event => {
  if (event.target.id === 'export-time' || event.target.id === 'likes-export-time')
    exportPreview.textContent = english() ? 'Calculating the selected items…' : '正在统计内容…';
});

const browseLead = node('div', 'xk-page-lead');
browseLead.append(node('h1', '', '浏览存档'), node('p', 'help', '搜索、筛选已保存的内容。'));
pages.browse.append(browseLead, original.search);
const browseSource = node('div', 'xk-browse-source');
for (const [value, text] of [['bookmarks', '收藏'], ['likes', '点赞']]) {
  const button = node('button', 'secondary xk-small', text);
  button.type = 'button'; button.dataset.source = value;
  button.addEventListener('click', () => { $('content-source').value = value; $('content-source').dispatchEvent(new Event('change', { bubbles: true })); updateSource(); });
  browseSource.append(button);
}
original.search.querySelector('.search-controls')?.before(browseSource);
const browseTime = makeTimeControl('browse-time', false);
original.search.querySelector('.search-controls')?.after(browseTime.wrapper);

const accountLead = node('div', 'xk-page-lead');
accountLead.append(node('h1', '', '账号连接'), node('p', 'help', '登录对应账号后可更新内容。'));
const accountList = node('section', 'xk-account-list');
accountList.append(node('h2', '', '账号存档'), node('p', 'help', '正在读取…'));
pages.accounts.append(accountLead, original.connection, accountList);

const settingsLead = node('div', 'xk-page-lead');
settingsLead.append(node('h1', '', '设置'), node('p', 'help', '设置更新计划、文件位置和语言。'));
pages.settings.append(settingsLead, original.schedule);
const directories = node('section', 'card xk-directory-section');
directories.append(node('h2', '', '查找存档'), node('p', 'help', '选择文件夹，查找已有存档。'));
const dirRows = node('div', 'xk-directory-rows');
directories.append(dirRows);
pages.settings.append(directories);
const directoryStatus = node('p','help'); directories.append(directoryStatus);
const jsonViewerButton = node('button', 'secondary xk-small', '打开存档');
jsonViewerButton.type = 'button';
jsonViewerButton.addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') }));
directories.append(jsonViewerButton);
const STORAGE_NAME = 'xkeeps-directory-permissions';
async function directoryDb() {
  return new Promise((resolve,reject)=>{const req=indexedDB.open(STORAGE_NAME,1);
    req.onupgradeneeded=()=>req.result.createObjectStore('handles');
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
}
async function directoryHandle(key, replacement) {
  const db=await directoryDb();
  try { return await new Promise((resolve,reject)=>{const tx=db.transaction('handles',replacement?'readwrite':'readonly');
    let value=null;tx.oncomplete=()=>resolve(value);tx.onerror=tx.onabort=()=>reject(tx.error);
    if (replacement) {tx.objectStore('handles').put(replacement,key);value=replacement;}
    else tx.objectStore('handles').get(key).onsuccess=e=>{value=e.target.result||null;};
  }); } finally {db.close();}
}
async function scanDirectory(key) {
  const handle=await directoryHandle(key);
  if (!handle) throw new Error('请先授权目录。');
  const permission=await handle.queryPermission({mode:'read'});
  if (permission!=='granted') throw new Error('读取许可已失效，请重新选择位置。');
  const files=[];
  for await (const entry of handle.values()) {
    if (entry.kind==='file' && /\.(json|csv|md)$/i.test(entry.name)) files.push(entry);
    if (files.length>=200) break;
  }
  directoryStatus.replaceChildren(node('span','',`文件夹：${handle.name}\n找到 ${files.length} 个文件。\n只查当前文件夹，不查子文件夹。`));
  for (const entry of files.slice(0,20)) {
    const btn=node('button','secondary xk-small',entry.name);btn.type='button';
    btn.addEventListener('click',async()=>receiveFile(await entry.getFile()));directoryStatus.append(btn);
  }
}
for (const [key,title,startIn] of [['downloads','下载位置','downloads'],['documents','文档位置','documents'],['last','上次位置','downloads']]) {
  const row=node('div','xk-directory-row'); const label=node('strong','',title);
  const pick=node('button','secondary xk-small','选择位置'); pick.type='button';
  const scan=node('button','secondary xk-small','查找文件');scan.type='button';
  const state=node('span','help','尚未允许');
  pick.addEventListener('click',async()=>{
    try {if(!window.showDirectoryPicker)throw new Error('当前 Chrome 不支持目录授权，请使用首页“手动导入”。');
      const handle=await showDirectoryPicker({id:`xkeeps-${key}`,startIn,mode:'read'});
      await directoryHandle(key,handle);state.textContent=`已授权：${handle.name}`;await scanDirectory(key);
    } catch(error) {if(error.name!=='AbortError') directoryStatus.textContent=error.message;}
  });
  scan.addEventListener('click',()=>scanDirectory(key).catch(error=>{directoryStatus.textContent=error.message;}));
  row.append(label,pick,scan,state);dirRows.append(row);
  directoryHandle(key).then(handle=>{if(handle)state.textContent=`所选位置：${handle.name}`;}).catch(()=>{});
}
const language = original.header.querySelector('.language-choice');
if (language) { const section = node('section', 'card xk-settings-language'); section.append(node('h2', '', '显示语言'), language); pages.settings.append(section); }
const about = node('section', 'card xk-about');
about.append(node('h2', '', '关于产品'), node('p', 'help', '将你的收藏和点赞保存在本地。'));
about.append(original.footer);
mountSupportSettings(about, { sections: 'support' });
pages.settings.append(about);
const footerMenus = {};
for (const id of footerPages) {
  const button = footerNav.querySelector(`[data-page="${id}"]`);
  const panel = node('aside', 'xk-feedback-panel');
  panel.id = `${id}-panel`;
  panel.setAttribute('popover', 'auto');
  panel.setAttribute('aria-label', titles[id][0]);
  button.setAttribute('popovertarget', panel.id);
  button.setAttribute('aria-controls', panel.id);
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', titles[id][0]);
  mountSupportSettings(panel, { sections: id, placement: 'sidebar', presentation: 'menu' });
  document.body.append(panel);
  function position() {
    const rect = button.getBoundingClientRect();
    const width = Math.min(320, innerWidth - 24);
    panel.style.width = `${width}px`;
    const narrow = innerWidth <= 720;
    const left = narrow ? 12 : Math.min(rect.right + 12, innerWidth - width - 12);
    const height = panel.offsetHeight;
    const top = narrow ? (rect.bottom + 8 + height <= innerHeight - 12 ? rect.bottom + 8 : rect.top - height - 8) : rect.bottom - height;
    panel.style.left = `${Math.max(12, left)}px`;
    panel.style.top = `${Math.max(12, Math.min(top, innerHeight - height - 12))}px`;
  }
  panel.addEventListener('toggle', event => {
    const open = event.newState === 'open';
    button.setAttribute('aria-expanded', String(open));
    if (open) { position(); recordEvent('page_viewed', { page: id }); }
  });
  new ResizeObserver(() => { if (panel.matches(':popover-open')) position(); }).observe(panel);
  window.addEventListener('resize', () => { if (panel.matches(':popover-open')) position(); });
  window.addEventListener('scroll', () => { if (panel.matches(':popover-open')) position(); }, { passive: true });
  footerMenus[id] = { button, panel, position };
}

const analyticsPanel = node('section', 'card xk-analytics');
const analyticsCount = node('p', 'help', '正在读取使用记录…');
const analyticsExport = node('button', 'secondary xk-small', '下载记录'); analyticsExport.type = 'button';
const analyticsClear = node('button', 'secondary xk-small xk-danger', '清空记录'); analyticsClear.type = 'button';
const analyticsStatus = node('p', 'help');
analyticsPanel.append(node('h2', '', '使用记录'), node('p', 'help', '仅记录操作，不含账号和正文。\n此浏览器保留90天，最多5000条。'),
  analyticsCount, analyticsExport, analyticsClear, analyticsStatus);
pages.settings.insertBefore(analyticsPanel, about);
async function refreshAnalytics() {
  const summary = summarizeEvents(await listEvents());
  analyticsCount.textContent = english()
    ? `Events: ${summary.total} · Active days: ${summary.active_days}\nDownloads: ${summary.successful_exports} · Updates: ${summary.successful_updates}\nImports: ${summary.successful_imports} · Media downloads: ${summary.successful_media_backups}`
    : `使用记录：${summary.total}条 · 使用天数：${summary.active_days}天\n下载：${summary.successful_exports}次 · 更新：${summary.successful_updates}次\n导入：${summary.successful_imports}次 · 媒体下载：${summary.successful_media_backups}次`;
}
analyticsExport.addEventListener('click', async () => {
  try {
    const events = await listEvents();
    const result = await downloadBlob(new Blob([JSON.stringify({ schema_version: 1, events }, null, 2)], { type: 'application/json' }), 'Xkeeps_local_usage_events.json');
    analyticsStatus.textContent = result.state === 'complete' ? (english() ? `Exported ${events.length} local events.` : `已导出 ${events.length} 条本机记录。`)
      : (english() ? 'Download requested; check your browser downloads.' : '已请求浏览器下载；请检查下载列表。');
  } catch { analyticsStatus.textContent = english() ? 'Could not export usage records. Try again.' : '导出使用记录失败；请重试。'; }
});
analyticsClear.addEventListener('click', async () => {
  if (!confirm(english() ? 'Clear usage records\nClear usage records in this browser.\nArchives stay intact.\nThis cannot be undone.' : '清空记录\n清空此浏览器的使用记录。\n存档内容不受影响。\n此操作无法撤销。')) return;
  try { await clearEvents(); await refreshAnalytics(); analyticsStatus.textContent = english() ? 'Usage records cleared.' : '使用记录已清空。'; }
  catch { analyticsStatus.textContent = english() ? 'Could not clear usage records. Try again.' : '清空失败；请重试。'; }
});

function makeTimeControl(id, custom) {
  const wrapper = node('div', 'xk-time-control'); wrapper.id = id;
  const label = node('span', 'help', '时间范围');
  const buttons = node('div', 'xk-time-buttons');
  const options = [['all','全部时间'],['year','近一年'],['half','近半年'],['month','近一个月'],['week','近一周']];
  if (custom) options.push(['custom','自选日期']);
  for (const [value, title] of options) {
    const button = node('button', `secondary xk-chip ${value === 'all' ? 'selected' : ''}`, title);
    button.type = 'button'; button.dataset.period = value;
    button.addEventListener('click', () => {
      buttons.querySelector('.selected')?.classList.remove('selected'); button.classList.add('selected');
      dates.hidden = value !== 'custom';
      wrapper.dispatchEvent(new CustomEvent('xkeeps:time-change', { detail: { period: value }, bubbles: true }));
    });
    buttons.append(button);
  }
  const dates = node('div','xk-custom-dates'); dates.hidden = true;
  if (custom) for (const [edge,title] of [['from','开始日期'],['to','结束日期']]) {
    const field = node('label','',title); const input = node('input'); input.type = 'date'; input.dataset.edge = edge;
    input.addEventListener('change',()=>wrapper.dispatchEvent(new CustomEvent('xkeeps:time-change',{bubbles:true})));
    field.append(input); dates.append(field);
  }
  wrapper.append(label, buttons, dates);
  return { wrapper, buttons };
}

function updateSource() {
  const source = $('content-source').value;
  recordEvent('source_selected', { source });
  renderStageCopy();
  for (const button of browseSource.querySelectorAll('button')) button.classList.toggle('selected', button.dataset.source === source);
  renderDownloadChoice();
  downloadStatus.textContent = '';
  exportPreview.textContent = english() ? 'Calculating the selected items…' : '正在统计内容…';
  refreshBanner().catch(() => {});
  refreshAccounts().catch(() => {});
}

function renderStageCopy() {
  const likes = $('content-source').value === 'likes';
  updateTitle.textContent = likes ? '更新点赞' : '更新收藏';
  updateDescription.textContent = likes
    ? '从 X 获取内容，保留已有记录。'
    : '从 X 获取内容，保留已有记录。';
  downloadTitle.textContent = likes ? '下载点赞' : '下载收藏';
  downloadDescription.textContent = likes
    ? '下载已保存的内容，无需重新更新。'
    : '下载已保存的内容，无需重新更新。';
}

async function currentId() {
  const cookie = await chrome.cookies.get({ url: 'https://x.com', name: 'twid' });
  const id = decodeURIComponent(cookie?.value || '').replaceAll('"', '').replace(/^u=/, '');
  return /^\d+$/.test(id) ? id : null;
}
async function refreshBanner() {
  const userId = await currentId();
  const title = bannerText.querySelector('strong');
  const detail = bannerText.querySelector('p');
  if (!userId) { clearButton.disabled = true; title.textContent = english() ? 'No X account connected' : '尚未连接 X 账号';
    detail.textContent = english() ? 'Browse imported local archives. Sign in to X to collect new content.' : '请登录X账号后更新内容。'; return; }
  const source = $('content-source').value;
  const record = source === 'likes' ? await new LikesStore().get(userId) : await new XArchive.ArchiveStore().get(`user:${userId}`);
  const doc = source === 'likes' ? record?.current : record?.data;
  const count = source === 'likes' ? doc?.likes?.length : doc?.bookmarks?.length;
  if (userId !== await currentId() || source !== $('content-source').value) return;
  clearButton.disabled = count == null;
  const kind = source === 'likes' ? (english() ? 'likes' : '点赞') : (english() ? 'bookmarks' : '收藏');
  const profileKey = `xarchive_profile_${userId}`;
  const profile = (await chrome.storage.local.get(profileKey))[profileKey];
  const archivedName = source === 'likes' ? doc?.account?.screen_name : doc?.export_metadata?.screen_name;
  const screenName = [profile, archivedName].find(name => typeof name === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(name));
  const accountLabel = screenName ? `@${screenName}` : (english() ? 'Name not available yet' : '昵称未知');
  if (count == null) title.textContent = english() ? `No saved ${kind}` : `暂无${kind}`;
  else title.replaceChildren(
    document.createTextNode(english() ? `Saved ${kind}: ` : `已存${kind} `),
    node('span', 'xk-archive-count', count.toLocaleString()),
    document.createTextNode(english() ? ' items' : ' 条'),
  );
  let savedPath = null;
  try { const saved = (await chrome.storage.local.get('xkeeps_last_download')).xkeeps_last_download;
    if (saved?.userId === userId && saved?.source === source) savedPath = saved.path; } catch {}
  detail.replaceChildren(
    document.createTextNode(english() ? 'Current account ' : '当前账号 '),
    node('span', 'xk-account-name', accountLabel),
    document.createTextNode(savedPath
      ? (english() ? `\nSaved in this browser\nLast download: ${savedPath}` : `\n保存位置：此浏览器内。\n最近下载：${savedPath}`)
      : (english() ? '\nSaved in this browser\nNo external file linked' : '\n保存位置：此浏览器内。\n尚未关联电脑中的存档文件。')),
  );
}

clearButton.addEventListener('click', async () => {
  const source = $('content-source').value;
  const userId = await currentId();
  if (!userId || clearButton.disabled) return;
  const kind = source === 'likes' ? '点赞' : '收藏';
  if (!confirm(english() ? `Clear saved ${source === 'likes' ? 'likes' : 'bookmarks'}\nClear this account’s records for the selected source.\nThis cannot be undone.\nX posts and downloaded files stay intact.` : `清空记录\n清空此账号已保存的${kind}记录。\n此操作无法撤销。\nX内容和已下载文件不受影响。`)) return;
  clearButton.disabled = true;
  try {
    await navigator.locks.request('xarchive-export', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('正在采集或更新，请等本次操作结束后再清空。');
      if (userId !== await currentId() || source !== $('content-source').value) throw new Error('账号或内容来源已改变，请重新确认。');
      if (source === 'likes') await new LikesStore().remove(userId);
      else {
        const run = await getExportState('run_info');
        if (run?.user_id === userId) await clearAllData();
        await new XArchive.ArchiveStore().remove(`user:${userId}`);
      }
      const saved = (await chrome.storage.local.get('xkeeps_last_download')).xkeeps_last_download;
      if (saved?.userId === userId && saved?.source === source) await chrome.storage.local.set({ xkeeps_last_download: null });
      recordEvent('account_archive_deleted', { had_bookmarks: source === 'bookmarks', had_likes: source === 'likes' });
      window.dispatchEvent(new CustomEvent('xkeeps:local-archive-cleared', { detail: { source, userId } }));
      window.dispatchEvent(new Event('xkeeps:archive-changed'));
    });
  } catch (error) { bannerText.querySelector('p').textContent = english() ? `Could not clear saved records: ${error.message}` : `清空失败：${error.message}`; }
  finally { refreshBanner().catch(() => {}); }
});

async function refreshAccounts() {
  const current = await currentId();
  const bookmarks = await new XArchive.ArchiveStore().list();
  const likes = await new LikesStore().list();
  const joined = new Map();
  for (const row of bookmarks) {
    if (!row.userId) continue;
    joined.set(row.userId, { id: row.userId, name: row.screenName || row.userId, bookmarks: row.count, likes: 0 });
  }
  for (const row of likes) {
    const old = joined.get(row.userId) || { id: row.userId, name: row.screenName || row.userId, bookmarks: 0, likes: 0 };
    old.likes = row.count; old.name ||= row.screenName || row.userId; joined.set(row.userId, old);
  }
  accountList.replaceChildren(node('h2', '', english() ? 'Archives on this browser' : '账号存档'));
  if (!joined.size) { accountList.append(node('p', 'help', english() ? 'No local archives yet. Import JSON on Home or scan the current account.' : '暂无内容，请导入存档或更新内容。')); return; }
  for (const row of joined.values()) {
    const item = node('div', 'xk-account-row');
    const description = english() ? `Bookmarks ${row.bookmarks} · Likes ${row.likes}${row.id === current ? ' · Current X account' : ''}`
      : `收藏 ${row.bookmarks} 条 · 点赞 ${row.likes} 条${row.id === current ? ' · 当前 X 账号' : ''}`;
    const text = node('div'); text.append(node('strong', '', `@${row.name}`), node('p', 'help', description));
    const view = node('button', 'secondary xk-small', '查看存档'); view.type = 'button';
    view.addEventListener('click', () => { sessionStorage.setItem('xkeeps:view-account', row.id); navigate('browse'); window.dispatchEvent(new Event('xkeeps:view-account-changed')); });
    const remove = node('button', 'secondary xk-small xk-danger', '删除存档'); remove.type = 'button';
    remove.addEventListener('click', async () => {
      if (!confirm(english() ? `Delete archive\nDelete @${row.name}’s bookmarks and likes saved in this browser.\nX posts and downloaded files stay intact.\nThis cannot be undone.` : `删除存档\n账号：@${row.name}\n删除此账号在本浏览器的存档。\n此操作无法撤销。\nX内容和已下载文件不受影响。`)) return;
      await new XArchive.ArchiveStore().remove(`user:${row.id}`);
      await new LikesStore().remove(row.id);
      recordEvent('account_archive_deleted', { had_bookmarks: row.bookmarks > 0, had_likes: row.likes > 0 });
      if (sessionStorage.getItem('xkeeps:view-account') === row.id) sessionStorage.removeItem('xkeeps:view-account');
      window.dispatchEvent(new Event('xkeeps:archive-changed'));
      await refreshAccounts();
    });
    item.append(text, view, remove); accountList.append(item);
  }
}

function navigate(id) {
  if (footerMenus[id]) { navigate(navigate.last || 'home'); footerMenus[id].panel.showPopover(); footerMenus[id].position(); return; }
  for (const { panel } of Object.values(footerMenus)) if (panel.matches(':popover-open')) panel.hidePopover();
  const selected = pages[id] ? id : 'home';
  if (navigate.last !== selected) recordEvent('page_viewed', { page: selected });
  navigate.last = selected;
  for (const [key, page] of Object.entries(pages)) page.hidden = key !== selected;
  for (const button of sidebar.querySelectorAll('.xk-nav-item')) {
    const active = button.dataset.page === selected;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  history.replaceState(null, '', `${location.pathname}${location.search}#${selected}`);
  if (selected === 'accounts') refreshAccounts().catch(error => accountList.append(node('p', 'help', error.message)));
  if (selected === 'settings') refreshAnalytics().catch(() => { analyticsCount.textContent = '使用记录暂时无法读取。'; });
  window.dispatchEvent(new CustomEvent('xkeeps:page-changed', { detail: { page: selected } }));
}

for (const button of nav.querySelectorAll('.xk-nav-item')) button.addEventListener('click', () => navigate(button.dataset.page));
window.addEventListener('xkeeps:navigate', event => {
  if (!pages[event.detail?.page] && !footerPages.has(event.detail?.page)) return;
  navigate(event.detail.page);
  window.scrollTo(0, 0);
  const heading = pages[event.detail.page]?.querySelector('h1');
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
});
window.addEventListener('xkeeps:open-browse', async event => {
  const source = event.detail?.source;
  if (!['bookmarks', 'likes'].includes(source)) return;
  $('content-source').value = source;
  $('content-source').dispatchEvent(new Event('change', { bubbles: true }));
  const userId = await currentId();
  if (userId) sessionStorage.setItem('xkeeps:view-account', userId);
  navigate('browse');
  window.dispatchEvent(new Event('xkeeps:view-account-changed'));
  window.scrollTo(0, 0);
});
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
$('content-source').addEventListener('change', updateSource);
window.addEventListener('xkeeps:archive-changed', () => { refreshBanner().catch(() => {}); refreshAccounts().catch(() => {}); });
window.addEventListener('focus', () => refreshBanner().catch(() => {}));
window.addEventListener('xkeeps:language-changed', () => {
  const en = english();
  for (const button of sidebar.querySelectorAll('.xk-nav-item')) button.querySelector('span').textContent = titles[button.dataset.page][en ? 1 : 0];
  footerNav.setAttribute('aria-label', en ? 'Feedback & author' : '反馈与作者');
  for (const [id, { button, panel, position }] of Object.entries(footerMenus)) {
    button.setAttribute('aria-label', titles[id][en ? 1 : 0]);
    panel.setAttribute('aria-label', titles[id][en ? 1 : 0]);
    if (panel.matches(':popover-open')) requestAnimationFrame(position);
  }
  renderStageCopy();
  refreshBanner().catch(() => {});
  refreshAccounts().catch(() => {});
  refreshAnalytics().catch(() => {});
  renderDownloadChoice();
  exportPreview.textContent = english() ? 'Calculating the selected items…' : '正在统计内容…';
  window.dispatchEvent(new Event('xkeeps:archive-changed'));
});
updateSource();
window.dispatchEvent(new Event('xkeeps:archive-changed'));
recordEvent('app_opened', { page: pages[location.hash.slice(1)] ? location.hash.slice(1) : 'home' });
navigate(location.hash.slice(1));
