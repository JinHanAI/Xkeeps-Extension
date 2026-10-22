import { ExportBatch } from './lib/export-outcome.js';
import { offerSupport } from './lib/support-ui.js';
import { getCredentials, getFreshCt0 } from './lib/api.js';
import { getStoredQueryIds, scrapeQueryIdsFromBundles, captureLikesQueryIdViaTab, storeQueryIds } from './lib/query-ids.js';
import { fetchLikes } from './lib/likes-fetcher.js';
import { LikesStore, validateLikes, mergeLikes } from './lib/likes-archive.js';
import { buildLikesCsv, buildLikesMarkdown, likesFilename } from './lib/export-formats.js';
import { downloadBlob } from './lib/downloads.js';
import { recordEvent, operationId, errorClass } from './lib/analytics.js';
import { filterPosts, selectedTimeOptions } from './lib/time-range.js';
import { recommendUpdate, updateRecommendationText, formatUpdateTime } from './lib/update-status.js';

const $ = id => document.getElementById(id);
const store = new LikesStore();
let userId = null, screenName = null, record = null, busy = false, stopped = false;
let pauseGate = null, pendingImport = null;
const bookmarkSections = ['library-section', 'controls-section', 'progress-section', 'log-section', 'result-section'];

let scanProgress = null, progressTimer = null;
const en = () => globalThis.XKeepsI18n?.language === 'en';
const localized = (zh, english) => en() ? english : zh;
function progressLog(message, level = '') {
  const row = document.createElement('div'); row.className = `log-entry ${level}`;
  row.textContent = `[${new Date().toLocaleTimeString(en() ? 'en-GB' : 'zh-CN', { hour12:false })}] ${message}`;
  const log = $('likes-log'); log.append(row);
  if (log.childElementCount > 500) log.firstElementChild.remove();
  log.scrollTop = log.scrollHeight;
}
function renderProgress() {
  if (!scanProgress) return;
  const seconds = Math.max(0, Math.floor((Date.now() - scanProgress.startedAt) / 1000));
  const messages = {
    preparing: ['正在准备点赞更新…', 'Preparing liked-post update…'],
    discovering: ['正在准备读取点赞…', 'Finding the liked-post interface…'],
    scanning: scanProgress.mode === 'quick' ? ['正在检查近期点赞', 'Checking recent liked posts'] : ['正在检查全部点赞', 'Checking all liked posts'],
    paused: ['已暂停，可继续更新。', 'Paused. Resume to continue collecting'],
    stopping: ['正在停止，已获取内容会保留。', 'Stopping. Collected items will be preserved'],
    saving: ['正在保存更新…', 'Merging this update…'],
  };
  $('likes-progress').textContent = (messages[scanProgress.phase] || messages.scanning)[en() ? 1 : 0];
  $('likes-progress-bar').classList.toggle('is-paused', ['paused','stopping'].includes(scanProgress.phase));
  $('likes-progress-title').textContent = localized('更新进度', 'Collection progress');
  for (const [key,zh,english] of [['count','已读条数','Collected likes'],['pages','已查页数','Pages'],['rate','更新速度','Speed'],['time','更新用时','Elapsed']]) $('likes-'+key+'-label').textContent = localized(zh,english);
  $('likes-stat-count').textContent = scanProgress.count.toLocaleString();
  $('likes-stat-pages').textContent = scanProgress.pages.toLocaleString();
  $('likes-stat-rate').textContent = seconds && scanProgress.count ? `${Math.round(scanProgress.count * 60 / seconds).toLocaleString()} ${localized('条/分钟','items/min')}` : '--';
  $('likes-stat-time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,'0')}`;
  $('likes-progress-section').setAttribute('aria-label', localized('点赞更新进度','Liked-post collection progress'));
  $('likes-progress-section').querySelector('[role="progressbar"]').setAttribute('aria-label', localized('正在采集点赞，总页数未知','Collecting liked posts; total pages unknown'));
  $('likes-log-title').textContent = localized('更新过程','Run log');
}
function progressPhase(phase) { if (scanProgress) { scanProgress.phase = phase; renderProgress(); } }
function startProgress(mode) {
  clearInterval(progressTimer);
  scanProgress = { mode, startedAt:Date.now(), phase:'preparing', count:0, pages:0 };
  $('likes-progress-section').hidden = false;
  $('likes-log-section').hidden = false; $('likes-log-section').open = true;
  $('likes-log').replaceChildren();
  progressLog(localized(mode === 'quick' ? '近期更新点赞。' : '开始全量更新点赞。', mode === 'quick' ? 'Incremental liked-post update started.' : 'Full liked-post update started.'));
  renderProgress(); progressTimer = setInterval(renderProgress,1000);
}
function finishProgress(success) {
  clearInterval(progressTimer); progressTimer = null;
  $('likes-progress-section').hidden = true;
  $('likes-log-section').open = !success;
}
function status(message) { $('likes-status').textContent = message; }
function result(message) { $('likes-result').textContent = message; }
function showUpdateResult() {
  const snapshot = record?.snapshot;
  const summary = snapshot?.update_summary;
  if (!summary || !snapshot.merged_at) return;
  const target = $('likes-result'); target.replaceChildren();
  const transition = document.createElement('p'); transition.className = 'xk-count-transition';
  transition.append('内容总数 ');
  for (const [i, count] of [summary.before_count, summary.after_count].entries()) {
    if (i) transition.append(' → ');
    const strong = document.createElement('strong'); strong.textContent = count.toLocaleString(); transition.append(strong);
  }
  transition.append(' 条');
  const detail = document.createElement('p');
  detail.textContent = `新增内容 ${summary.added.toLocaleString()} 条 · 更新已有 ${summary.updated.toLocaleString()} 条`;
  const time = document.createElement('p'); time.className = 'help';
  const seconds = Math.max(0, Math.floor((Date.parse(summary.finished_at) - Date.parse(snapshot.started_at || summary.finished_at)) / 1000));
  time.textContent = `更新时间：${formatUpdateTime(summary.before_at)} → ${formatUpdateTime(summary.finished_at)} · 用时 ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const heading = document.createElement('h3'); heading.className = 'section-label';
  const successful = ['complete','quick_boundary'].includes(snapshot.collection.reason);
  heading.textContent = successful ? localized(snapshot.collection.mode === 'quick' ? '更新完成' : '更新完成', snapshot.collection.mode === 'quick' ? 'Incremental update complete' : 'Full update complete') : localized('更新未完','Update partially completed');
  target.append(heading, transition, detail, time);
  if (!['complete', 'quick_boundary'].includes(snapshot.collection.reason)) {
    const warning = document.createElement('p'); warning.textContent = '部分保存，已有内容会保留。'; target.append(warning);
  }
}
function setBusy(value) {
  busy = value;
  $('likes-start').disabled = value || !userId || (!!record?.snapshot?.likes?.length && !record.snapshot.merged_at);
  $('likes-import').disabled = value || !userId;
  $('likes-undo').disabled = value || !record?.can_undo;
  $('likes-export').disabled = value || !selectedDocument();
  $('likes-mode').disabled = value;
  $('likes-range').querySelector('[value="snapshot"]').disabled = !record?.snapshot || value;
  if (!record?.snapshot && $('likes-range').value === 'snapshot') $('likes-range').value = 'cumulative';
  $('likes-range').disabled = value;
  $('likes-format').disabled = value;
  $('likes-pause').hidden = !value || !!pauseGate;
  $('likes-resume').hidden = !value || !pauseGate;
  $('likes-stop').hidden = !value;
  $('likes-recover').hidden = value || !record?.snapshot?.likes?.length || record.snapshot.merged_at;
}
function selectedDocument() { return $('likes-range').value === 'snapshot' ? record?.snapshot : record?.current; }
async function account() {
  const { userId: id } = await getCredentials();
  const cookie = await chrome.cookies.get({ url: 'https://x.com', name: 'twid' });
  const cookieId = decodeURIComponent(cookie?.value || '').replaceAll('"', '').replace(/^u=/, '');
  if (!id || id !== cookieId) throw new Error('当前 X 账号无法确认，请重新登录 X。');
  const profile = await chrome.storage.local.get(`xarchive_profile_${id}`);
  const handle = profile[`xarchive_profile_${id}`] || null;
  return { id, handle };
}
async function verifyAccount(expected) {
  const actual = await account();
  if (actual.id !== expected) throw new Error('X 账号已切换，本页点赞没有写入存档。');
}
async function refresh() {
  if (busy) return;
  try {
    const current = await account();
    const accountChanged = current.id !== userId;
    if (accountChanged) { result(''); $('likes-progress-section').hidden = true; $('likes-log-section').hidden = true; }
    userId = current.id; screenName = current.handle;
    record = await store.get(userId);
    const snapshot = record.snapshot;
    const range = $('likes-range');
    const snapshotKey = `${userId}:${snapshot?.exported_at}`;
    if (snapshot?.merged_at && ['complete','quick_boundary'].includes(snapshot.collection.reason)
        && range.dataset.latestSnapshot !== snapshotKey) {
      range.dataset.latestSnapshot = snapshotKey;
      range.value = 'snapshot';
      range.dispatchEvent(new Event('change'));
    }
    const updateStatus = { count: record.current?.likes.length || 0, lastFullAt: record.current?.last_full_refresh_at, lastUpdatedAt: record.current?.exported_at };
    $('likes-recommendation').textContent = updateRecommendationText(updateStatus, globalThis.XKeepsI18n?.language === 'en');
    if (!$('likes-mode').dataset.userSelected) {
      $('likes-mode').value = recommendUpdate(updateStatus).mode;
      $('likes-mode').dispatchEvent(new Event('change'));
    }
    const count = record.current?.likes.length;
    const ready = !!getStoredQueryIds((await getCredentials()).creds).Likes;
    status(ready ? '' : '首次更新时会查找点赞接口。');
    $('likes-status').hidden = ready;
    if (record.snapshot && !record.snapshot.merged_at && record.snapshot.likes.length) result(`发现未完成快照：${record.snapshot.likes.length} 条，可先导出或合并。`);
    else if (!$('likes-result').textContent) showUpdateResult();
    globalThis.dispatchEvent?.(new Event('xkeeps:archive-changed'));
  } catch (error) { userId = null; record = null; status(error.message); $('likes-status').hidden = false; }
  setBusy(false);
}
window.addEventListener('xkeeps:language-changed', () => {
  renderProgress();
  $('likes-recommendation').textContent = updateRecommendationText({ count: record?.current?.likes.length || 0,
    lastFullAt: record?.current?.last_full_refresh_at, lastUpdatedAt: record?.current?.exported_at }, globalThis.XKeepsI18n?.language === 'en');
});
function switchSource() {
  const likes = $('content-source').value === 'likes';
  if (!likes && busy) { $('content-source').value = 'likes'; return; }
  // An active bookmark collection remains visible until it is stopped.
  if (likes && $('btn-stop').style.display !== 'none') {
    $('content-source').value = 'bookmarks';
    return;
  }
  for (const id of bookmarkSections) {
    const section = $(id);
    if (likes) { section.dataset.previousDisplay = section.style.display; section.hidden = true; }
    else { section.hidden = false; if (section.dataset.previousDisplay != null) section.style.display = section.dataset.previousDisplay; }
  }
  $('likes-panel').hidden = !likes;
  $('queryid-status').hidden = likes;
  if (likes) $('queryid-status').style.setProperty('display', 'none', 'important');
  else $('queryid-status').style.removeProperty('display');
  $('btn-connection').hidden = likes;
  $('bookmark-connection-help').hidden = likes;
  if (likes) refresh();
}
async function discover(mode, initial) {
  let queryId = getStoredQueryIds(initial).Likes;
  if (queryId) return queryId;
  progressPhase('discovering');
  const control = { shouldStop: () => stopped, shouldPause: () => pauseGate?.promise || Promise.resolve() };
  const found = await scrapeQueryIdsFromBundles(null, control, ['Likes']);
  if (found?.Likes) {
    await storeQueryIds(userId, { Likes: found.Likes });
    return found.Likes;
  }
  // Opening a Likes tab makes an additional timeline request. Never do this
  // automatically during a one-request sample test.
  if (mode !== 'sample' && screenName) {
    const live = await captureLikesQueryIdViaTab(userId, screenName, null, control);
    if (live?.Likes) return live.Likes;
  }
  throw new Error(mode === 'sample'
    ? '未取得点赞查询接口。本次没有发送点赞请求；请先打开自己的 X 点赞页一次，然后回来重试。'
    : '未取得点赞查询接口，请打开自己的 X 点赞页并重试。');
}
async function run() {
  if (busy) return;
  result('');
  setBusy(true); stopped = false;
  const mode = $('likes-mode').value;
  startProgress(mode);
  const telemetryId = operationId(); const telemetryStart = Date.now();
  let telemetryResult = 'error', telemetryCount = 0;
  recordEvent('archive_update_started', { source: 'likes', mode }, telemetryId);
  try {
    await navigator.locks.request('xarchive-export', { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('另一个扩展页面正在采集，请等它完成。');
      const owner = await account();
      userId = owner.id; screenName = owner.handle;
      record = await store.get(userId);
      if (mode === 'quick' && !record.current?.likes.length) throw new Error('请先导入存档或进行全量刷新，再做增量更新。');
      const initial = (await getCredentials()).creds;
      if (!await getFreshCt0()) throw new Error('X 登录信息已失效，请重新登录。');
      const queryId = await discover(mode, initial);
      await verifyAccount(userId);
      const creds = (await getCredentials()).creds;
      await store.start(userId, screenName, mode);
      progressPhase('scanning');
      const knownIds = new Set(record.current?.likes.map(tweet => tweet.tweet_id) || []);
      let savedThisRun = 0;
      let outcome;
      try {
        outcome = await fetchLikes({ queryId, creds, userId, mode, knownIds,
          beforeRequest: () => verifyAccount(userId), shouldStop: () => stopped,
          shouldPause: () => pauseGate?.promise || Promise.resolve(),
          onLog: (message, level) => progressLog(message, level),
          onPage: async (tweets, pages) => {
            await verifyAccount(userId);
            await store.append(userId, tweets, new Date().toISOString());
            savedThisRun += tweets.length;
            scanProgress.count = savedThisRun; scanProgress.pages = pages; renderProgress();
            progressLog(localized(`第 ${pages} 页：新增采集 ${tweets.length} 条，累计 ${savedThisRun} 条。`, `Page ${pages}: collected ${tweets.length} items; ${savedThisRun} total.`));
          } });
      } catch (error) {
        outcome = { reason: 'error', complete: false, error };
      }
      // A switched account cannot commit this session's staged snapshot.
      await verifyAccount(userId);
      progressPhase('saving');
      const finished = await store.finish(userId, outcome.reason, outcome.complete);
      record = finished.record;
      const count = record.snapshot?.likes.length || 0;
      telemetryCount = count;
      telemetryResult = outcome.complete ? 'success' : outcome.reason === 'user_stopped' ? 'cancelled' : outcome.error ? 'error' : 'partial';
      result(`点赞采集结束：本次 ${count} 条，累计 ${record.current?.likes.length || 0} 条；${outcome.complete ? '已查全部' : '仅查部分'}（${outcome.reason}）。`);
      showUpdateResult();
      if (outcome.error) {
        const warning = document.createElement('p'); warning.textContent = outcome.error.message; $('likes-result').append(warning);
      }
      const success = outcome.complete || outcome.reason === 'quick_boundary';
      progressLog(localized(success ? '更新完成，结果已保存。' : '更新未完整完成，请查看结果与更新过程。', success ? 'Update complete; results merged into the local archive.' : 'Update incomplete. Check results and the run log.'), success ? 'success' : 'warn');
      finishProgress(success);
    });
  } catch (error) {
    result(`点赞采集未完成：${error.message}。此前累计存档保持不变；已保存的快照可恢复。`);
    progressLog(error.message, 'error'); finishProgress(false);
    await refresh().catch(() => {});
  } finally {
    clearInterval(progressTimer); progressTimer = null;
    recordEvent('archive_update_completed', { source: 'likes', mode, result: telemetryResult,
      item_count: telemetryCount, duration_ms: Date.now() - telemetryStart }, telemetryId);
    if (pauseGate) { pauseGate.resolve(); pauseGate = null; }
    setBusy(false);
    await refresh().catch(() => {});
  }
}
async function exportSelected(request = {}) {
  const original = selectedDocument();
  const time = selectedTimeOptions($('likes-export-time'));
  const doc = request.document ? structuredClone(request.document) : original ? filterPosts(original, time.period, time) : null;
  const batch = new ExportBatch({ operationId: request.operationId || operationId(), entry: 'home', itemCount: doc?.likes.length || 0 });
  if (!doc) return batch.finish('error');
  const format = request.format || $('likes-format').value;
  batch.require(format);
  const telemetryId = batch.outcome.operationId; const telemetryStart = Date.now();
  const telemetry = { source: 'likes', format, scope: $('likes-range').value === 'cumulative' ? 'cumulative' : 'snapshot',
    period: time.period, item_count: doc.likes.length };
  recordEvent('archive_export_started', telemetry, telemetryId);
  setBusy(true);
  $('likes-export-status').textContent = '正在准备文件，请在 Chrome 下载对话框中确认保存位置。';
  try {
    validateLikes(doc);
    const body = format === 'json' ? JSON.stringify(doc, null, 2) + '\n'
      : format === 'csv' ? buildLikesCsv(doc) : buildLikesMarkdown(doc);
    const type = format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/markdown';
    const downloaded = await downloadBlob(new Blob([body], { type: `${type};charset=utf-8` }), likesFilename(doc, format),
      { userId, source: 'likes' });
    batch.saved(format, downloaded);
    $('likes-export-status').textContent = downloaded.state === 'complete' ? `下载完成：${downloaded.filename}；${doc.likes.length} 条点赞，${doc.collection.coverage === 'complete' ? '完整' : '部分'}覆盖。` : '已请求下载；请检查浏览器下载列表。';
    recordEvent('archive_export_completed', { ...telemetry, duration_ms: Date.now() - telemetryStart,
      result: downloaded.state === 'complete' ? 'success' : 'partial' }, telemetryId);
    const outcome = batch.finish();
    if (!request.operationId) await offerSupport(outcome, $('likes-export-status'));
    return outcome;
  } catch (error) { recordEvent('archive_export_completed', { ...telemetry, duration_ms: Date.now() - telemetryStart,
      result: 'error', error_class: errorClass(error) }, telemetryId);
    $('likes-export-status').textContent = `导出失败：${error.message}`; return batch.finish(error.name === 'AbortError' ? 'cancelled' : 'error'); }
  finally { setBusy(false); }
}

$('content-source').addEventListener('change', switchSource);
$('likes-mode').addEventListener('change', () => {
  const mode = $('likes-mode').value;
  if (document.activeElement === $('likes-mode')) $('likes-mode').dataset.userSelected = 'true';
  $('likes-start').textContent = mode === 'sample' ? '开始限量试采' : mode === 'quick' ? '近期更新' : '全部更新';
  $('likes-mode-help').textContent = globalThis.XKeepsI18n?.language === 'en'
    ? (mode === 'quick' ? 'Check recent liked posts until a fully saved page is reached; older changes may be missed.'
      : 'Check all accessible liked posts. X limits or interruptions will be marked as partial coverage.')
    : mode === 'sample' ? '只发一次点赞读取请求，最多 50 条，不重试；结果标记为仅查部分。'
    : mode === 'quick' ? '检查近期点赞，保留已有记录。\n较早内容的变化可能漏查。'
    : '检查全部可访问的点赞内容。\n受限或中断时只保存部分内容。';
});
function updateLikesExportChoice() {
  setBusy(false);
  const range = $('likes-range').value === 'snapshot' ? '最近获取' : '全部内容';
  const format = { json: 'JSON', csv: 'CSV', markdown: 'Markdown' }[$('likes-format').value];
  $('likes-export').textContent = `下载 ${format}`;
  $('likes-export-status').textContent = `将下载${range}的${format}文件。`;
}
$('likes-range').addEventListener('change', updateLikesExportChoice);
$('likes-format').addEventListener('change', updateLikesExportChoice);
$('likes-start').addEventListener('click', run);
$('likes-stop').addEventListener('click', () => { stopped = true; progressPhase('stopping'); if (pauseGate) { pauseGate.resolve(); pauseGate = null; } });
$('likes-pause').addEventListener('click', () => { if (!pauseGate) { let resolve; const promise = new Promise(done => { resolve = done; }); pauseGate = { promise, resolve }; progressPhase('paused'); setBusy(true); } });
$('likes-resume').addEventListener('click', () => { pauseGate?.resolve(); pauseGate = null; progressPhase('scanning'); setBusy(true); });
$('likes-export').addEventListener('click', exportSelected);
$('likes-viewer').addEventListener('click', () => dispatchEvent(new CustomEvent('xkeeps:open-browse', { detail: { source: 'likes' } })));
window.addEventListener('xkeeps:download-format', async event => {
  if (event.detail.source !== 'likes') return;
  $('likes-format').value = event.detail.format;
  event.detail.resolve(await exportSelected(event.detail));
});
window.addEventListener('xkeeps:local-archive-cleared', event => {
  if (event.detail.source !== 'likes' || event.detail.userId !== userId) return;
  record = null; result(''); scanProgress = null; $('likes-progress-section').hidden = true; $('likes-log-section').hidden = true;
  refresh().catch(error => { status(error.message); $('likes-status').hidden = false; });
});
$('likes-import').addEventListener('click', () => { $('likes-file').value = ''; $('likes-file').click(); });
$('likes-file').addEventListener('change', async () => {
  const file = $('likes-file').files[0]; if (!file) return;
  const telemetryId = operationId();
  recordEvent('archive_import_started', { source: 'likes', format: 'json' }, telemetryId);
  try {
    const document = validateLikes(JSON.parse(await file.text()));
    const owner = await account();
    if (document.account.user_id !== owner.id) throw new Error('文件属于其他 X 账号，不能导入当前账号。');
    const preview = mergeLikes(record?.current, document);
    pendingImport = { document, userId: owner.id, revision: record?.revision || 0, telemetryId };
    $('likes-review-summary').textContent = `文件 ${file.name}：${document.likes.length} 条；新增 ${preview.summary.added} 条，更新 ${preview.summary.updated} 条，保留内容 ${preview.summary.retained} 条。账号 ${owner.handle ? '@' + owner.handle : owner.id}。`;
    $('likes-review-error').textContent = '';
    $('likes-review').showModal();
  } catch (error) { recordEvent('archive_import_completed', { source: 'likes', format: 'json', result: 'error', error_class: errorClass(error) }, telemetryId);
    result(`导入预览失败：${error.message}`); }
});
$('likes-cancel').addEventListener('click', () => { if (pendingImport?.telemetryId) recordEvent('archive_import_completed', { source: 'likes', format: 'json', result: 'cancelled' }, pendingImport.telemetryId);
  pendingImport = null; $('likes-review').close(); });
$('likes-review').addEventListener('cancel', () => { if (pendingImport?.telemetryId) recordEvent('archive_import_completed', { source: 'likes', format: 'json', result: 'cancelled' }, pendingImport.telemetryId);
  pendingImport = null; });
$('likes-save').addEventListener('click', async () => {
  if (!pendingImport) return;
  setBusy(true);
  try {
    await verifyAccount(pendingImport.userId);
    const imported = await store.import(pendingImport.userId, pendingImport.document, pendingImport.revision);
    recordEvent('archive_import_completed', { source: 'likes', format: 'json', result: 'success',
      item_count: pendingImport.document.likes.length }, pendingImport.telemetryId);
    pendingImport = null; $('likes-review').close(); result(imported.changed ? '点赞存档已导入，可撤销本次更新。' : '文件内容已存在，存档未改变。');
  } catch (error) { $('likes-review-error').textContent = error.message; }
  finally { setBusy(false); await refresh(); }
});
$('likes-undo').addEventListener('click', async () => {
  try { await verifyAccount(userId); await store.undo(userId, record.revision); result('已撤销上次点赞存档更新。'); await refresh(); }
  catch (error) { result(`撤销失败：${error.message}`); }
});
$('likes-recover').addEventListener('click', async () => {
  try { await verifyAccount(userId); await store.finish(userId, 'tab_interrupted', false); result('未完成快照已合并，标记为仅查部分。'); await refresh(); }
  catch (error) { result(`恢复失败：${error.message}`); }
});
window.addEventListener('focus', () => { if ($('content-source').value === 'likes') refresh(); });
chrome.runtime.onMessage?.addListener(message => {
  if (message?.type === 'xkeeps:archive-updated' && message.source === 'likes' && message.userId === userId) refresh();
});
switchSource();
