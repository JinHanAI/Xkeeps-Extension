/** Collect staged snapshots and merge into a separate account-scoped archive.
 * Pause/Resume works within an open tab. Interrupted snapshots are recoverable. */
import './lib/archive.js';
import { getCredentials, getFreshCt0 } from './lib/api.js';
import { BASE_DELAY_MS, waitForCollection } from './lib/utils.js';
import { getStoredQueryIds, hasRequiredQueryIds, scrapeQueryIdsFromBundles, captureQueryIdsViaTab, captureFolderQueryIdViaTab, storeQueryIds } from './lib/query-ids.js';
import { fetchAllBookmarks } from './lib/fetcher.js';
import { fetchAllFolders, fetchFolderContents } from './lib/folders.js';
import { getBookmarkCount, getAllBookmarks, getAllFolders, getExportState, saveExportState, clearAllData } from './lib/db.js';
import { assembleExport, downloadJSON } from './lib/exporter.js';
import { VERSION } from './version.js';

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

const btnStart = $('btn-start');
const btnPause = $('btn-pause');
const btnResume = $('btn-resume');
const btnStop = $('btn-stop');

const progressSection = $('progress-section');
const statPhase = $('stat-phase');
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
const btnDownload = $('btn-download');

const logContainer = $('log');
const versionInfo = $('version-info');

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
  entry.textContent = `[${time}] ${message}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
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
      statSpeed.textContent = perMin > 0 ? `${perMin}/min` : '--';
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
  resultSection.style.display = done ? '' : 'none';
  updateLibraryButtons();
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
  if (accountChanged) libraryRecord = null;
  currentUserId = userId;
  currentCreds = creds;

  // Read screen name captured by content script.
  const profileKey = `xarchive_profile_${userId}`;
  const stored = await chrome.storage.local.get(profileKey);
  currentScreenName = stored[profileKey] || null;

  // User ID indicator
  if (userId) {
    userDot.className = 'status-dot ok';
    userText.textContent = currentScreenName ? `@${currentScreenName} (${userId})` : `User ID: ${userId}`;
  } else {
    userDot.className = 'status-dot error';
    userText.textContent = 'No user session detected';
  }

  // Auth credentials indicator
  const ct0 = await getFreshCt0();
  if (ct0 && (creds?.authorization || creds?.['x-csrf-token'])) {
    credDot.className = 'status-dot ok';
    const age = creds.captured_at ? Math.round((Date.now() - creds.captured_at) / 60_000) : '?';
    credText.textContent = `Credentials captured (${age} min ago)`;
  } else {
    if (ct0) {
      credDot.className = 'status-dot waiting';
      credText.textContent = 'Cookie found but full headers not captured yet';
    } else {
      credDot.className = 'status-dot error';
      credText.textContent = 'No credentials captured';
    }
  }

  // Query IDs indicator
  currentQueryIds = getStoredQueryIds(creds);
  if (hasRequiredQueryIds(currentQueryIds)) {
    queryidDot.className = 'status-dot ok';
    const ops = Object.keys(currentQueryIds).join(', ');
    queryidText.textContent = `Query IDs: ${ops}`;
  } else {
    queryidDot.className = 'status-dot waiting';
    queryidText.textContent = 'Query IDs not yet captured (auto-discovered on export start)';
  }

  // Actionable hints
  const hints = [];
  if (!userId || !creds?.authorization) {
    hints.push('Browse x.com while logged in to capture credentials.');
  }
  if (!hasRequiredQueryIds(currentQueryIds)) {
    hints.push('Query IDs will be auto-discovered when you start an update.');
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
    log('Another extension tab is collecting data. Use that tab to pause or stop it.', 'warn');
    return;
  }
  runInfo = await getExportState('run_info');
  const count = await getBookmarkCount();
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
    if (!lock) { log('An update is already running in another extension tab. Use that tab or wait for it to finish.', 'warn'); return; }
    await checkCredentials();
    await loadLibrary();
    if (!hasCredentials) return;
    const mode = $('update-mode').value;
    if (mode === 'quick' && !libraryRecord?.data.bookmarks.length) { log('Start with a full refresh or import an existing archive before using Quick update.', 'warn'); return; }
    setUIState('exporting');
    stopRequested = false;
    startElapsedTimer();
    statBookmarks.textContent = '0';
    statPages.textContent = '0';
    runInfo = {
      user_id: currentUserId, screen_name: currentScreenName,
      started_at: new Date().toISOString(),
      observed_at: new Date().toISOString(),
      collection: { mode, bookmarks: 'partial', folders: 'unknown', folder_list: 'unknown', folder_contents: {}, reason: 'in_progress' },
    };
    let staged = false;
    try {
      await verifyRunAccount();
      await clearAllData();
      await persistRun();
      staged = true;
      await runExportInner();
    } catch (err) {
      runInfo.collection.reason = 'error';
      log(`Update interrupted: ${err.message}. Previously saved content is preserved.`, 'error');
    } finally {
      if (pauseGate) { pauseGate.resolve(); pauseGate = null; }
      runInfo.finished_at = new Date().toISOString();
      runInfo.duration_seconds = Math.floor((Date.now() - startTime) / 1000);
      const archiveBefore = libraryRecord;
      try {
        if (staged) {
          await persistRun();
          await mergeCollectedSnapshot();
          await showResult(runInfo.collection.bookmarks === 'complete' ? 'complete' : 'stopped');
        } else setUIState('idle');
      } catch (err) {
        const saved = libraryRecord !== archiveBefore;
        log(saved ? `Archive saved, but result details could not refresh: ${err.message}. Reopen this page to load the saved archive.` : `Could not save the update: ${err.message}. Download the collected snapshot, then retry merging it.`, 'error');
        try { await showResult('stopped'); }
        catch {
          for (const el of [resultTotal, resultAvailable, resultUnavailable, resultFolders, resultDuration]) el.textContent = '—';
          resultUnavailableReasons.style.display = 'none';
        }
        setUIState('stopped');
        resultHeading.textContent = saved ? 'Archive saved; reload to refresh details' : 'Collected snapshot needs recovery';
        $('result-coverage').textContent = saved ? 'Your updated archive is saved. Reopen this page to refresh its details and download the combined JSON.' : 'The saved archive was not updated. Download the latest snapshot to preserve collected data, or retry Merge collected snapshot.';
      }
      stopElapsedTimer();
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
  if (userId !== runInfo.user_id || cookieId !== runInfo.user_id) throw new Error('The signed-in X account changed or could not be verified. Return to the original account before starting another update.');
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
    log('Scraping JS bundles for remaining query IDs...', 'info');
    const scraped = await scrapeQueryIdsFromBundles(log, control);
    if (scraped) {
      currentQueryIds = { ...currentQueryIds, ...scraped };
      await storeQueryIds(currentUserId, scraped);
    }
  }

  if (hasRequiredQueryIds(currentQueryIds)) {
    const ops = Object.keys(currentQueryIds).join(', ');
    log(`Query IDs ready: ${ops}`, 'success');
    queryidDot.className = 'status-dot ok';
    queryidText.textContent = `Query IDs: ${ops}`;
  }
}

/**
 * Inner export logic — separated so the outer function can wrap it in
 * a single try/catch/finally.
 */
async function runExportInner() {
  if (!hasRequiredQueryIds(currentQueryIds) || (runInfo.collection.mode === 'full' && FOLDER_OPERATIONS.some(op => !currentQueryIds[op]))) await discoverQueryIds();
  if (stopRequested) { runInfo.collection.reason = 'user_stopped'; return; }
  if (!hasRequiredQueryIds(currentQueryIds)) throw new Error('Could not discover Bookmarks query ID. Browse your X bookmarks and retry.');
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
    statPhase.textContent = 'Checking folders';
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
      onFolderProgress: (index, total, name) => { statFolders.textContent = `${index}/${total}`; statPhase.textContent = `Folder: ${name}`; },
      onCoverage: async coverage => { runInfo.collection.folder_contents = coverage; await persistRun(); },
    });
    runInfo.collection.folders = folderResult.complete && folders.every(f => runInfo.collection.folder_contents[f.id] === 'complete') ? 'complete' : 'partial';
    await persistRun();
    await waitForCollection(BASE_DELAY_MS, () => stopRequested);
  } else {
    statFolders.textContent = 'Not checked';
    log('Quick update checks recent pages until a whole page is already archived. Older bookmarks and folders are not refreshed.', 'warn');
  }
  if (stopRequested) { runInfo.collection.reason = 'user_stopped'; return; }
  statPhase.textContent = runInfo.collection.mode === 'quick' ? 'Checking recent bookmarks' : 'Checking all bookmarks';
  const result = await fetchAllBookmarks({
    queryId: currentQueryIds.Bookmarks, creds: currentCreds, ...callbacks,
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

  resultHeading.textContent = runInfo?.collection.mode === 'quick' && runInfo?.collection.reason === 'quick_boundary' ? 'Quick update finished' : reason === 'complete' ? 'Bookmark scan finished' : 'Partial snapshot available';
  $('result-coverage').textContent = XArchive.describeCoverage({ export_metadata: { collection: runInfo?.collection } });
  $('result-account').textContent = runInfo?.user_id ? `Snapshot account: ${runInfo.screen_name ? '@' + runInfo.screen_name + ' · ' : ''}${runInfo.user_id}` : 'Legacy snapshot: account identity was not recorded. Download and open it separately in the viewer.';
  $('btn-recover').disabled = !runInfo?.user_id || runInfo.user_id !== currentUserId;
  resultTotal.textContent = String(bookmarks.length);
  resultAvailable.textContent = String(available);
  resultUnavailable.textContent = String(unavailableList.length);
  resultFolders.textContent = String(folders.length);
  $('result-folder-summary').style.display = runInfo?.collection.mode === 'quick' ? 'none' : '';
  resultDuration.textContent = formatTime(elapsed);

  // Show breakdown of unavailable reasons.
  if (unavailableList.length > 0) {
    const counts = Object.create(null);
    for (const bm of unavailableList) {
      const r = bm.unavailable_reason || 'Unknown';
      counts[r] = (counts[r] || 0) + 1;
    }
    resultUnavailableReasons.innerHTML = '';
    resultUnavailableReasons.className = 'unavailable-reasons';
    for (const [r, n] of Object.entries(counts)) {
      const div = document.createElement('div');
      div.textContent = `${n}x ${r}`;
      resultUnavailableReasons.appendChild(div);
    }
    resultUnavailableReasons.style.display = '';
  } else {
    resultUnavailableReasons.style.display = 'none';
  }

  setUIState(reason);
}

// ---------------------------------------------------------------------------
// Download handler
// ---------------------------------------------------------------------------

async function handleDownload() {
  await navigator.locks.request('xarchive-export', { ifAvailable: true }, async lock => {
    if (!lock) { log('A scan is running in another tab. Wait for it to finish before downloading its snapshot.', 'warn'); return; }
    runInfo = await getExportState('run_info');
    const data = await assembleExport({ userId: runInfo?.user_id, screenName: runInfo?.screen_name, durationSeconds: await getElapsedSeconds() });
    const filename = await downloadJSON(data, data.export_metadata.screen_name || data.export_metadata.user_id);
    log(`Download requested: ${filename}. Check your browser downloads for completion.`, 'success');
  });
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
  $('btn-combined').disabled = busy || !libraryRecord;
  $('btn-undo').disabled = busy || !libraryRecord?.previous;
  $('btn-download').disabled = busy;
  $('btn-recover').disabled = busy || !runInfo?.user_id || runInfo.user_id !== currentUserId;
  $('update-mode').disabled = busy;
  $('update-mode').querySelector('[value="quick"]').disabled = !libraryRecord?.data.bookmarks.length;
  if (!libraryRecord?.data.bookmarks.length) $('update-mode').value = 'full';
  btnStart.disabled = busy || !hasCredentials;
  btnStart.textContent = $('update-mode').value === 'quick' ? 'Quick update' : 'Full refresh';
  $('mode-help').textContent = $('update-mode').value === 'quick'
    ? 'Checks recent pages until an entire page is already archived. Older changes may be missed and folders are not checked. Run a full refresh regularly. Saved content stays. Keep this tab open.'
    : 'Checks every page and folder. Adds and refreshes collected bookmarks while preserving older saved content. Your previous archive stays saved until the merge succeeds. Keep this tab open.';
}

async function loadLibrary() {
  const userId = currentUserId;
  const record = userId ? await archiveStore.get(`user:${userId}`) : null;
  if (userId !== currentUserId) return;
  libraryRecord = record;
  showLibrary();
}

function showLibrary(message) {
  $('library-status').textContent = message || (libraryRecord
    ? `${libraryRecord.data.bookmarks.length.toLocaleString()} saved bookmarks for ${currentScreenName ? '@' + currentScreenName : currentUserId}. Updates preserve this archive.`
    : currentUserId ? 'No saved archive for this account yet. Import your earlier JSON, or start a full refresh.' : 'Browse X while signed in to choose the account for this archive.');
  const full = libraryRecord?.data.archive_metadata?.last_full_refresh_at;
  const overdue = !full || Date.now() - Date.parse(full) > 7 * 24 * 60 * 60 * 1000;
  $('library-refresh').textContent = (full ? `Last complete full refresh: ${new Date(full).toLocaleString()}. ` : 'No verified complete full refresh yet. ')
    + (overdue ? 'A full refresh is recommended to check older bookmarks and folder changes.' : 'Quick updates can miss older changes. Full refresh checks the entire collection.');
  updateLibraryButtons();
}

async function mergeCollectedSnapshot() {
  if (!runInfo?.user_id || runInfo.user_id !== currentUserId) throw new Error('This snapshot belongs to a different or unidentified account. Sign in to its account, or download it and open it separately in the viewer.');
  const snapshot = await assembleExport({ userId: runInfo.user_id, screenName: runInfo.screen_name, durationSeconds: await getElapsedSeconds() });
  if (!snapshot.bookmarks.length && snapshot.export_metadata.collection.bookmarks !== 'complete') {
    showLibrary('No bookmarks were collected. Your saved archive is unchanged.');
    return;
  }
  const result = XArchive.merge(libraryRecord?.data, snapshot);
  if (result.changed) libraryRecord = await archiveStore.save(`user:${runInfo.user_id}`, result.data, libraryRecord?.revision || 0);
  showLibrary(result.changed ? `Archive saved. ${XArchive.summaryText(result.summary)}. Download the combined archive for your viewer and backup.` : 'This snapshot is already merged. Your archive and undo copy are unchanged.');
  log(XArchive.summaryText(result.summary), 'success');
}

$('update-mode').addEventListener('change', updateLibraryButtons);
$('btn-connection').addEventListener('click', async () => {
  if (libraryBusy) return;
  libraryBusy = true;
  updateLibraryButtons();
  try {
    await checkCredentials();
    stopRequested = false;
    currentQueryIds = {};
    await discoverQueryIds();
    showLibrary(hasRequiredQueryIds(currentQueryIds) ? 'X connection refreshed. You can retry the scan; your saved archive is unchanged.' : 'Could not refresh the X connection. Browse your X bookmarks while signed in and retry.');
  } catch (err) { showLibrary(`Connection refresh failed: ${err.message}`); }
  finally { libraryBusy = false; updateLibraryButtons(); }
});
$('btn-import').addEventListener('click', () => { $('library-file').value = ''; $('library-file').click(); });
$('library-file').addEventListener('change', async () => {
  const file = $('library-file').files[0];
  if (!file || libraryBusy) return;
  libraryBusy = true;
  updateLibraryButtons();
  try {
    await checkCredentials();
    await loadLibrary();
    showLibrary(`Reading ${file.name}. Your saved archive is unchanged until you review and save the update.`);
    const data = JSON.parse(await file.text());
    XArchive.validate(data);
    if (!currentUserId || XArchive.accountId(data) !== currentUserId) throw new Error('Import a JSON file for the signed-in X account. Other or unidentified accounts can be opened separately in the viewer.');
    const result = XArchive.merge(libraryRecord?.data, data);
    if (!result.changed) { showLibrary('This file adds no changes. Your archive and undo copy are unchanged.'); return; }
    pendingLibraryImport = { ...result, userId: currentUserId, revision: libraryRecord?.revision || 0 };
    $('library-review-title').textContent = 'Review archive import';
    $('library-review-expectation').textContent = 'Save adds and refreshes bookmarks for this account. Older saved content stays. Undo restores your previous archive.';
    $('library-save').textContent = 'Save update';
    $('library-review-summary').textContent = `${file.name} · Account ${currentUserId}. ${XArchive.summaryText(result.summary)}.`;
    $('library-review-coverage').textContent = XArchive.describeCoverage(data);
    $('library-review-error').textContent = '';
    $('library-review').showModal();
  } catch (err) { showLibrary(`Could not import: ${err.message} Your saved archive is unchanged.`); }
  finally { libraryBusy = false; updateLibraryButtons(); }
});
$('library-cancel').addEventListener('click', () => { pendingLibraryImport = null; $('library-review').close(); showLibrary('Update canceled. Your saved archive is unchanged.'); });
$('library-review').addEventListener('cancel', e => { if (libraryBusy) e.preventDefault(); else { pendingLibraryImport = null; showLibrary('Update canceled. Your saved archive is unchanged.'); } });
$('library-save').addEventListener('click', async () => {
  if (libraryBusy || !pendingLibraryImport) return;
  libraryBusy = true;
  $('library-save').disabled = $('library-cancel').disabled = true;
  const pending = pendingLibraryImport;
  try {
    const { userId } = await getCredentials();
    if (userId !== pending.userId) throw new Error('The signed-in account changed. Cancel and reopen this import for the correct account.');
    libraryRecord = pending.undo
      ? await archiveStore.undo(`user:${pending.userId}`, pending.revision)
      : await archiveStore.save(`user:${pending.userId}`, pending.data, pending.revision);
    pendingLibraryImport = null;
    $('library-review').close();
    showLibrary(pending.undo ? 'Previous archive restored. Download the combined JSON to back up this version.' : `Archive saved. ${XArchive.summaryText(pending.summary)}. Download the combined JSON for your viewer and backup.`);
  } catch (err) { $('library-review-error').textContent = `Could not save: ${err.message} Your previous saved archive is unchanged.`; }
  finally { libraryBusy = false; $('library-save').disabled = $('library-cancel').disabled = false; updateLibraryButtons(); }
});
$('btn-combined').addEventListener('click', async () => {
  if (!libraryRecord) return;
  try { await downloadJSON(libraryRecord.data, libraryRecord.data.export_metadata.screen_name || currentUserId); showLibrary('Combined archive download requested. Check your browser downloads for completion.'); }
  catch (err) { showLibrary(`Download did not start: ${err.message}. Your saved archive is unchanged.`); }
});
$('btn-undo').addEventListener('click', async () => {
  if (!libraryRecord?.previous || libraryBusy) return;
  pendingLibraryImport = { undo: true, userId: currentUserId, revision: libraryRecord.revision };
  $('library-review-title').textContent = 'Restore previous archive';
  $('library-review-summary').textContent = `Account ${currentUserId}. Restore ${libraryRecord.previous.bookmarks.length.toLocaleString()} bookmarks from before the last update. Current archive: ${libraryRecord.data.bookmarks.length.toLocaleString()}.`;
  $('library-review-coverage').textContent = 'This restores saved content and folder assignments to their previous state.';
  $('library-review-expectation').textContent = 'Downloaded JSON files are unaffected. Undo is available once. Cancel keeps the current archive.';
  $('library-review-error').textContent = '';
  $('library-save').textContent = 'Restore previous archive';
  $('library-review').showModal();
  updateLibraryButtons();
});
$('btn-recover').addEventListener('click', async () => {
  if (libraryBusy) return;
  libraryBusy = true;
  updateLibraryButtons();
  try { await navigator.locks.request('xarchive-export', { ifAvailable: true }, async lock => {
    if (!lock) { log('Another tab is collecting data. Wait for it to finish before merging this snapshot.', 'warn'); return; }
    try {
      await checkCredentials();
      await loadLibrary();
      runInfo = await getExportState('run_info');
      await mergeCollectedSnapshot();
    } catch (err) { showLibrary(`Could not merge snapshot: ${err.message}`); }
  }); } catch (err) { showLibrary(`Could not recover: ${err.message}`); }
  finally { libraryBusy = false; updateLibraryButtons(); }
});

btnStart.addEventListener('click', () => runExport().catch(err => { log(err.message, 'error'); setUIState('idle'); }));

btnPause.addEventListener('click', () => {
  setUIState('paused');
  log('Pause requested. An in-flight page may finish; no further requests will start until Resume.', 'warn');
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
  log('Export resumed.', 'info');
});

btnStop.addEventListener('click', () => {
  stopRequested = true;
  if (pauseGate) {
    pauseGate.resolve();
    pauseGate = null;
  }
  log('Stop requested... finishing current page.', 'warn');
});

btnDownload.addEventListener('click', () => handleDownload().catch(err => log(`Could not download snapshot: ${err.message}`, 'error')));

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function init() {
  versionInfo.textContent = `v${VERSION}`;
  log('xarchive initialized.', 'info');
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
      } catch (err) { log(`Could not refresh account status: ${err.message}`, 'error'); }
    }
  }, 10_000);
}

init().catch(err => { $('library-status').textContent = `Could not initialize: ${err.message}`; log(err.message, 'error'); });
