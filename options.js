import { ExportBatch } from './lib/export-outcome.js';
import { offerSupport } from './lib/support-ui.js';
/** Collect staged snapshots and merge into a separate account-scoped archive.
 * Pause/Resume works within an open tab. Interrupted snapshots are recoverable. */
import './lib/archive.js';
import { getCredentials, getFreshCt0 } from './lib/api.js';
import { BASE_DELAY_MS, waitForCollection } from './lib/utils.js';
import { getStoredQueryIds, hasRequiredQueryIds, scrapeQueryIdsFromBundles, captureQueryIdsViaTab, captureFolderQueryIdViaTab, storeQueryIds } from './lib/query-ids.js';
import { fetchAllBookmarks } from './lib/fetcher.js';
import { fetchAllFolders, fetchFolderContents } from './lib/folders.js';
import { getBookmarkCount, getAllBookmarks, getAllFolders, getExportState, saveExportState, clearAllData } from './lib/db.js';
import { assembleExport, downloadJSONReceipt } from './lib/exporter.js';
import { buildCsv, buildMarkdown, exportFilename } from './lib/export-formats.js';
import { downloadBlob } from './lib/downloads.js';
import { filterPosts, selectedTimeOptions } from './lib/time-range.js';
import { recommendUpdate, updateRecommendationText, updateSummary, formatUpdateTime } from './lib/update-status.js';
import { VERSION } from './version.js';
import { recordEvent, operationId, errorClass } from './lib/analytics.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * @type {'idle'|'exporting'|'paused'|'stopped'|'complete'}
 *
 * Transitions:
 *   idle      → exporting  (Start clicked)
 *   exporting → paused     (Pause clicked)
 *   exporting → stopped    (Stop clicked, or error with data)
 *   exporting → complete   (all pages fetched)
 *   paused    → exporting  (Resume clicked)
 *   paused    → stopped    (Stop clicked)
 *   stopped   → exporting  (new staged scan; cumulative archive retained)
 *   complete  → exporting  (new staged scan; cumulative archive retained)
 */
let exportState = 'idle';
let stopRequested = false;
/** When non-null the fetcher blocks on `pauseGate.promise`. */
let pauseGate = null; // { promise, resolve }
let startTime = null;
let elapsedInterval = null;
let currentCreds = null;
let currentQueryIds = {};
let currentUserId = null;
let currentScreenName = null;
const archiveStore = new XArchive.ArchiveStore();
let libraryRecord = null;
let libraryBusy = false;
let pendingLibraryImport = null;
let runInfo = null;
let stagedSnapshotAvailable = false;
let hasCredentials = false;
let credentialCheck = null;
/** Active cooldown countdown interval, if any. Cleared on state transitions. */
let cooldownInterval = null;

/**
 * Called by the fetcher before each page request.  If paused, the
 * returned promise won't resolve until the user clicks Resume.
 * @returns {Promise<void>}
 */
function shouldPause() {
  return pauseGate ? pauseGate.promise : Promise.resolve();
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const credDot = $('cred-dot');
const credText = $('cred-text');
const queryidDot = $('queryid-dot');
const queryidText = $('queryid-text');
const userDot = $('user-dot');
const userText = $('user-text');
const hintText = $('hint-text');
const connectionReady = $('connection-ready');
const connectionConfetti = $('connection-confetti');
const celebratedAccounts = new Set();
let connectionRefreshing = false;

function renderConnectionChecklist() {
  const checks = [
    [credDot, $('cred-check')],
    [queryidDot, $('queryid-check')],
    [userDot, $('user-check')],
  ];
  for (const [dot, check] of checks) check.hidden = !dot.classList.contains('ok');
  const ready = !connectionRefreshing && !!currentUserId && checks.every(([dot]) => dot.classList.contains('ok'));
  connectionReady.hidden = !ready;
  if (!ready) { connectionConfetti.replaceChildren(); return; }
  const key = `xkeeps:connection-ready:${currentUserId}`;
  let alreadyCelebrated = celebratedAccounts.has(key);
  try { alreadyCelebrated ||= sessionStorage.getItem(key) === '1'; } catch {}
  if (alreadyCelebrated) return;
  celebratedAccounts.add(key);
  try { sessionStorage.setItem(key, '1'); } catch {}
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const pieces = [[-68,-28],[-51,-45],[-35,-23],[-18,-52],[0,-34],[19,-50],[34,-27],[52,-43],[70,-24],[-43,14],[0,20],[45,16]];
  const colors = ['#1d9bf0','#00ba7c','#f7c948','#f4212e','#b79aff'];
  for (const [index, [x, y]] of pieces.entries()) {
    const piece = document.createElement('span');
    piece.style.setProperty('--confetti-x', `${x}px`);
    piece.style.setProperty('--confetti-y', `${y}px`);
    piece.style.setProperty('--confetti-rotate', `${index % 2 ? -190 : 220}deg`);
    piece.style.setProperty('--confetti-color', colors[index % colors.length]);
    connectionConfetti.append(piece);
  }
  setTimeout(() => connectionConfetti.replaceChildren(), 950);
}

$('connection-go-home').addEventListener('click', () => {
  dispatchEvent(new CustomEvent('xkeeps:navigate', { detail: { page: 'home' } }));
});

const btnStart = $('btn-start');
const btnPause = $('btn-pause');
const btnResume = $('btn-resume');
const btnStop = $('btn-stop');

const progressSection = $('progress-section');
const statPhase = $('stat-phase');
const scanLiveStatus = $('scan-live-status');
const statBookmarks = $('stat-bookmarks');
const statPages = $('stat-pages');
const statFolders = $('stat-folders');
const statSpeed = $('stat-speed');
const statElapsed = $('stat-elapsed');
const progressBar = $('progress-bar');
const rateLimitNotice = $('rate-limit-notice');
const cooldownTimer = $('cooldown-timer');

const resultSection = $('result-section');
const resultHeading = $('result-heading');
const resultTotal = $('result-total');
const resultAvailable = $('result-available');
const resultUnavailable = $('result-unavailable');
const resultUnavailableReasons = $('result-unavailable-reasons');
const resultFolders = $('result-folders');
const resultDuration = $('result-duration');
const btnExport = $('btn-export');

const logContainer = $('log');
const logToggle = $('log-toggle');
const versionInfo = $('version-info');

function runMergedIntoLibrary() {
  if (!runInfo?.user_id || libraryRecord?.key !== `user:${runInfo.user_id}`) return false;
  if (runInfo.archive_merged != null) return runInfo.archive_merged === true;
  // Older scans have no merge flag. Their cumulative archive records the
  // snapshot's exact completion timestamp when the merge succeeded.
  return !!runInfo.finished_at && libraryRecord.data.export_metadata?.exported_at === runInfo.finished_at;
}

function setLogExpanded(expanded) {
  logToggle.setAttribute('aria-expanded', String(expanded));
  logContainer.hidden = !expanded;
  logContainer.style.maxHeight = expanded ? 'none' : '';
  logContainer.style.overflowY = expanded ? 'visible' : '';
}
logToggle.addEventListener('click', () => setLogExpanded(logToggle.getAttribute('aria-expanded') !== 'true'));

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Append a timestamped entry to the on-screen log.
 * @param {string} message
 * @param {'info'|'warn'|'error'|'success'} [level='info']
 */
function log(message, level = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  const time = new Date().toLocaleTimeString();
  entry.textContent = `[${time}] ${logTextZh(message)}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

function logTextZh(message) {
  const text = String(message ?? '');
  let match;
  if ((match = text.match(/^Found (\d+) bookmark folder\(s\)\.$/))) return `发现 ${match[1]} 个收藏文件夹。`;
  if (text === 'No bookmark folders returned.') return 'X 未返回收藏文件夹。';
  if (text === 'Folder list could not be checked completely; previous assignments are kept.') return '文件夹列表未能完整检查；此前的文件夹归属会保留。';
  if ((match = text.match(/^Fetching folder "(.*)" \((\d+)\/(\d+)\)\.\.\.$/))) return `正在检查文件夹“${match[1]}”（${match[2]}/${match[3]}）…`;
  if ((match = text.match(/^Folder "(.*)": (\d+) bookmarks\.$/))) return `文件夹“${match[1]}”：已检查 ${match[2]} 条书签。`;
  if ((match = text.match(/^Folder "(.*)": could not finish checking; previous assignments are kept\.$/))) return `文件夹“${match[1]}”未能检查完毕；此前的归属会保留。`;
  if ((match = text.match(/^Folder "(.*)": empty\.$/))) return `文件夹“${match[1]}”为空。`;
  if ((match = text.match(/^No query ID for BookmarkFoldersSlice\. Skipping folders\.$/))) return '未找到文件夹列表接口，跳过文件夹检查。';
  if (text === 'No query ID for BookmarkFolderTimeline. Skipping folder contents.') return '未找到文件夹书签接口，跳过文件夹内容检查。';
  if ((match = text.match(/^Stopped: (\d+) consecutive rate limits\. Try again later\.$/))) return `连续 ${match[1]} 次受到请求频率限制，已停止。请稍后重试。`;
  if ((match = text.match(/^Cooling down for 5 minutes after (\d+) consecutive rate limits\.\.\.$/))) return `连续 ${match[1]} 次受到请求频率限制，等待 5 分钟后继续。`;
  if ((match = text.match(/^Rate limited \(attempt (\d+)\/(\d+)\)\. Waiting ([\d.]+)s\.\.\.$/))) return `请求频率受限（第 ${match[1]}/${match[2]} 次重试），等待 ${match[3]} 秒。`;
  if ((match = text.match(/^Auth error \((\d+)\)\. Credentials may have expired\. Visit x\.com to refresh\.$/))) return `X 返回认证错误（HTTP ${match[1]}）。登录信息可能已过期，请打开 X 刷新连接。`;
  if ((match = text.match(/^X rejected the request \(HTTP (\d+)\)\. Refresh the X connection before retrying; the private API may have changed\.$/))) return `X 拒绝了请求（HTTP ${match[1]}）。请重连账号后重试；X 接口可能发生变化。`;
  if ((match = text.match(/^Request attempt (\d+)\/(\d+) failed: ([a-z_]+) \((.*)\)\.$/))) {
    const errors = { network_error: '网络请求失败', http_error: 'HTTP 请求失败', invalid_response: '返回内容无法识别', graphql_error: 'X 查询接口返回错误' };
    const detail = match[4] ? `（${match[4]}）` : '';
    return `第 ${match[1]}/${match[2]} 次请求失败：${errors[match[3]] || match[3]}${detail}。`;
  }
  if ((match = text.match(/^Failed after (\d+) retries\. Stopping\.$/))) return `连续重试 ${match[1]} 次仍失败，已停止。`;
  if (text === 'No more pages (no bottom cursor).') return '已到最后一页（没有下一页游标）。';
  if (text === 'Pagination loop detected (same cursor returned). Stopping.') return '检测到分页游标重复，已停止以避免重复采集。';
  if ((match = text.match(/^(\d+) consecutive empty pages\. Stopping\.$/))) return `连续 ${match[1]} 页没有返回书签，已停止采集。`;
  if (text === 'Export stopped by user.') return '已按您的要求停止采集。';
  if ((match = text.match(/^Page (\d+): (\d+) bookmarks \(total: (\d+)\)$/))) return `第 ${match[1]} 页：本页 ${match[2]} 条书签，累计 ${match[3]} 条。`;
  if ((match = text.match(/^Page (\d+): empty page \((\d+)\/(\d+)\)$/))) return `第 ${match[1]} 页没有书签（连续空页 ${match[2]}/${match[3]}）。`;
  if ((match = text.match(/^Looking for query IDs in (\d+) bundles…$/))) return `正在检查 X 页面资源中的查询接口（共 ${match[1]} 个）。`;
  if (text === 'Opening an X tab briefly to capture current query IDs…') return '正在短暂打开 X 页面，以获取当前查询接口信息…';
  if (text === 'Current query IDs were not captured. Browse X bookmarks or a folder and try again.') return '暂未取得查询接口信息。请打开 X 收藏页或某个文件夹后重试。';
  if ((match = text.match(/^Bundle could not be read: (.*)$/))) return `无法读取 X 页面资源：${XArchive.errorTextZh(match[1])}`;
  if ((match = text.match(/^Query discovery failed: (.*)$/))) return `查询接口发现失败：${XArchive.errorTextZh(match[1])}`;
  if ((match = text.match(/^Query capture failed: (.*)$/))) return `查询接口捕获失败：${XArchive.errorTextZh(match[1])}`;
  return text;
}

function formatQueryOperations(queryIds) {
  const labels = { Bookmarks: '书签列表', BookmarkFoldersSlice: '收藏夹列表', BookmarkFolderTimeline: '文件夹内容', Likes: '点赞列表' };
  return Object.keys(queryIds).filter(key => key !== 'Likes').map(key => labels[key] || key).join('、');
}

// ---------------------------------------------------------------------------
// Elapsed timer
// ---------------------------------------------------------------------------

function startElapsedTimer() {
  startTime = Date.now();
  elapsedInterval = setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    statElapsed.textContent = formatTime(elapsedSec);

    // Compute bookmarks/min from the displayed count.
    if (elapsedSec > 0) {
      const count = parseInt(statBookmarks.textContent, 10) || 0;
      const perMin = Math.round(count / (elapsedSec / 60));
      statSpeed.textContent = perMin > 0 ? `${perMin} 条/分钟` : '--';
    }
  }, 1000);
}

function stopElapsedTimer() {
  if (elapsedInterval) {
    clearInterval(elapsedInterval);
    elapsedInterval = null;
  }
  startTime = null;
}

// ---------------------------------------------------------------------------
// UI state management
// ---------------------------------------------------------------------------

/**
 * Toggle button/section visibility to match the current export state.
 * @param {'idle'|'exporting'|'paused'|'stopped'|'complete'} state
 */
function setUIState(state) {
  exportState = state;

  // Kill any lingering cooldown countdown.
  if (state !== 'exporting' && state !== 'paused') {
    if (cooldownInterval) {
      clearInterval(cooldownInterval);
      cooldownInterval = null;
    }
    rateLimitNotice.style.display = 'none';
  }

  // Progress bar: indeterminate animation while working.
  if (state === 'exporting' || state === 'paused') {
    progressBar.classList.add('indeterminate');
  } else {
    progressBar.classList.remove('indeterminate');
  }

  const running = state === 'exporting' || state === 'paused';
  const done = state === 'stopped' || state === 'complete';

  // Start is visible when idle OR when there's a result to start over from.
  btnStart.style.display = (state === 'idle' || done) ? '' : 'none';
  btnPause.style.display = state === 'exporting' ? '' : 'none';
  btnResume.style.display = state === 'paused' ? '' : 'none';
  btnStop.style.display = running ? '' : 'none';
  progressSection.style.display = running ? '' : 'none';
  $('log-section').style.display = running || done ? '' : 'none';
  resultSection.style.display = done ? '' : 'none';
  if (running || done) setLogExpanded(state !== 'complete');
  scanLiveStatus.hidden = state === 'idle';
  if (state === 'paused') scanLiveStatus.textContent = '已暂停，可继续更新或停止更新。';
  else if (state === 'exporting') scanLiveStatus.textContent = statPhase.textContent;
  else if (done) scanLiveStatus.textContent = state === 'complete' ? '更新完成，请查看结果。' : '更新已结束，请查看结果。';
  updateLibraryButtons();
}

function updateScanPhase(message) {
  statPhase.textContent = message;
  if (exportState === 'exporting') scanLiveStatus.textContent = message;
}

// ---------------------------------------------------------------------------
// Credential checking
// ---------------------------------------------------------------------------

/**
 * Read stored credentials and query IDs, update the status indicators,
 * and enable/disable the Start button accordingly.
 */
async function checkCredentials() {
  // Polling and a user action can overlap; share one identity read.
  if (!credentialCheck) credentialCheck = readCredentials().finally(() => { credentialCheck = null; });
  return credentialCheck;
}

async function readCredentials() {
  const { userId, creds } = await getCredentials();
  const accountChanged = userId !== currentUserId;
  if (accountChanged) { libraryRecord = null; $('connection-refresh-status').textContent = ''; }
  currentUserId = userId;
  currentCreds = creds;

  // Read screen name captured by content script.
  const profileKey = `xarchive_profile_${userId}`;
  const stored = await chrome.storage.local.get(profileKey);
  currentScreenName = stored[profileKey] || null;

  // User ID indicator
  if (userId) {
    userDot.className = 'status-dot ok';
    userText.textContent = currentScreenName ? `当前账号：@${currentScreenName}` : `当前账号ID：${userId}`;
  } else {
  userDot.className = 'status-dot error';
  userText.textContent = '尚未登录。请先登录X账号。';
  }

  // Auth credentials indicator
  const ct0 = await getFreshCt0();
  if (ct0 && (creds?.authorization || creds?.['x-csrf-token'])) {
    credDot.className = 'status-dot ok';
    const age = creds.captured_at ? Math.round((Date.now() - creds.captured_at) / 60_000) : '?';
    credText.textContent = `连接已保存（${age}分钟前）`;
  } else {
    if (ct0) {
      credDot.className = 'status-dot waiting';
      credText.textContent = '已找到登录Cookie，等待捕获完整请求信息';
    } else {
      credDot.className = 'status-dot error';
      credText.textContent = '尚未捕获连接信息，请登录并浏览 X';
    }
  }

  // Query IDs indicator
  currentQueryIds = getStoredQueryIds(creds);
  if (hasRequiredQueryIds(currentQueryIds)) {
    queryidDot.className = 'status-dot ok';
    const ops = formatQueryOperations(currentQueryIds);
    queryidText.textContent = `读取已就绪：${ops}`;
  } else {
    queryidDot.className = 'status-dot waiting';
    queryidText.textContent = '开始更新时会自动准备。';
  }

  // Actionable hints
  const hints = [];
  if (!userId || !creds?.authorization) {
    hints.push('请先登录 X 并打开任意 X 页面，以建立连接。');
  }
  if (!hasRequiredQueryIds(currentQueryIds)) {
    hints.push('查询接口信息会在开始更新时自动获取，无需手动填写。');
  }

  if (hints.length > 0) {
    hintText.textContent = hints.join(' ');
    hintText.style.display = '';
  } else {
    hintText.style.display = 'none';
  }

  // Enable Start when we have at least some credentials.
  hasCredentials = !!ct0 && !!userId;
  btnStart.disabled = !hasCredentials || libraryBusy;
  renderConnectionChecklist();
  if (accountChanged) await loadLibrary();
}

// ---------------------------------------------------------------------------
// Prior export check (page reopen)
// ---------------------------------------------------------------------------

/**
 * On page load, check if a previous export left data in IndexedDB.
 * Show the staged snapshot so the user can recover or download it.
 */
async function checkPriorExport() {
  await navigator.locks.request('xarchive-export', { ifAvailable: true }, async lock => {
  if (!lock) {
    log('另一个扩展页面正在采集，请切换到该页面暂停或停止。', 'warn');
    return;
  }
  runInfo = await getExportState('run_info');
  const count = await getBookmarkCount();
  stagedSnapshotAvailable = !!runInfo && (count > 0 || !!runInfo.finished_at) && runInfo.user_id === currentUserId;
  if (runInfo?.user_id !== currentUserId) {
    resultSection.style.display = 'none';
    updateLibraryButtons();
    return;
  }
  if (count > 0 || runInfo) {
    if (runInfo && !runInfo.finished_at) {
      runInfo.collection.reason = 'tab_interrupted';
      await saveExportState('run_info', runInfo);
    }
    await showResult(runInfo?.collection.bookmarks === 'complete' ? 'complete' : 'stopped');
  }
  });
}

// ---------------------------------------------------------------------------
// Main export flow
// ---------------------------------------------------------------------------

/**
 * Collect a fresh snapshot without clearing the cumulative archive.
 *
 * Wrapped in a try/catch so any unexpected error resets the UI to idle
 * rather than leaving it stuck in the "exporting" state.
 */
async function runExport() {
  if (libraryBusy || exportState === 'exporting' || exportState === 'paused') return;
  libraryBusy = true;
  updateLibraryButtons();
  try { await navigator.locks.request('xarchive-export', { ifAvailable: true }, async lock => {
    if (!lock) { log('另一个扩展页面正在更新，请切换到该页面操作或等待完成。', 'warn'); return; }
    await checkCredentials();
    await loadLibrary();
    if (!hasCredentials) return;
    const mode = $('update-mode').value;
    if (mode === 'quick' && !libraryRecord?.data.bookmarks.length) { log('请先全量刷新或导入已有存档，再进行增量更新。', 'warn'); return; }
    logContainer.replaceChildren();
    updateScanPhase(mode === 'full' ? '正在准备全量扫描：确认账号与接口，随后检查全部收藏和文件夹。'
      : mode === 'quick' ? '正在准备近期更新…'
        : '正在准备限量试采：确认账号与接口，最多读取 3 条书签。');
    setUIState('exporting');
    stopRequested = false;
    startElapsedTimer();
    statElapsed.textContent = '0:00';
    statBookmarks.textContent = '0';
    statPages.textContent = '0';
    statFolders.textContent = '--';
    statSpeed.textContent = '--';
    runInfo = {
      user_id: currentUserId, screen_name: currentScreenName,
      archive_merged: false,
      archive_before_count: libraryRecord?.data.bookmarks.length || 0,
      archive_before_at: libraryRecord?.data.export_metadata?.exported_at || null,
      started_at: new Date().toISOString(),
      observed_at: new Date().toISOString(),
      collection: { mode, bookmarks: 'partial', folders: 'unknown', folder_list: 'unknown', folder_contents: {}, reason: 'in_progress' },
    };
    const telemetryId = operationId();
    const telemetryStart = Date.now();
    let telemetryResult = 'error';
    recordEvent('archive_update_started', { source: 'bookmarks', mode }, telemetryId);
    let staged = false;
    try {
      await verifyRunAccount();
      await clearAllData();
      await persistRun();
      staged = true;
      await runExportInner();
    } catch (err) {
      runInfo.collection.reason = 'error';
      log(`更新中断：${XArchive.errorTextZh(err.message).replace(/[。.!?]+$/u, '')}。已保存的历史内容保持不变。`, 'error');
    } finally {
      if (pauseGate) { pauseGate.resolve(); pauseGate = null; }
      runInfo.finished_at = new Date().toISOString();
      runInfo.duration_seconds = Math.floor((Date.now() - startTime) / 1000);
      const archiveBefore = libraryRecord;
      try {
        if (staged) {
          await persistRun();
          await mergeCollectedSnapshot();
          await saveExportState('run_info', { ...runInfo, archive_merged: true });
          runInfo.archive_merged = true;
          await showResult(runInfo.collection.bookmarks === 'complete' ? 'complete' : 'stopped');
          telemetryResult = runInfo.collection.bookmarks === 'complete' ? 'success'
            : runInfo.collection.reason === 'user_stopped' ? 'cancelled' : runInfo.collection.reason === 'error' ? 'error' : 'partial';
        } else setUIState('idle');
      } catch (err) {
        const saved = libraryRecord !== archiveBefore;
        log(saved ? `存档已保存，但结果信息未能刷新：${XArchive.errorTextZh(err.message)}。重新打开此页面可读取存档。` : `更新未能保存：${XArchive.errorTextZh(err.message)}。请先下载本次快照，再重试合并。`, 'error');
        try { await showResult('stopped'); }
        catch {
          for (const el of [resultTotal, resultAvailable, resultUnavailable, resultFolders, resultDuration]) el.textContent = '—';
          resultUnavailableReasons.style.display = 'none';
        }
        setUIState('stopped');
        resultHeading.textContent = saved ? '存档已保存，刷新页面可更新详情' : '本次读取结果需要恢复';
        $('result-coverage').textContent = saved ? '更新后的存档已保存。重新打开此页面可刷新详情并导出累计存档。' : '累计存档未更新。请下载本次快照保留结果，或重试“保存结果”。';
      }
      stopElapsedTimer();
      recordEvent('archive_update_completed', { source: 'bookmarks', mode,
        result: telemetryResult,
        item_count: Number(statBookmarks.textContent) || 0,
        page_count: Number(statPages.textContent) || 0,
        duration_ms: Date.now() - telemetryStart,
      }, telemetryId);
    }
  }); } finally { libraryBusy = false; updateLibraryButtons(); }
}

async function persistRun() {
  runInfo.observed_at = new Date().toISOString();
  await saveExportState('run_info', runInfo);
}

async function verifyRunAccount() {
  const { userId } = await getCredentials();
  const cookie = await chrome.cookies.get({ url: 'https://x.com', name: 'twid' });
  const cookieId = decodeURIComponent(cookie?.value || '').replaceAll('"', '').replace(/^u=/, '');
  if (userId !== runInfo.user_id || cookieId !== runInfo.user_id) throw new Error('登录的 X 账号已变更或无法验证。请切换回原账号后再开始更新。');
}

/** Folder-related operations whose IDs are desirable but not required. */
const FOLDER_OPERATIONS = ['BookmarkFoldersSlice', 'BookmarkFolderTimeline'];

/**
 * Try to discover any missing query IDs.
 *
 * 1. Background tab → captures Bookmarks + BookmarkFoldersSlice from
 *    real API calls when the bookmarks page loads.
 * 2. Bundle scraping → finds ALL operation IDs (including
 *    BookmarkFolderTimeline) from compiled JS source code.
 *
 * Both strategies are tried so that we get the most complete set.
 */
async function discoverQueryIds() {
  const control = { shouldStop: () => stopRequested, shouldPause };
  // Strategy 1: background tab (captures live IDs quickly).
  const tabIds = await captureQueryIdsViaTab(currentUserId, log, control);
  if (tabIds) {
    currentQueryIds = { ...currentQueryIds, ...tabIds };
  }

  // Strategy 2: bundle scraping for any still-missing operations.
  // The background tab can't capture BookmarkFolderTimeline (it only
  // fires when a user opens a specific folder), but the scraper can
  // find it in the compiled JS.
  const allFound = FOLDER_OPERATIONS.every((op) => currentQueryIds[op]);
  if (!hasRequiredQueryIds(currentQueryIds) || !allFound) {
    log('正在从 X 页面获取缺少的查询接口信息…', 'info');
    const scraped = await scrapeQueryIdsFromBundles(log, control);
    if (scraped) {
      currentQueryIds = { ...currentQueryIds, ...scraped };
      await storeQueryIds(currentUserId, scraped);
    }
  }

  if (hasRequiredQueryIds(currentQueryIds)) {
    const ops = formatQueryOperations(currentQueryIds);
    log(`读取已就绪：${ops}`, 'success');
    queryidDot.className = 'status-dot ok';
    queryidText.textContent = `读取已就绪：${ops}`;
    renderConnectionChecklist();
  }
}

/**
 * Inner export logic — separated so the outer function can wrap it in
 * a single try/catch/finally.
 */
async function runExportInner() {
  if (runInfo.collection.mode === 'sample' && !hasRequiredQueryIds(currentQueryIds)) {
    log('限量试采仅从 X 页面资源查找接口，不打开收藏页。', 'info');
    const scraped = await scrapeQueryIdsFromBundles(log, { shouldStop: () => stopRequested, shouldPause });
    if (scraped) { currentQueryIds = { ...currentQueryIds, ...scraped }; await storeQueryIds(currentUserId, scraped); }
  } else if (!hasRequiredQueryIds(currentQueryIds) || (runInfo.collection.mode === 'full' && FOLDER_OPERATIONS.some(op => !currentQueryIds[op]))) await discoverQueryIds();
  if (stopRequested) { runInfo.collection.reason = 'user_stopped'; return; }
  if (!hasRequiredQueryIds(currentQueryIds)) throw new Error(runInfo.collection.mode === 'sample'
    ? '未能从 X 页面资源取得书签接口信息；限量试采没有发送书签请求。'
    : '未能获取书签查询接口。请先打开 X 收藏页，确认登录后重试。');
  // Discovery may have captured a fresh session header set.
  currentCreds = (await getCredentials()).creds;
  const callbacks = {
    onLog: log, beforeRequest: verifyRunAccount,
    shouldStop: () => stopRequested, shouldPause,
    onCooldown: waitMs => {
      if (cooldownInterval) clearInterval(cooldownInterval);
      rateLimitNotice.style.display = '';
      let remaining = Math.ceil(waitMs / 1000);
      cooldownTimer.textContent = formatTime(remaining);
      cooldownInterval = setInterval(() => {
        remaining = Math.max(0, remaining - 1);
        cooldownTimer.textContent = formatTime(remaining);
        if (!remaining) { clearInterval(cooldownInterval); cooldownInterval = null; rateLimitNotice.style.display = 'none'; }
      }, 1000);
    },
  };
  if (runInfo.collection.mode === 'full') {
    updateScanPhase('正在检查文件夹');
    const folderResult = await fetchAllFolders({ queryId: currentQueryIds.BookmarkFoldersSlice, creds: currentCreds, ...callbacks });
    runInfo.collection.folder_list = folderResult.complete ? 'complete' : 'partial';
    const folders = folderResult.folders;
    runInfo.collection.folder_reason = folderResult.reason;
    statFolders.textContent = String(folders.length);
    await persistRun();
    if (folders.length && !currentQueryIds.BookmarkFolderTimeline && !stopRequested) {
      const qid = await captureFolderQueryIdViaTab(folders[0].id, currentUserId, log, { shouldStop: () => stopRequested, shouldPause });
      if (qid) { currentQueryIds.BookmarkFolderTimeline = qid; await storeQueryIds(currentUserId, { BookmarkFolderTimeline: qid }); }
    }
    await waitForCollection(BASE_DELAY_MS, () => stopRequested);
    if (!stopRequested) await fetchFolderContents({
      folders, queryId: currentQueryIds.BookmarkFolderTimeline, creds: currentCreds, ...callbacks,
      onFolderProgress: (index, total, name) => { statFolders.textContent = `${index}/${total}`; updateScanPhase(`文件夹：${name}`); },
      onCoverage: async coverage => { runInfo.collection.folder_contents = coverage; await persistRun(); },
    });
    runInfo.collection.folders = folderResult.complete && folders.every(f => runInfo.collection.folder_contents[f.id] === 'complete') ? 'complete' : 'partial';
    await persistRun();
    await waitForCollection(BASE_DELAY_MS, () => stopRequested);
  } else {
    statFolders.textContent = '未检查';
    log(runInfo.collection.mode === 'sample' ? '限量试采只请求一页最多 3 条，不检查文件夹；结果始终是仅查部分。' : '增量更新只检查近期页面；较早书签和文件夹变化不会检查。定期全量刷新可补查。', 'warn');
  }
  if (stopRequested) { runInfo.collection.reason = 'user_stopped'; return; }
  updateScanPhase(runInfo.collection.mode === 'sample' ? '正在限量试采' : runInfo.collection.mode === 'quick' ? '正在检查近期收藏' : '正在检查全部收藏');
  const result = await fetchAllBookmarks({
    queryId: currentQueryIds.Bookmarks, creds: currentCreds, ...callbacks,
    ...(runInfo.collection.mode === 'sample' ? { count: 3, maxPages: 1, maxAttempts: 1, maxBookmarks: 3 } : {}),
    knownIds: runInfo.collection.mode === 'quick' ? new Set(libraryRecord.data.bookmarks.map(b => b.tweet_id)) : undefined,
    onPage: async (tweets, pageNum) => {
      statBookmarks.textContent = String(await getBookmarkCount());
      statPages.textContent = String(pageNum);
      await persistRun();
    },
  });
  runInfo.collection.bookmarks = result.reason === 'complete' ? 'complete' : 'partial';
  runInfo.collection.reason = result.reason;
  await persistRun();
}

// ---------------------------------------------------------------------------
// Result UI (complete or stopped)
// ---------------------------------------------------------------------------

/**
 * Populate and show the result section.
 * @param {'complete'|'stopped'} reason
 */
async function showResult(reason) {
  const bookmarks = await getAllBookmarks();
  const folders = await getAllFolders();

  const available = bookmarks.filter((b) => b.status === 'available').length;
  const unavailableList = bookmarks.filter((b) => b.status === 'unavailable');
  const elapsed = await getElapsedSeconds();
  stagedSnapshotAvailable = !!runInfo && runInfo.user_id === currentUserId && (bookmarks.length > 0 || !!runInfo.finished_at);

  const merged = runMergedIntoLibrary();
  resultHeading.textContent = merged && successfullyCompletedRun()
    ? (runInfo.collection.mode === 'quick' ? '更新完成' : '更新完成')
    : merged ? '部分保存' : reason === 'complete' ? '采集完成，待合并' : '部分保存';
  $('result-coverage').textContent = coverageSummary({ export_metadata: { collection: runInfo?.collection } });
  let transition = runInfo?.update_summary;
  if (!transition && merged && libraryRecord?.previous
      && libraryRecord.data.export_metadata?.exported_at === runInfo.finished_at) {
    const snapshot = await assembleExport({ userId: runInfo.user_id, screenName: runInfo.screen_name, durationSeconds: elapsed });
    const mergedResult = XArchive.merge(libraryRecord.previous, snapshot);
    transition = updateSummary(libraryRecord.previous.bookmarks.length, libraryRecord.previous.export_metadata?.exported_at,
      libraryRecord.data.bookmarks.length, runInfo.finished_at, mergedResult.summary);
  }
  const transitionReady = merged && !!transition;
  $('result-transition').hidden = !transitionReady;
  $('result-observations').hidden = transitionReady;
  if (transitionReady) {
    $('result-before').textContent = transition.before_count.toLocaleString();
    $('result-after').textContent = transition.after_count.toLocaleString();
    $('result-changes').textContent = `新增内容 ${transition.added.toLocaleString()} 条 · 更新已有 ${transition.updated.toLocaleString()} 条`;
    const en = globalThis.XKeepsI18n?.language === 'en';
    const beforeTime = !transition.before_at && transition.before_count === 0 ? (en ? 'First collection' : '首次获取') : formatUpdateTime(transition.before_at, en);
    $('result-update-time').textContent = `更新时间：${beforeTime} → ${formatUpdateTime(transition.finished_at, en)}`;
    $('result-coverage').hidden = successfullyCompletedRun();
  } else $('result-coverage').hidden = false;
  $('result-account').textContent = runInfo?.user_id ? `更新账号：${runInfo.screen_name ? '@' + runInfo.screen_name : '昵称尚未识别'}` : '旧快照未记录账号身份；请下载后在查看器中单独打开。';
  $('btn-recover').textContent = merged ? '已保存' : '保存结果';
  $('btn-recover').hidden = merged;
  $('btn-recover').disabled = merged || !runInfo?.user_id || runInfo.user_id !== currentUserId;
  $('result-help').textContent = merged
    ? '' : '本次结果尚未合并；可在此恢复已采集内容。';
  $('result-help').hidden = merged;
  resultTotal.textContent = String(bookmarks.length);
  resultAvailable.textContent = String(available);
  resultUnavailable.textContent = String(unavailableList.length);
  resultFolders.textContent = String(folders.length);
  $('result-folder-summary').style.display = ['quick', 'sample'].includes(runInfo?.collection.mode) ? 'none' : '';
  resultDuration.textContent = formatTime(elapsed);

  // Show breakdown of unavailable reasons.
  if (unavailableList.length > 0) {
    const counts = Object.create(null);
    for (const bm of unavailableList) {
      const r = bm.unavailable_reason || '原因未知';
      counts[r] = (counts[r] || 0) + 1;
    }
    resultUnavailableReasons.innerHTML = '';
    resultUnavailableReasons.className = 'unavailable-reasons';
    for (const [r, n] of Object.entries(counts)) {
      const div = document.createElement('div');
      div.textContent = `${n} 条：${r}`;
      resultUnavailableReasons.appendChild(div);
    }
    resultUnavailableReasons.style.display = '';
  } else {
    resultUnavailableReasons.style.display = 'none';
  }

  const successfullyMerged = merged && successfullyCompletedRun();
  setUIState(successfullyMerged ? 'complete' : reason === 'complete' ? 'stopped' : reason);
  // Default once per completed snapshot; later manual scope choices stay put.
  const range = $('export-range');
  const snapshotKey = `${runInfo?.user_id}:${runInfo?.finished_at}`;
  if (successfullyMerged && range.dataset.latestSnapshot !== snapshotKey) {
    range.dataset.latestSnapshot = snapshotKey;
    range.value = 'snapshot';
    range.dispatchEvent(new Event('change'));
  }
}

function successfullyCompletedRun() {
  const collection = runInfo?.collection;
  return collection?.mode === 'quick' ? ['complete', 'quick_boundary'].includes(collection.reason)
    : collection?.reason === 'complete' && XArchive.isComplete({ export_metadata: { collection } });
}

// ---------------------------------------------------------------------------
// Download handler
// ---------------------------------------------------------------------------

async function handleSelectedExport(request = {}) {
  const batch = new ExportBatch({ operationId: request.operationId || operationId(), entry: 'home', itemCount: 0 });
  const button = btnExport;
  const originalLabel = button.textContent;
  const telemetryId = batch.outcome.operationId;
  const telemetryStart = Date.now();
  const telemetry = { source: 'bookmarks', format: $('export-format').value,
    scope: $('export-range').value === 'cumulative' ? 'cumulative' : 'snapshot',
    period: $('export-time')?.querySelector('.selected')?.dataset.period || 'all' };
  recordEvent('archive_export_started', telemetry, telemetryId);
  button.disabled = true;
  button.textContent = '正在准备导出…';
  $('export-status').textContent = '正在准备文件，请在Chrome下载对话框中选择保存位置。';
  try {
  await navigator.locks.request('xarchive-export', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('另一个页面正在采集。请等待采集结束后再导出。');
    const range = $('export-range').value;
    const format = request.format || $('export-format').value;
    let data;
    if (request.document) data = structuredClone(request.document);
    else if (range === 'cumulative') {
      if (!libraryRecord) throw new Error('当前账号还没有累计存档，请先导入JSON或全部更新。');
      data = structuredClone(libraryRecord.data);
    } else {
      runInfo = await getExportState('run_info');
      const count = await getBookmarkCount();
      if (!runInfo?.finished_at || runInfo.user_id !== currentUserId || (!count && runInfo.collection?.bookmarks !== 'complete')) {
        throw new Error('当前账号没有可导出的采集快照；请先完成或停止一次采集。');
      }
      data = await assembleExport({ userId: runInfo.user_id, screenName: runInfo.screen_name, durationSeconds: await getElapsedSeconds() });
    }
    const chosenTime = selectedTimeOptions($('export-time'));
    if (!request.document) data = filterPosts(data, chosenTime.period, chosenTime);
    batch.outcome.itemCount = data.bookmarks.length;
    batch.require(format);
    const filename = exportFilename(data, format);
    if (format === 'json') {
      const receipt = await downloadJSONReceipt(data, data.export_metadata?.screen_name || data.export_metadata?.user_id, filename,
        { userId: currentUserId, source: 'bookmarks' });
      batch.saved(format, receipt);
      if (receipt.state !== 'complete') throw new Error('浏览器无法确认下载已完成，请检查下载列表。');
    } else {
      const exportedAt = new Date().toISOString();
      const body = format === 'csv' ? buildCsv(data, { exportedAt }) : buildMarkdown(data, { exportedAt });
      const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8';
      const result = await downloadBlob(new Blob([body], { type: mime }), filename,
        { userId: currentUserId, source: 'bookmarks' });
      batch.saved(format, result);
      if (result.state !== 'complete') throw new Error('浏览器无法确认下载已完成，请检查下载列表。');
    }
    $('export-status').textContent = `下载完成：${filename}（${data.bookmarks.length.toLocaleString()} 条）。`;
    log(`导出完成：${filename}，${data.bookmarks.length.toLocaleString()} 条。`, 'success');
    recordEvent('archive_export_completed', { ...telemetry, item_count: data.bookmarks.length,
      duration_ms: Date.now() - telemetryStart, result: 'success' }, telemetryId);
  });
  const outcome = batch.finish();
  if (!request.operationId) await offerSupport(outcome, $('export-status'));
  return outcome;
  } catch (error) {
    recordEvent('archive_export_completed', { ...telemetry, duration_ms: Date.now() - telemetryStart,
      result: 'error', error_class: errorClass(error) }, telemetryId);
    $('export-status').textContent = `导出未完成：${XArchive.errorTextZh(error.message)}。存档数据保持不变，可检查后重试。`;
    log(`导出未完成：${XArchive.errorTextZh(error.message)}`, 'error');
    return batch.finish(error.name === 'AbortError' ? 'cancelled' : 'error');
  } finally {
    button.textContent = originalLabel;
    updateLibraryButtons();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format a duration in seconds as `M:SS`.
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatTime(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function archiveSummary(summary) {
  return XArchive.summaryTextZh(summary);
}

function coverageSummary(data) {
  return XArchive.describeCoverageZh(data);
}

/**
 * Get the export duration in seconds.
 * During a live run computes from `startTime`; after page reopen
 * reads the saved value from IndexedDB.
 * @returns {Promise<number>}
 */
async function getElapsedSeconds() {
  if (startTime) return Math.floor((Date.now() - startTime) / 1000);
  if (runInfo?.duration_seconds != null) return runInfo.duration_seconds;
  if (runInfo?.started_at) return Math.max(0, Math.floor((Date.parse(runInfo.finished_at || runInfo.observed_at) - Date.parse(runInfo.started_at)) / 1000));
  const saved = await getExportState('export_duration_seconds');
  return parseInt(saved || '0', 10);
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function updateLibraryButtons() {
  const running = exportState === 'exporting' || exportState === 'paused';
  const busy = running || libraryBusy || !!pendingLibraryImport;
  $('btn-import').disabled = busy || !currentUserId;
  $('btn-connection').disabled = busy || !currentUserId;
  $('btn-undo').disabled = busy || !libraryRecord?.previous;
  const snapshotSelected = $('export-range').value === 'snapshot';
  $('export-range').querySelector('[value="snapshot"]').disabled = !stagedSnapshotAvailable;
  if (snapshotSelected && !stagedSnapshotAvailable) $('export-range').value = 'cumulative';
  const selectedSnapshot = $('export-range').value === 'snapshot';
  const exportAvailable = selectedSnapshot ? stagedSnapshotAvailable : !!libraryRecord;
  btnExport.disabled = busy || !exportAvailable;
  if (!busy) btnExport.textContent = `下载 ${{ json: 'JSON', csv: 'CSV', markdown: 'Markdown' }[$('export-format').value]}`;
  $('btn-recover').disabled = busy || runMergedIntoLibrary() || !runInfo?.user_id || runInfo.user_id !== currentUserId;
  $('update-mode').disabled = busy;
  $('update-mode').querySelector('[value="quick"]').disabled = !libraryRecord?.data.bookmarks.length;
  if (!libraryRecord?.data.bookmarks.length && $('update-mode').value === 'quick') $('update-mode').value = 'full';
  else if (libraryRecord && !$('update-mode').dataset.userSelected) {
    $('update-mode').value = recommendUpdate(libraryUpdateStatus()).mode;
  }
  btnStart.disabled = busy || !hasCredentials;
  btnStart.textContent = $('update-mode').value === 'sample' ? '开始限量试采' : $('update-mode').value === 'quick' ? '近期更新' : '全部更新';
  $('mode-help').textContent = $('update-mode').value === 'sample'
    ? '只请求一页、最多 3 条书签，不检查文件夹，不重试；结果标记为仅查部分。适合小范围连接测试，不能代替增量或全量刷新。'
    : $('update-mode').value === 'quick'
    ? '检查近期收藏，保留已有记录。\n较早内容和文件夹请用全部更新检查。'
    : '检查全部可访问收藏和文件夹。\n更新时请保持此页打开。';
  $('export-range').disabled = busy;
  $('export-format').disabled = busy;
  $('export-status').textContent ||= '选择导出范围和格式。';
}

async function loadLibrary() {
  const userId = currentUserId;
  const record = userId ? await archiveStore.get(`user:${userId}`) : null;
  if (userId !== currentUserId) return;
  libraryRecord = record;
  showLibrary();
}

function showLibrary(message) {
  $('library-status').hidden = !message || message.startsWith('存档已保存。');
  $('library-status').textContent = message || '';
  if (!$('update-mode').dataset.userSelected) $('update-mode').value = recommendUpdate(libraryUpdateStatus()).mode;
  $('library-refresh').textContent = updateRecommendationText(libraryUpdateStatus(), globalThis.XKeepsI18n?.language === 'en');
  updateLibraryButtons();
  globalThis.dispatchEvent?.(new Event('xkeeps:archive-changed'));
}

function libraryUpdateStatus() {
  return { count: libraryRecord?.data.bookmarks.length || 0,
    lastFullAt: libraryRecord?.data.archive_metadata?.last_full_refresh_at,
    lastUpdatedAt: libraryRecord?.data.export_metadata?.exported_at };
}
window.addEventListener('xkeeps:language-changed', () => {
  $('library-refresh').textContent = updateRecommendationText(libraryUpdateStatus(), globalThis.XKeepsI18n?.language === 'en');
});

async function mergeCollectedSnapshot() {
  if (!runInfo?.user_id || runInfo.user_id !== currentUserId) throw new Error('此快照属于其他账号或未记录账号。请切换到对应账号，或下载后在查看器中单独打开。');
  const snapshot = await assembleExport({ userId: runInfo.user_id, screenName: runInfo.screen_name, durationSeconds: await getElapsedSeconds() });
  if (!snapshot.bookmarks.length && snapshot.export_metadata.collection.bookmarks !== 'complete') {
    runInfo.update_summary = updateSummary(runInfo.archive_before_count ?? libraryRecord?.data.bookmarks.length ?? 0,
      runInfo.archive_before_at, libraryRecord?.data.bookmarks.length || 0, runInfo.finished_at);
    showLibrary(`本次没有采集到书签，累计存档保持不变。当前账号仍保存 ${libraryRecord?.data.bookmarks.length || 0} 条书签。`);
    return;
  }
  const result = XArchive.merge(libraryRecord?.data, snapshot);
  const beforeCount = libraryRecord?.data.bookmarks.length || 0;
  const beforeAt = libraryRecord?.data.export_metadata?.exported_at;
  if (result.changed) libraryRecord = await archiveStore.save(`user:${runInfo.user_id}`, result.data, libraryRecord?.revision || 0);
  runInfo.update_summary = updateSummary(runInfo.archive_before_count ?? beforeCount,
    runInfo.archive_before_at ?? beforeAt, libraryRecord?.data.bookmarks.length || 0, runInfo.finished_at, result.summary);
  showLibrary(result.changed ? `存档已保存。${archiveSummary(result.summary)}。` : '此快照已合并，累计存档和撤销副本均未改变。');
  log(archiveSummary(result.summary), 'success');
}

$('update-mode').addEventListener('change', () => {
  $('update-mode').dataset.userSelected = 'true';
  updateLibraryButtons();
});
function updateExportChoice() {
  updateLibraryButtons();
  const range = $('export-range').value === 'snapshot' ? '最近获取' : '全部内容';
  $('export-status').textContent = `将下载${range}的${{ json: 'JSON', csv: 'CSV', markdown: 'Markdown' }[$('export-format').value]}文件。`;
}
$('export-range').addEventListener('change', updateExportChoice);
$('export-format').addEventListener('change', updateExportChoice);
$('btn-connection').addEventListener('click', async () => {
  if (libraryBusy) return;
  libraryBusy = true;
  connectionRefreshing = true;
  const refreshOperation = operationId(); const refreshStarted = Date.now();
  recordEvent('connection_refresh_started', {}, refreshOperation);
  const refreshStatus = $('connection-refresh-status');
  refreshStatus.className = 'help'; refreshStatus.textContent = '正在刷新…';
  connectionReady.hidden = true;
  updateLibraryButtons();
  try {
    await checkCredentials();
    stopRequested = false;
    currentQueryIds = {};
    queryidDot.className = 'status-dot'; $('queryid-check').hidden = true;
    connectionReady.hidden = true;
    await discoverQueryIds();
    const ready = !!currentUserId && [credDot, queryidDot, userDot].every(dot => dot.classList.contains('ok'));
    if (!ready) { queryidDot.className = 'status-dot error'; queryidText.textContent = '未能获取最新接口信息，请重试刷新。'; }
    refreshStatus.className = ready ? 'connection-refresh-success' : 'connection-refresh-error';
    recordEvent('connection_refresh_completed', { result: ready ? 'success' : 'error', duration_ms: Date.now() - refreshStarted }, refreshOperation);
    refreshStatus.textContent = ready ? '连接已刷新' : '刷新未完成，请确认已登录 X 后重试。';
    connectionRefreshing = false;
    renderConnectionChecklist();
  } catch (err) {
    connectionReady.hidden = true;
    recordEvent('connection_refresh_completed', { result: 'error', duration_ms: Date.now() - refreshStarted, error_class: errorClass(err) }, refreshOperation);
    refreshStatus.className = 'connection-refresh-error';
    refreshStatus.textContent = `刷新连接失败：${XArchive.errorTextZh(err.message)}`;
  } finally { connectionRefreshing = false; libraryBusy = false; updateLibraryButtons(); }
});
$('btn-import').addEventListener('click', () => { $('library-file').value = ''; $('library-file').click(); });
$('btn-viewer').addEventListener('click', () => dispatchEvent(new CustomEvent('xkeeps:open-browse', { detail: { source: 'bookmarks' } })));
$('library-file').addEventListener('change', async () => {
  const file = $('library-file').files[0];
  if (!file || libraryBusy) return;
  const telemetryId = operationId();
  recordEvent('archive_import_started', { source: 'bookmarks', format: 'json' }, telemetryId);
  libraryBusy = true;
  updateLibraryButtons();
  try {
    await checkCredentials();
    await loadLibrary();
    showLibrary(`正在读取 ${file.name}。预览并确认保存前，已保存存档不会改变。`);
    const data = JSON.parse(await file.text());
    XArchive.validate(data);
    if (!currentUserId || XArchive.accountId(data) !== currentUserId) throw new Error('请选择当前登录X账号的JSON文件。其他账号或未记录账号的文件可在查看器中单独打开。');
    const result = XArchive.merge(libraryRecord?.data, data);
    if (!result.changed) { recordEvent('archive_import_completed', { source: 'bookmarks', format: 'json', result: 'skipped', item_count: data.bookmarks.length }, telemetryId);
      showLibrary('内容没有变化。'); return; }
    pendingLibraryImport = { ...result, userId: currentUserId, revision: libraryRecord?.revision || 0, telemetryId };
    $('library-review-title').textContent = '确认更新';
    $('library-review-expectation').textContent = '保存后会补充和刷新此账号的书签；较早内容仍会保留，可撤销本次更新。';
    $('library-save').textContent = '保存更新';
    $('library-review-summary').textContent = `${file.name} · 账号 ${currentUserId}。${archiveSummary(result.summary)}。`;
    $('library-review-coverage').textContent = coverageSummary(data);
    $('library-review-error').textContent = '';
    $('library-review').showModal();
  } catch (err) { recordEvent('archive_import_completed', { source: 'bookmarks', format: 'json', result: 'error', error_class: errorClass(err) }, telemetryId);
    showLibrary(`无法导入：${XArchive.errorTextZh(err.message)}。已保存存档保持不变。`); }
  finally { libraryBusy = false; updateLibraryButtons(); }
});
$('library-cancel').addEventListener('click', () => { if (pendingLibraryImport?.telemetryId) recordEvent('archive_import_completed', { source: 'bookmarks', format: 'json', result: 'cancelled' }, pendingLibraryImport.telemetryId);
  pendingLibraryImport = null; $('library-review').close(); showLibrary('已取消，存档未改变。'); });
$('library-review').addEventListener('cancel', e => { if (libraryBusy) e.preventDefault(); else { if (pendingLibraryImport?.telemetryId) recordEvent('archive_import_completed', { source: 'bookmarks', format: 'json', result: 'cancelled' }, pendingLibraryImport.telemetryId);
  pendingLibraryImport = null; showLibrary('已取消，存档未改变。'); } });
$('library-save').addEventListener('click', async () => {
  if (libraryBusy || !pendingLibraryImport) return;
  libraryBusy = true;
  $('library-save').disabled = $('library-cancel').disabled = true;
  const pending = pendingLibraryImport;
  try {
    const { userId } = await getCredentials();
    if (userId !== pending.userId) throw new Error('登录账号已切换。请取消并为当前账号重新导入文件。');
    libraryRecord = pending.undo
      ? await archiveStore.undo(`user:${pending.userId}`, pending.revision)
      : await archiveStore.save(`user:${pending.userId}`, pending.data, pending.revision);
    if (pending.telemetryId) recordEvent('archive_import_completed', { source: 'bookmarks', format: 'json', result: 'success',
      item_count: pending.data.bookmarks.length }, pending.telemetryId);
    pendingLibraryImport = null;
    $('library-review').close();
    showLibrary(pending.undo ? '已恢复上一个存档版本。建议导出一份JSON备份。' : `存档已保存。${archiveSummary(pending.summary)}。`);
  } catch (err) { $('library-review-error').textContent = `保存失败：${XArchive.errorTextZh(err.message)}。此前的存档保持不变。`; }
  finally { libraryBusy = false; $('library-save').disabled = $('library-cancel').disabled = false; updateLibraryButtons(); }
});
$('btn-export').addEventListener('click', handleSelectedExport);
window.addEventListener('xkeeps:download-format', async event => {
  if (event.detail.source !== 'bookmarks') return;
  $('export-format').value = event.detail.format;
  event.detail.resolve(await handleSelectedExport(event.detail));
});
window.addEventListener('xkeeps:local-archive-cleared', event => {
  if (event.detail.source !== 'bookmarks' || event.detail.userId !== currentUserId) return;
  libraryRecord = null; runInfo = null; stagedSnapshotAvailable = false;
  setUIState('idle');
  loadLibrary().catch(error => { $('library-status').hidden = false; $('library-status').textContent = `读取失败：${XArchive.errorTextZh(error.message)}`; });
});
$('btn-undo').addEventListener('click', async () => {
  if (!libraryRecord?.previous || libraryBusy) return;
  pendingLibraryImport = { undo: true, userId: currentUserId, revision: libraryRecord.revision };
  $('library-review-title').textContent = '撤销并恢复上个存档';
  $('library-review-summary').textContent = `账号 ${currentUserId}。恢复到上次更新前的 ${libraryRecord.previous.bookmarks.length.toLocaleString()} 条书签；当前存档共 ${libraryRecord.data.bookmarks.length.toLocaleString()} 条。`;
  $('library-review-coverage').textContent = '此操作会恢复之前保存的书签和文件夹归属。';
  $('library-review-expectation').textContent = '恢复到上次更新前的内容。\n此次撤销只能使用一次。\n已下载文件不受影响。';
  $('library-review-error').textContent = '';
  $('library-save').textContent = '确认恢复';
  $('library-review').showModal();
  updateLibraryButtons();
});
$('btn-recover').addEventListener('click', async () => {
  if (libraryBusy) return;
  libraryBusy = true;
  updateLibraryButtons();
  try { await navigator.locks.request('xarchive-export', { ifAvailable: true }, async lock => {
    if (!lock) { log('另一个页面正在采集，请等待结束后再合并快照。', 'warn'); return; }
    try {
      await checkCredentials();
      await loadLibrary();
      runInfo = await getExportState('run_info');
      await mergeCollectedSnapshot();
      await saveExportState('run_info', { ...runInfo, archive_merged: true });
      runInfo.archive_merged = true;
      await showResult(runInfo.collection.bookmarks === 'complete' ? 'complete' : 'stopped');
    } catch (err) { showLibrary(`无法合并快照：${XArchive.errorTextZh(err.message)}`); }
  }); } catch (err) { showLibrary(`无法恢复：${XArchive.errorTextZh(err.message)}`); }
  finally { libraryBusy = false; updateLibraryButtons(); }
});

btnStart.addEventListener('click', () => runExport().catch(err => { log(XArchive.errorTextZh(err.message), 'error'); setUIState('idle'); }));

btnPause.addEventListener('click', () => {
  setUIState('paused');
  log('已请求暂停；当前正在处理的页面可能完成，之后会停止新请求，直到您继续。', 'warn');
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  pauseGate = { promise, resolve };
});

btnResume.addEventListener('click', () => {
  if (pauseGate) {
    pauseGate.resolve();
    pauseGate = null;
  }
  setUIState('exporting');
  log('采集已继续。', 'info');
});

btnStop.addEventListener('click', () => {
  stopRequested = true;
  if (pauseGate) {
    pauseGate.resolve();
    pauseGate = null;
  }
  log('已请求停止；当前页面处理结束后将保存部分结果。', 'warn');
});


// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function init() {
  versionInfo.textContent = `v${VERSION}`;
  log('Xkeeps 已启动。', 'info');
  setUIState('idle');
  await checkCredentials();
  showLibrary();
  await checkPriorExport();

  // Re-check credentials periodically (user might browse x.com in another tab).
  setInterval(async () => {
    if (exportState !== 'exporting' && exportState !== 'paused' && !libraryBusy && !pendingLibraryImport) {
      const previousUser = currentUserId;
      try {
        await checkCredentials();
        if (previousUser !== currentUserId) { await loadLibrary(); await checkPriorExport(); }
      } catch (err) { log(`无法刷新账号状态：${XArchive.errorTextZh(err.message)}`, 'error'); }
    }
  }, 10_000);
}

init().catch(err => { $('library-status').textContent = `初始化失败：${XArchive.errorTextZh(err.message)}`; log(`初始化失败：${XArchive.errorTextZh(err.message)}`, 'error'); });
chrome.runtime.onMessage?.addListener(message => {
  if (message?.type === 'xkeeps:archive-updated' && message.source === 'bookmarks' && message.userId === currentUserId) {
    loadLibrary().catch(err => log(`无法读取定时更新后的存档：${XArchive.errorTextZh(err.message)}`, 'error'));
  }
});
