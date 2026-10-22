/* Viewer import/review/save lifecycle. Loaded as a classic script for file://. */
function setArchiveBusy(busy) {
  archiveBusy = busy;
  for (const id of ['update-archive', 'open-archive', 'download-archive', 'archive-account', 'import-save', 'import-cancel']) document.getElementById(id).disabled = busy;
  document.getElementById('undo-archive').disabled = busy || !archiveRecord?.previous;
}

function archiveMessage(message) {
  if (archiveRecord) document.getElementById('archive-status').textContent = message;
  else setStatus(message);
}

async function updateArchiveControls(message) {
  const select = document.getElementById('archive-account');
  select.replaceChildren();
  for (const saved of await archiveStore.list()) {
    const option = document.createElement('option');
    option.value = saved.key;
    option.textContent = `${saved.screenName ? '@' + saved.screenName : saved.userId || '未识别账号'} · ${saved.count.toLocaleString()} 条书签`;
    select.appendChild(option);
  }
  if (archiveRecord) {
    select.value = archiveRecord.key;
    document.getElementById('archive-coverage').textContent = XArchive.describeCoverageZh(archiveRecord.data);
    const full = archiveRecord.data.archive_metadata?.last_full_refresh_at;
    document.getElementById('archive-refresh').textContent = full ? `最近完整检查：${new Date(full).toLocaleString()}。` : '尚未完整检查，建议在扩展全部更新。';
    archiveMessage(message || `此浏览器已保存 ${archiveRecord.data.bookmarks.length.toLocaleString()} 条书签。获得新导出后，可导入更新存档。`);
  }
  setArchiveBusy(archiveBusy);
}

async function renderArchive(record) {
  await processData(JSON.parse(JSON.stringify(record.data)));
  archiveRecord = record;
  await updateArchiveControls();
}

async function loadFromFile(file) {
  if (archiveBusy) return;
  setArchiveBusy(true);
  archiveMessage(`正在读取 ${file.name}（${(file.size / 1048576).toFixed(1)} MB）；已保存存档保持不变。`);
  try {
    const data = JSON.parse(await file.text());
    if (data?.format === 'xkeeps-likes') showLikesPreview(data);
    else await prepareImport(data, file.name);
  } catch (err) {
    const message = XArchive.errorTextZh(err.message);
    archiveMessage(`无法导入：${message}。已保存存档保持不变。`);
    if (typeof likesPreview !== 'undefined' && likesPreview) document.getElementById('likes-view-count').textContent = `无法打开文件：${message}`;
    if (!archiveRecord) { showError('无法导入存档', message); showFilePicker('请另选一个 xarchive JSON 文件：'); }
  } finally { setArchiveBusy(false); }
}

async function prepareImport(data, source) {
  XArchive.validate(data);
  const id = XArchive.accountId(data);
  let base = null;
  let key;
  if (importIntent === 'update' && archiveRecord) {
    base = archiveRecord;
    key = base.key;
  } else {
    key = id ? `user:${id}` : `unknown:${crypto.randomUUID()}`;
    base = await archiveStore.get(key);
  }
  archiveMessage('正在比较书签和文件夹变化；已保存存档保持不变。');
  await new Promise(resolve => setTimeout(resolve, 0));
  const result = XArchive.merge(base?.data, data);
  if (!result.changed && base) {
    await renderArchive(base);
    await archiveStore.select(key);
    archiveMessage('内容没有变化。');
    return;
  }
  pendingImport = { ...result, key, revision: base?.revision || 0, base, source };
  document.getElementById('import-title').textContent = base ? '确认更新' : '打开存档';
  document.getElementById('import-source').textContent = `${source} · 账号：${id || '未知（将单独保存）'} · 导出时间：${data.export_metadata?.exported_at || '未知'}`;
  document.getElementById('import-summary').textContent = XArchive.summaryTextZh(result.summary);
  document.getElementById('import-coverage').textContent = XArchive.describeCoverageZh(data) + (!data.export_metadata?.exported_at ? ' 未记录导出时间，因此不会覆盖已有的带时间信息。' : '');
  document.getElementById('import-expectation').textContent = base
    ? '保存后补充内容，已有记录会保留。\n可撤销并恢复上个版本。'
    : '存档保存在此浏览器，账号分别保存。\n请下载存档备份。';
  document.getElementById('import-error').textContent = '';
  document.getElementById('import-save').textContent = base ? '保存更新' : '保存存档';
  document.getElementById('import-review').showModal();
}

async function saveImport() {
  if (!pendingImport || archiveBusy) return;
  const pending = pendingImport;
  const previous = archiveRecord;
  let committed = false;
  setArchiveBusy(true);
  document.getElementById('import-error').textContent = '正在建立搜索索引并保存，请保持此页面打开…';
  try {
    // Render a disposable copy first. Parsing/index failures cannot poison the
    // durable record. The dialog keeps the candidate inaccessible until saved.
    await processData(JSON.parse(JSON.stringify(pending.data)));
    archiveRecord = pending.undo
      ? await archiveStore.undo(pending.key, pending.revision)
      : await archiveStore.save(pending.key, pending.data, pending.revision);
    committed = true;
    pendingImport = null;
    document.getElementById('import-review').close();
    await updateArchiveControls(pending.undo ? '已恢复上一个存档版本。建议下载存档备份。' : `存档已保存。${XArchive.summaryTextZh(pending.summary)}。建议下载存档备份。`);
  } catch (err) {
    if (committed) {
      archiveMessage(`存档已保存，但页面信息未能刷新：${XArchive.errorTextZh(err.message)}。重新打开页面可读取保存版本。`);
      return;
    }
    if (previous) {
      await processData(JSON.parse(JSON.stringify(previous.data)));
      archiveRecord = previous;
    }
    else {
      document.getElementById('app').style.display = 'none';
      document.getElementById('loading').style.display = 'flex';
    }
    document.getElementById('import-error').textContent = `保存失败：${XArchive.errorTextZh(err.message)}。此前的存档保持不变。`;
  } finally { setArchiveBusy(false); }
}

function downloadArchive() {
  if (!archiveRecord) return;
  const blob = new Blob([JSON.stringify(archiveRecord.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const name = (XArchive.accountId(archiveRecord.data) || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  link.href = url;
  link.download = `xarchive_${name}_${new Date().toISOString().slice(0, 10)}_combined.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  archiveMessage('已请求导出累计存档。请确认下载完成并妥善保存JSON备份；清理浏览器数据会删除本地副本。');
}

async function undoArchive() {
  if (archiveBusy || !archiveRecord?.previous) return;
  pendingImport = { undo: true, key: archiveRecord.key, revision: archiveRecord.revision, data: archiveRecord.previous };
  document.getElementById('import-title').textContent = '恢复存档';
  document.getElementById('import-source').textContent = `账号：${XArchive.accountId(archiveRecord.data) || '未知'}`;
  document.getElementById('import-summary').textContent = `恢复到上次更新前的 ${archiveRecord.previous.bookmarks.length.toLocaleString()} 条书签；当前存档共 ${archiveRecord.data.bookmarks.length.toLocaleString()} 条。`;
  document.getElementById('import-coverage').textContent = '此操作会恢复之前保存的书签和文件夹归属。';
  document.getElementById('import-expectation').textContent = '恢复到上次更新前的内容。\n此次撤销只能使用一次。\n已下载文件不受影响。';
  document.getElementById('import-error').textContent = '';
  document.getElementById('import-save').textContent = '确认恢复';
  document.getElementById('import-review').showModal();
}

async function getLegacyCachedData() {
  // Migrate the original viewer cache without deleting it. On unsupported
  // storage the new store reports a visible error instead of claiming a save.
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('xbm', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('data');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('data', 'readonly');
      const read = tx.objectStore('data').get('bookmarks');
      read.onsuccess = () => resolve(read.result || null);
      read.onerror = () => reject(read.error);
      tx.oncomplete = tx.onabort = () => db.close();
    };
  });
}

async function init() {
  const fileInput = document.getElementById('archive-file');
  for (const [id, intent] of [['update-archive', 'update'], ['open-archive', 'open']]) {
    document.getElementById(id).addEventListener('click', () => { importIntent = intent; fileInput.value = ''; fileInput.click(); });
  }
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFromFile(fileInput.files[0]); });
  document.getElementById('import-save').addEventListener('click', saveImport);
  document.getElementById('import-cancel').addEventListener('click', () => { pendingImport = null; document.getElementById('import-review').close(); archiveMessage('已取消，存档未改变。'); });
  document.getElementById('import-review').addEventListener('cancel', e => { if (archiveBusy) e.preventDefault(); else { pendingImport = null; archiveMessage('已取消，存档未改变。'); } });
  document.getElementById('download-archive').addEventListener('click', downloadArchive);
  document.getElementById('undo-archive').addEventListener('click', undoArchive);
  document.getElementById('archive-account').addEventListener('change', async e => {
    setArchiveBusy(true);
    try { await renderArchive(await archiveStore.get(e.target.value)); await archiveStore.select(archiveRecord.key); }
    catch (err) { archiveMessage(XArchive.errorTextZh(err.message)); }
    finally { setArchiveBusy(false); }
  });
  const active = await archiveStore.get('active');
  const saved = active ? await archiveStore.get(active.value) : null;
  if (saved) await renderArchive(saved);
  else {
    const legacy = await getLegacyCachedData();
    if (legacy) {
      const result = XArchive.merge(null, legacy);
      const key = XArchive.accountId(result.data) ? `user:${XArchive.accountId(result.data)}` : `unknown:${crypto.randomUUID()}`;
      await processData(JSON.parse(JSON.stringify(result.data)));
      archiveRecord = await archiveStore.save(key, result.data);
      await updateArchiveControls();
      archiveMessage('已兼容打开此前保存的查看器缓存。后续可导入 JSON 更新，已有书签会保留。');
    } else showFilePicker('请选择一个 xarchive JSON 文件。后续更新会保留已保存的书签。');
  }
  const source = new URL(window.location.href).searchParams.get('url');
  if (source) {
    setArchiveBusy(true);
    try {
      const url = new URL(source, window.location.href);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('在线存档地址必须使用 HTTP 或 HTTPS；本地文件请使用文件选择器。');
      archiveMessage('正在读取指定存档以供预览；已保存存档保持不变。');
      const response = await fetch(url.href, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`存档服务器返回 HTTP ${response.status}。`);
      importIntent = 'open';
      await prepareImport(await response.json(), url.href);
    } catch (err) {
      archiveMessage(`无法读取链接：${XArchive.errorTextZh(err.message)}`);
      if (!archiveRecord) { showError('无法读取链接', XArchive.errorTextZh(err.message)); showFilePicker('也可以选择一个 xarchive JSON 文件：'); }
    } finally { setArchiveBusy(false); }
  }
}
