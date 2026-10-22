// ---- App State ----
let allBookmarks = [];
let allFolders = [];
let archiveRecord = null;
let pendingImport = null;
let importIntent = 'open';
let archiveBusy = false;
let viewerEventsBound = false;
let lastFullRefresh = null;
// Extension pages share an origin, so keep the auxiliary viewer's archive in
// its own database. Standalone file/website viewers retain their existing DB.
const viewerStoreName = globalThis.chrome?.runtime?.id ? 'xarchive-viewer-library' : 'xarchive-library';
const archiveStore = new XArchive.ArchiveStore(viewerStoreName);
let folderMap = new Map(); // folder ID -> [bookmark indices]
const UNFILED_FOLDER = Symbol('unfiled');
let filteredIndices = [];  // indices into allBookmarks
let activeFolder = null;
let searchQuery = '';
let sortNewest = true;

// ---- Virtual Scroll State ----
const ITEM_HEIGHT_EST = 200; // estimated, will be measured
let measuredHeights = {};
let positionCache = [];
let totalHeight = 0;
let tweetResizeObserver = null;
let visibleRange = { start: 0, end: 0 };
const OVERSCAN = 5;

// ---- Search Index ----
let searchIndex = new Map();  // token -> [bookmark indices]

// ---- DOM refs ----
let feedEl, feedInnerEl, searchEl, resultCountEl, folderListEl, folderSearchEl, sortBtn, backToTopBtn;

// ---- Loading UI helpers ----
function setStatus(msg) {
  document.getElementById('load-status').textContent = msg;
}

function setProgress(pct) {
  const bar = document.getElementById('progress-bar');
  const fill = document.getElementById('progress-fill');
  bar.style.display = 'block';
  fill.style.width = Math.min(100, Math.round(pct)) + '%';
}

function hideSpinner() {
  document.getElementById('load-spinner').style.display = 'none';
}

function showError(title, detail, hints) {
  hideSpinner();
  document.getElementById('progress-bar').style.display = 'none';
  const box = document.getElementById('load-error');
  let html = `<div class="error-box"><h3>${escHtml(title)}</h3>`;
  if (detail) html += `<div class="error-detail">${escHtml(detail)}</div>`;
  if (hints && hints.length) {
    html += `<ul>`;
    for (const h of hints) html += `<li>${h}</li>`;
    html += `</ul>`;
  }
  html += `</div>`;
  box.innerHTML = html;
}

function showFilePicker(message) {
  hideSpinner();
  document.getElementById('progress-bar').style.display = 'none';
  setStatus(message || '');
  const container = document.getElementById('drop-zone-container');
  container.innerHTML = `
    <div class="drop-zone" id="drop-zone">
      <div class="drop-icon">&#128194;</div>
      <p><strong>将JSON存档拖到此处</strong></p>
      <p>或<button type="button" class="browse-link" id="browse-link">选择文件</button></p>
      <p style="font-size:12px;color:var(--text-secondary);margin-top:8px">文件只在浏览器本地处理，不会上传。</p>
      <input type="file" id="file-input" accept=".json">
    </div>`;

  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  document.getElementById('browse-link').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  // Do not let a programmatic input click bubble back and open it twice.
  dropZone.addEventListener('click', e => { if (e.target !== fileInput) fileInput.click(); });

  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) loadFromFile(file);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadFromFile(fileInput.files[0]);
  });
}

async function processData(data) {
  document.getElementById('likes-view').hidden = true;
  likesPreview = null;
  lastFullRefresh = data.archive_metadata?.last_full_refresh_at || null;
  if (!data.bookmarks || !Array.isArray(data.bookmarks)) {
    showError(
      '数据格式无效',
      'JSON 顶层需要包含 bookmarks 数组。',
      [
        `检测到的顶层字段：<code>${escHtml(Object.keys(data).join(', '))}</code>`,
        '请确认所选文件是 xarchive 导出文件。'
      ]
    );
    showFilePicker('请换一个 JSON 文件再试。');
    return;
  }

  activeFolder = null;
  searchQuery = '';
  measuredHeights = {};
  allFolders = data.folders || [];
  allBookmarks = data.bookmarks || [];
  folderMap = new Map();
  searchIndex = new Map();
  sortedIndexKeys = [];
  const totalCount = allBookmarks.length;

  setStatus(`正在处理 ${totalCount.toLocaleString()} 条书签…`);
  setProgress(70);
  await sleep(10);

  // Build folder map
  const BATCH_SIZE = 2000;
  for (let i = 0; i < allBookmarks.length; i++) {
    const b = allBookmarks[i];
    b._date = b.created_at ? new Date(b.created_at) : null;
    b._timestamp = b._date?.getTime() || 0;
    b._searchText = buildSearchText(b).toLowerCase();
    if (b.folders) {
      for (const fname of b.folder_ids || b.folders) {
        if (!folderMap.has(fname)) folderMap.set(fname, []);
        folderMap.get(fname).push(i);
      }
    }
    // Yield to UI every BATCH_SIZE items
    if (i % BATCH_SIZE === 0 && i > 0) {
      setProgress(70 + (i / totalCount) * 15);
      setStatus(`正在处理书签：${i.toLocaleString()} / ${totalCount.toLocaleString()}`);
      await sleep(0);
    }
  }

  allFolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  setStatus(`正在为 ${totalCount.toLocaleString()} 条书签建立搜索索引…`);
  setProgress(88);
  await sleep(10);
  buildSearchIndex();

  setProgress(100);
  setStatus(`已载入 ${totalCount.toLocaleString()} 条书签和 ${allFolders.length} 个文件夹。`);
  await sleep(200);

  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  feedEl = document.getElementById('feed');
  feedInnerEl = document.getElementById('feed-inner');
  searchEl = document.getElementById('search');
  resultCountEl = document.getElementById('result-count');
  folderListEl = document.getElementById('folder-list');
  folderSearchEl = document.getElementById('folder-search');
  sortBtn = document.getElementById('sort-btn');
  backToTopBtn = document.getElementById('back-to-top');

  searchEl.value = '';
  folderSearchEl.value = '';
  feedEl.scrollTop = 0;
  renderFolders();
  applyFilters();

  if (!viewerEventsBound) {
    viewerEventsBound = true;
    searchEl.addEventListener('input', debounce(onSearch, 150));
    folderSearchEl.addEventListener('input', onFolderFilter);
    sortBtn.addEventListener('click', toggleSort);
    document.getElementById('mobile-folder').addEventListener('change', e => selectFolder(e.target.value === 'unfiled' ? UNFILED_FOLDER : e.target.value.slice(3)));
    feedEl.addEventListener('scroll', onScroll);
    backToTopBtn.addEventListener('click', () => { feedEl.scrollTop = 0; });
    document.addEventListener('keydown', onKeyDown);
    if (typeof ResizeObserver !== 'undefined') {
      let feedWidth = feedEl.clientWidth;
      const observer = new ResizeObserver(() => {
        if (!filteredIndices.length) return;
        if (feedEl.clientWidth !== feedWidth) {
          feedWidth = feedEl.clientWidth;
          measuredHeights = {};
          resetVirtualScroll();
        } else renderVisible();
      });
      observer.observe(feedEl);
    }
  }

  setTimeout(() => {
    const hint = document.getElementById('kbd-hint');
    hint.style.opacity = '0';
    setTimeout(() => hint.style.display = 'none', 500);
  }, 8000);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- Search Index ----
function tokenize(text) {
  return XKeepsSearch.tokenize(text);
}

function buildSearchText(b) {
  return XKeepsSearch.searchableText(b);
}

function buildSearchIndex() {
  for (let i = 0; i < allBookmarks.length; i++) {
    const tokens = tokenize(allBookmarks[i]._searchText);
    const seen = new Set();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (!searchIndex.has(t)) searchIndex.set(t, []);
      searchIndex.get(t).push(i);
    }
  }
}

// Sorted keys for fast prefix search via binary search
let sortedIndexKeys = [];

function searchBookmarks(query) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return null;

  // Build sorted keys lazily
  if (sortedIndexKeys.length === 0) {
    sortedIndexKeys = [...searchIndex.keys()].sort();
  }

  let result = null;
  for (const token of tokens) {
    const matches = new Set();

    // Binary search for prefix start
    let lo = 0, hi = sortedIndexKeys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sortedIndexKeys[mid] < token) lo = mid + 1;
      else hi = mid;
    }
    // Collect all keys that start with this token
    for (let i = lo; i < sortedIndexKeys.length; i++) {
      const key = sortedIndexKeys[i];
      if (!key.startsWith(token)) break;
      for (const idx of searchIndex.get(key)) matches.add(idx);
    }

    if (result === null) {
      result = matches;
    } else {
      const intersection = new Set();
      for (const idx of matches) {
        if (result.has(idx)) intersection.add(idx);
      }
      result = intersection;
    }
  }
  return result || new Set();
}

// ---- Filtering & Sorting ----
function applyFilters() {
  let indices;

  // Start with folder filter
  if (activeFolder) {
    indices = folderMap.has(activeFolder) ? [...folderMap.get(activeFolder)] : [];
  } else {
    indices = Array.from({ length: allBookmarks.length }, (_, i) => i);
  }

  // Apply search
  if (searchQuery) {
    const searchResults = searchBookmarks(searchQuery);
    if (searchResults !== null) {
      indices = indices.filter(i => searchResults.has(i));
    }
  }

  // Sort
  if (sortNewest) {
    indices.sort((a, b) => allBookmarks[b]._timestamp - allBookmarks[a]._timestamp);
  } else {
    indices.sort((a, b) => allBookmarks[a]._timestamp - allBookmarks[b]._timestamp);
  }

  filteredIndices = indices;
  measuredHeights = {};
  updateResultCount();
  resetVirtualScroll();
}

function updateResultCount() {
  const total = allBookmarks.length;
  const shown = filteredIndices.length;
  const parts = [];
  if (activeFolder) parts.push(`文件夹“${activeFolder === UNFILED_FOLDER ? '未分类' : allFolders.find(f => (f.id || f.name) === activeFolder)?.name || activeFolder}”`);
  if (searchQuery) parts.push(`匹配“${searchQuery}”`);
  resultCountEl.textContent = parts.length
    ? `显示 ${shown.toLocaleString()} / ${total.toLocaleString()} 条（${parts.join('，')}）`
    : `共 ${total.toLocaleString()} 条书签`;
}

// ---- Virtual Scroll ----
function resetVirtualScroll() {
  feedEl.scrollTop = 0;
  visibleRange = { start: -1, end: -1 };

  if (filteredIndices.length === 0) {
    tweetResizeObserver?.disconnect();
    positionCache = [];
    feedInnerEl.style.height = 'auto';
    feedInnerEl.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 24 24"><path d="M10.25 3.75c-3.59 0-6.5 2.91-6.5 6.5s2.91 6.5 6.5 6.5c1.795 0 3.419-.726 4.596-1.904 1.178-1.177 1.904-2.801 1.904-4.596 0-3.59-2.91-6.5-6.5-6.5zm-8.5 6.5c0-4.694 3.806-8.5 8.5-8.5s8.5 3.806 8.5 8.5c0 1.986-.682 3.815-1.824 5.262l4.781 4.781-1.414 1.414-4.781-4.781c-1.447 1.142-3.276 1.824-5.262 1.824-4.694 0-8.5-3.806-8.5-8.5z"/></svg>
      <h3>没有结果</h3>
      <p>换个关键词或文件夹试试。</p>
    </div>`;
    return;
  }

  // Use estimated heights
  positionCache = [];
  let y = 0;
  for (let i = 0; i < filteredIndices.length; i++) {
    const h = measuredHeights[filteredIndices[i]] || ITEM_HEIGHT_EST;
    positionCache.push({ top: y, height: h });
    y += h;
  }
  totalHeight = y;
  feedInnerEl.style.height = totalHeight + 'px';
  renderVisible();
}

function renderVisible() {
  if (!filteredIndices.length) return;
  const scrollTop = feedEl.scrollTop;
  const viewHeight = feedEl.clientHeight;

  // Binary search for first visible item
  let lo = 0, hi = positionCache.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positionCache[mid].top + positionCache[mid].height < scrollTop) lo = mid + 1;
    else hi = mid;
  }
  const start = Math.max(0, lo - OVERSCAN);

  // Find last visible
  let end = start;
  while (end < positionCache.length && positionCache[end].top < scrollTop + viewHeight) end++;
  end = Math.min(positionCache.length - 1, end + OVERSCAN);

  // Only re-render if range changed
  if (start === visibleRange.start && end === visibleRange.end) return;
  visibleRange = { start, end };

  // Render
  const fragment = document.createDocumentFragment();
  for (let i = start; i <= end && i < filteredIndices.length; i++) {
    const bIdx = filteredIndices[i];
    const bookmark = allBookmarks[bIdx];
    const el = createTweetElement(bookmark, bIdx, i);
    el.style.top = positionCache[i].top + 'px';
    fragment.appendChild(el);
  }
  tweetResizeObserver?.disconnect();
  feedInnerEl.innerHTML = '';
  feedInnerEl.appendChild(fragment);
  if (typeof ResizeObserver !== 'undefined') {
    tweetResizeObserver ||= new ResizeObserver(() => { measureVisible(); renderVisible(); });
    for (const child of feedInnerEl.children) tweetResizeObserver.observe(child);
  }
  measureVisible();
  backToTopBtn.classList.toggle('visible', scrollTop > 1000);
}

function measureVisible() {

  // Measure actual heights and recalc if needed
  let needRecalc = false;
  const children = feedInnerEl.children;
  for (let c = 0; c < children.length; c++) {
    const child = children[c];
    const vIdx = parseInt(child.dataset.vidx);
    const bIdx = filteredIndices[vIdx];
    const actualH = child.offsetHeight;
    if (positionCache[vIdx] && Math.abs(actualH - positionCache[vIdx].height) > 2) {
      positionCache[vIdx].height = actualH;
      measuredHeights[bIdx] = actualH;
      needRecalc = true;
    }
  }

  if (needRecalc) {
    let y = 0;
    for (let i = 0; i < positionCache.length; i++) {
      positionCache[i].top = y;
      y += positionCache[i].height;
    }
    totalHeight = y;
    feedInnerEl.style.height = totalHeight + 'px';
    // Reposition visible items
    for (let c = 0; c < children.length; c++) {
      const vIdx = parseInt(children[c].dataset.vidx);
      children[c].style.top = positionCache[vIdx].top + 'px';
    }
  }

}

let scrollRaf = null;
function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    renderVisible();
  });
}

// ---- Tweet Rendering ----
function createTweetElement(b, bIdx, vIdx) {
  const div = document.createElement('div');
  div.className = 'tweet';
  div.dataset.vidx = vIdx;

  const authorName = b.author?.name || b.author?.screen_name || `用户 ${b.author?.user_id?.slice(-4) || '?'}`;
  const handle = b.author?.screen_name ? `@${b.author.screen_name}` : (b.author?.user_id ? `@user_${b.author.user_id.slice(-6)}` : '');
  const initial = authorName[0]?.toUpperCase() || '?';
  const dateStr = formatDate(b._date);
  const tweetUrl = `https://x.com/i/status/${encodeURIComponent(b.tweet_id)}`;

  let html = '';

  // Header
  html += `<div class="tweet-header">`;
  if (safeUrl(b.author?.profile_image_url)) {
    html += `<div class="avatar"><img src="${escHtml(safeUrl(b.author.profile_image_url))}" alt="" loading="lazy" referrerpolicy="no-referrer"></div>`;
  } else {
    html += `<div class="avatar">${escHtml(initial)}</div>`;
  }
  html += `<div class="tweet-author">`;
  html += `<span class="author-name">${escHtml(authorName)}${b.author?.verified ? ' <svg viewBox="0 0 24 24" width="16" height="16" fill="#1d9bf0" style="vertical-align:-3px"><path d="M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.27 2.52-.81 3.91C2.63 9.33 1.75 10.57 1.75 12s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.67-.88 3.34-2.19c1.39.46 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.08 4.71l-4.17-4.17 1.42-1.41 2.75 2.75 5.58-5.58 1.42 1.41-7 7z"/></svg>' : ''}</span>`;
  html += `<span class="author-handle">${escHtml(handle)}${b.author?.followers_count ? ` · ${formatNum(b.author.followers_count)} 位关注者` : ''}</span>`;
  html += `</div>`;
  html += `<span class="tweet-date"><a href="${tweetUrl}" target="_blank" rel="noopener">${dateStr}</a></span>`;
  html += `</div>`;

  // Reply indicator
  if (b.in_reply_to_tweet_id) {
    const replyHandle = b.entities?.mentions?.[0]?.screen_name;
    if (replyHandle) {
      html += `<div class="reply-indicator">回复给 <a href="https://x.com/${encodeURIComponent(replyHandle)}" target="_blank" rel="noopener noreferrer">@${escHtml(replyHandle)}</a></div>`;
    } else {
      html += `<div class="reply-indicator">回复给一条推文</div>`;
    }
  }

  if (b.status === 'unavailable') html += `<div class="archive-note">最近一次检查时内容暂不可用；如有以前保存的内容，仍会继续显示。</div>`;
  if (lastFullRefresh && b._archive?.last_seen_at && b._archive.last_seen_at < lastFullRefresh) html += `<div class="archive-note">最近一次完整全量刷新后未再观察到；已从较早存档中保留。</div>`;

  // Tweet text
  html += `<div class="tweet-text">${renderTweetText(b)}</div>`;

  // Media
  if (b.media && b.media.length > 0) {
    html += renderMedia(b.media);
  }

  // Card
  if (b.card) {
    html += renderCard(b.card, b.entities?.urls);
  }

  // Quoted tweet
  if (b.quoted_tweet) {
    html += renderQuotedTweet(b.quoted_tweet);
  }

  // Metrics
  const m = b.metrics;
  if (m) {
    html += `<div class="tweet-metrics">`;
    html += `<span class="metric replies"><svg viewBox="0 0 24 24"><path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.25-.893 4.31-2.457 5.83l-5.364 5.21c-.36.35-.928.15-1.015-.36l-.18-1.06c-.15-.89.2-1.78.84-2.37l3.74-3.41c.87-.8 1.36-1.91 1.36-3.07 0-2.41-1.95-4.37-4.36-4.37H9.756c-2.35 0-4.255 1.9-4.255 4.25v.09c0 .98.333 1.93.943 2.69l5.378 6.7c.37.46.2 1.13-.36 1.32l-.94.32c-.72.25-1.51.05-2.02-.51l-5.2-5.71C1.985 12.49 1.751 11.27 1.751 10z"/></svg>${formatNum(m.replies)}</span>`;
    html += `<span class="metric retweets"><svg viewBox="0 0 24 24"><path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"/></svg>${formatNum(m.retweets)}</span>`;
    html += `<span class="metric likes"><svg viewBox="0 0 24 24"><path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"/></svg>${formatNum(m.likes)}</span>`;
    if (m.bookmarks) html += `<span class="metric bookmarks"><svg viewBox="0 0 24 24"><path d="M4 4.5C4 3.12 5.119 2 6.5 2h11C18.881 2 20 3.12 20 4.5v18.44l-8-5.71-8 5.71V4.5zM6.5 4c-.276 0-.5.22-.5.5v14.56l6-4.29 6 4.29V4.5c0-.28-.224-.5-.5-.5h-11z"/></svg>${formatNum(m.bookmarks)}</span>`;
    if (m.views) html += `<span class="metric views"><svg viewBox="0 0 24 24"><path d="M8.75 21V3h2v18h-2zM18.75 21V8.5h2V21h-2zM13.75 21v-9h2v9h-2zM3.75 21v-4h2v4h-2z"/></svg>${formatNum(m.views)}</span>`;
    html += `</div>`;
  }

  // Folder tags
  if (b.folders && b.folders.length > 0) {
    html += `<div class="tweet-folders">`;
    for (const [index, f] of b.folders.entries()) {
      html += `<button type="button" class="folder-tag" data-folder="${escHtml(b.folder_ids?.[index] || f)}">${escHtml(f)}</button>`;
    }
    html += `</div>`;
  }

  div.innerHTML = html;
  div.querySelector('.avatar img')?.addEventListener('error', e => { e.target.parentElement.textContent = initial; }, { once: true });
  div.querySelectorAll('.media-item img, .media-item video').forEach(el => el.addEventListener('error', () => {
    const parent = el.parentElement;
    parent.replaceChildren();
    const placeholder = document.createElement('div');
    placeholder.className = 'media-placeholder';
    placeholder.textContent = '媒体暂不可用';
    parent.appendChild(placeholder);
  }, { once: true }));

  // Folder tag click
  div.querySelectorAll('.folder-tag').forEach(tag => {
    tag.addEventListener('click', (e) => {
      e.stopPropagation();
      selectFolder(tag.dataset.folder);
    });
  });

  return div;
}

// Linkify raw text in one pass, then escape each text segment. Sequential
// replacements in generated HTML can corrupt attributes and entity escapes.
function renderTweetText(b) {
  const urls = new Map((b.entities?.urls || []).filter(u => u.url).map(u => [u.url, u]));
  const terms = tokenize(searchQuery).sort((a, b) => b.length - a.length);
  const highlight = value => {
    if (!terms.length) return escHtml(value);
    const pattern = new RegExp(terms.map(escRegex).join('|'), 'giu');
    let html = '', offset = 0;
    for (const m of value.matchAll(pattern)) {
      html += escHtml(value.slice(offset, m.index)) + `<mark>${escHtml(m[0])}</mark>`;
      offset = m.index + m[0].length;
    }
    return html + escHtml(value.slice(offset));
  };
  const text = b.full_text || '';
  const pattern = /https?:\/\/[^\s<>"']+|@\w+|#[\p{L}\p{N}_]+/gu;
  let html = '', offset = 0;
  for (const m of text.matchAll(pattern)) {
    html += highlight(text.slice(offset, m.index));
    const token = m[0], entity = urls.get(token);
    const display = entity?.display_url || entity?.expanded_url || token;
    const href = token.startsWith('@') ? `https://x.com/${encodeURIComponent(token.slice(1))}`
      : token.startsWith('#') ? `https://x.com/search?q=${encodeURIComponent(token)}`
      : safeUrl(entity?.expanded_url || token);
    // A bare t.co URL without an entity is usually an embedded-media marker.
    if (entity || !token.startsWith('https://t.co/')) {
      html += href ? `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${highlight(display)}</a>` : highlight(display);
    }
    offset = m.index + token.length;
  }
  return (html + highlight(text.slice(offset))).trim();
}

function renderMedia(media) {
  const gridClass = media.length > 1 ? ` grid-${Math.min(media.length, 4)}` : '';
  let html = `<div class="tweet-media${gridClass}">`;
  for (const m of media) {
    const poster = safeUrl(m.thumbnail_url || m.url);
    const video = getBestVideoVariant(m.variants);
    html += '<div class="media-item">';
    if (['video', 'animated_gif'].includes(m.type) && video) {
      html += `<video src="${escHtml(video)}" poster="${escHtml(poster)}" controls preload="none" playsinline ${m.type === 'animated_gif' ? 'loop muted' : ''}></video>`;
    } else if (poster) {
      html += `<img src="${escHtml(poster)}" alt="${escHtml(m.alt_text || '')}" loading="lazy" referrerpolicy="no-referrer">`;
    } else html += '<div class="media-placeholder">媒体暂不可用</div>';
    html += '</div>';
  }
  return html + '</div>';
}

function getBestVideoVariant(variants) {
  if (!variants || variants.length === 0) return null;
  // Pick the mp4 with highest bitrate under 2M, or just the best available
  const mp4s = variants.filter(v => v.content_type === 'video/mp4' && safeUrl(v.url));
  if (mp4s.length === 0) return null;
  mp4s.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  // Pick one around 800k-1.2M, fallback to best
  const preferred = mp4s.find(v => v.bitrate && v.bitrate <= 1200000 && v.bitrate >= 400000);
  return (preferred || mp4s[mp4s.length - 1])?.url || null;
}

function renderCard(card, urls) {
  if (card.type?.includes('poll')) {
    const choices = card.type.match(/poll(\d)choice/);
    const n = choices ? choices[1] : '?';
    return `<div class="tweet-poll"><span class="poll-label">投票（${n} 个选项）</span></div>`;
  }

  const url = safeUrl(card.url) || safeUrl(urls?.[0]?.expanded_url);
  let domain = '';
  try { domain = new URL(url.startsWith('http') ? url : 'https://' + url).hostname.replace('www.', ''); } catch {}

  if (!card.title && !card.description) return '';

  let html = `<a class="tweet-card" ${url ? `href="${escHtml(url)}"` : ''} target="_blank" rel="noopener noreferrer" style="text-decoration:none;color:inherit;display:block">`;
  html += `<div class="card-body">`;
  if (domain) html += `<div class="card-domain"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>${escHtml(domain)}</div>`;
  if (card.title) html += `<div class="card-title">${escHtml(card.title)}</div>`;
  if (card.description) html += `<div class="card-desc">${escHtml(card.description)}</div>`;
  html += `</div></a>`;
  return html;
}

function renderQuotedTweet(qt) {
  if (qt.status === 'unavailable' || !qt.full_text) {
    return `<div class="quoted-tweet"><div class="qt-unavailable">引用内容暂不可用。</div></div>`;
  }

  const name = qt.author?.name || qt.author?.screen_name || '用户';
  const handle = qt.author?.screen_name ? `@${qt.author.screen_name}` : '';
  const initial = name[0]?.toUpperCase() || '?';
  const url = qt.tweet_id ? `https://x.com/i/status/${encodeURIComponent(qt.tweet_id)}` : '#';

  let html = `<a class="quoted-tweet" href="${escHtml(url)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;display:block">`;
  html += `<div class="qt-header"><div class="qt-avatar">${escHtml(initial)}</div>`;
  html += `<span class="qt-name">${escHtml(name)}</span>`;
  if (handle) html += `<span class="qt-handle">${escHtml(handle)}</span>`;
  html += `</div>`;
  html += `<div class="qt-text">${escHtml(qt.full_text)}</div>`;
  html += `</a>`;
  return html;
}

// ---- Folder Sidebar ----
function renderFolders(filter) {
  const fq = (filter || '').toLowerCase();
  let html = '';

  // 全部收藏
  const allCount = allBookmarks.length;
  html += `<button type="button" class="folder-item${!activeFolder ? ' active' : ''}" data-folder="">
    <span>全部收藏</span>
    <span class="folder-count">${formatNum(allCount)}</span>
  </button>`;

  // 未分类
  const unfiledCount = allBookmarks.filter(b => !b.folders || b.folders.length === 0).length;
  html += `<button type="button" class="folder-item${activeFolder === UNFILED_FOLDER ? ' active' : ''}" data-kind="unfiled">
    <span>未分类</span>
    <span class="folder-count">${formatNum(unfiledCount)}</span>
  </button>`;

  for (const f of allFolders) {
    if (fq && !f.name.toLowerCase().includes(fq)) continue;
    const id = f.id || f.name;
    const count = folderMap.get(id)?.length || 0;
    html += `<button type="button" class="folder-item${activeFolder === id ? ' active' : ''}" data-folder="${escHtml(id)}">
      <span>${escHtml(f.name)}</span>
      <span class="folder-count">${formatNum(count)}</span>
    </button>`;
  }

  folderListEl.innerHTML = html;
  const mobile = document.getElementById('mobile-folder');
  mobile.innerHTML = '<option value="id:">全部收藏</option><option value="unfiled">未分类</option>'
    + allFolders.map(f => `<option value="id:${escHtml(f.id || f.name)}">${escHtml(f.name)} (${folderMap.get(f.id || f.name)?.length || 0})</option>`).join('');
  mobile.value = activeFolder === UNFILED_FOLDER ? 'unfiled' : `id:${activeFolder || ''}`;

  // Click handlers
  folderListEl.querySelectorAll('.folder-item').forEach(el => {
    el.addEventListener('click', () => {
      selectFolder(el.dataset.kind === 'unfiled' ? UNFILED_FOLDER : el.dataset.folder);
    });
  });
}

function selectFolder(name) {
  if (name === '') {
    activeFolder = null;
  } else if (name === UNFILED_FOLDER) {
    activeFolder = UNFILED_FOLDER;
    // Build unfiled indices on the fly
    folderMap.set(UNFILED_FOLDER, []);
    for (let i = 0; i < allBookmarks.length; i++) {
      if (!allBookmarks[i].folders || allBookmarks[i].folders.length === 0) {
        folderMap.get(UNFILED_FOLDER).push(i);
      }
    }
  } else {
    activeFolder = name;
  }
  renderFolders(folderSearchEl.value);
  applyFilters();
}

function onFolderFilter() {
  renderFolders(folderSearchEl.value);
}

// ---- Search ----
function onSearch() {
  searchQuery = searchEl.value.trim();
  applyFilters();
}

// ---- Sort ----
function toggleSort() {
  sortNewest = !sortNewest;
  sortBtn.textContent = sortNewest ? '最新' : '最早';
  applyFilters();
}

// ---- Keyboard ----
function onKeyDown(e) {
  if (pendingImport || archiveBusy) return;
  if (e.key === '/' && !isInputFocused()) {
    e.preventDefault();
    searchEl.focus();
  } else if (e.key === 'Escape') {
    if (document.activeElement === searchEl) {
      searchEl.value = '';
      searchQuery = '';
      searchEl.blur();
      applyFilters();
    }
  } else if (e.key === 'g' && !isInputFocused()) {
    feedEl.scrollTop = 0;
  }
}

function isInputFocused() {
  const tag = document.activeElement?.tagName;
  return ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag) || document.activeElement?.isContentEditable;
}

// ---- Utility ----
function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Imported strings must not become executable or local-file URLs. */
function safeUrl(value) {
  if (typeof value !== 'string') return '';
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
}

function escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatDate(d) {
  if (!d || isNaN(d)) return '';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatNum(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '0';
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

function debounce(fn, ms) {
  let timer;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

// ---- Start ----
let likesPreview = null;
function showLikesPreview(data) {
  if (data?.format !== 'xkeeps-likes' || data?.schema_version !== 1 || data?.source !== 'likes'
    || !/^\d+$/.test(data?.account?.user_id || '') || !Array.isArray(data?.likes)
    || !['complete', 'partial', 'unknown'].includes(data?.collection?.coverage)) throw new Error('点赞 JSON 格式无效。');
  if (data.likes.length > 200000 || new Set(data.likes.map(tweet => tweet.tweet_id)).size !== data.likes.length) throw new Error('点赞 JSON 存在重复或过多帖子。');
  XArchive.validate({ bookmarks: data.likes });
  likesPreview = JSON.parse(JSON.stringify(data));
  document.getElementById('loading').style.display = 'none';
  document.getElementById('app').style.display = 'none';
  document.getElementById('likes-view').hidden = false;
  document.getElementById('likes-view-search').value = '';
  document.getElementById('likes-view-meta').textContent = `账号：${data.account.screen_name ? '@' + data.account.screen_name : data.account.user_id} · 来源：点赞 · ${data.likes.length} 条 · ${data.collection.coverage === 'complete' ? '完整' : '部分或未知'}覆盖 · 点赞时间未知时不推测`;
  renderLikesPreview();
}
function renderLikesPreview() {
  if (!likesPreview) return;
  const query = document.getElementById('likes-view-search').value.trim().toLowerCase();
  const matches = likesPreview.likes.filter(tweet => [tweet.full_text, tweet.author?.name, tweet.author?.screen_name, tweet.tweet_id]
    .some(value => String(value || '').toLowerCase().includes(query)));
  document.getElementById('likes-view-count').textContent = `显示 ${Math.min(matches.length, 200)} / ${matches.length} 条点赞；图片和视频只使用远程链接。`;
  const list = document.getElementById('likes-view-list');
  list.replaceChildren();
  for (const tweet of matches.slice(0, 200)) {
    const card = document.createElement('article');
    card.style.cssText = 'background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;margin:12px 0';
    const heading = document.createElement('div');
    heading.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:10px';
    const avatar = safeUrl(tweet.author?.profile_image_url);
    if (avatar) { const image = document.createElement('img'); image.src = avatar; image.alt = ''; image.referrerPolicy = 'no-referrer'; image.style.cssText = 'width:40px;height:40px;border-radius:50%'; heading.append(image); }
    const name = document.createElement('strong');
    name.textContent = `${tweet.author?.name || '作者未知'} ${tweet.author?.screen_name ? '@' + tweet.author.screen_name : ''}`;
    heading.append(name); card.append(heading);
    const body = document.createElement('p'); body.textContent = tweet.full_text || tweet.unavailable_reason || '内容暂不可用'; body.style.whiteSpace = 'pre-wrap'; card.append(body);
    const meta = document.createElement('p'); meta.style.cssText = 'color:var(--text-secondary);margin:10px 0';
    meta.textContent = `发布时间：${tweet.created_at || '未知'} · 点赞时间：${tweet.liked_at || '未知'} · 首次采集：${tweet.first_seen_at || '未知'}`; card.append(meta);
    const link = document.createElement('a'); link.href = `https://x.com/i/status/${encodeURIComponent(tweet.tweet_id)}`;
    link.textContent = '查看原帖'; link.target = '_blank'; link.rel = 'noopener noreferrer'; card.append(link);
    for (const media of tweet.media || []) {
      const url = safeUrl(media.url || media.thumbnail_url);
      if (!url) continue;
      const mediaLink = document.createElement('a'); mediaLink.href = url; mediaLink.textContent = ` · ${media.type || '媒体'}链接`;
      mediaLink.target = '_blank'; mediaLink.rel = 'noopener noreferrer'; card.append(mediaLink);
    }
    list.append(card);
  }
}
document.getElementById('likes-view-search').addEventListener('input', debounce(renderLikesPreview, 120));
document.getElementById('likes-view-open').addEventListener('click', () => { document.getElementById('archive-file').value = ''; document.getElementById('archive-file').click(); });
document.getElementById('likes-view-back').addEventListener('click', () => {
  document.getElementById('likes-view').hidden = true;
  likesPreview = null;
  if (archiveRecord) document.getElementById('app').style.display = 'flex';
  else { document.getElementById('loading').style.display = ''; showFilePicker('请选择文件。'); }
});
init().catch(err => {
  console.error(err);
  showError(
    '初始化时发生错误',
    `${err.name}: ${err.message}`,
    [
      `错误位置：<code>${escHtml(err.stack?.split('\n').slice(0, 3).join(' <- ') || '未知')}</code>`,
      `页面协议：<code>${window.location.protocol}</code>`,
      `页面地址：<code>${escHtml(window.location.href)}</code>`,
      `浏览器信息：<code>${escHtml(navigator.userAgent)}</code>`,
      '您也可以在下方手动选择文件。'
    ]
  );
  showFilePicker('您也可以在下方手动选择文件：');
});
