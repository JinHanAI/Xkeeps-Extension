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
    option.textContent = `${saved.screenName ? '@' + saved.screenName : saved.userId || 'Unidentified account'} · ${saved.count.toLocaleString()} bookmarks`;
    select.appendChild(option);
  }
  if (archiveRecord) {
    select.value = archiveRecord.key;
    document.getElementById('archive-coverage').textContent = XArchive.describeCoverage(archiveRecord.data);
    const full = archiveRecord.data.archive_metadata?.last_full_refresh_at;
    document.getElementById('archive-refresh').textContent = full ? `Last complete full refresh: ${new Date(full).toLocaleString()}.` : 'No verified complete full refresh recorded. Use Full refresh in the extension to check older bookmarks and folders.';
    archiveMessage(message || `${archiveRecord.data.bookmarks.length.toLocaleString()} bookmarks saved in this browser. Update from JSON when you have a newer export.`);
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
  archiveMessage(`Reading ${file.name} (${(file.size / 1048576).toFixed(1)} MB). Your saved archive is unchanged.`);
  try {
    await prepareImport(JSON.parse(await file.text()), file.name);
  } catch (err) {
    archiveMessage(`Could not import: ${err.message} Your saved archive is unchanged.`);
    if (!archiveRecord) { showError('Could not import archive', err.message); showFilePicker('Select another xarchive JSON file:'); }
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
  archiveMessage('Comparing bookmarks and folder observations. Your saved archive is unchanged.');
  await new Promise(resolve => setTimeout(resolve, 0));
  const result = XArchive.merge(base?.data, data);
  if (!result.changed && base) {
    await renderArchive(base);
    await archiveStore.select(key);
    archiveMessage('This file adds no changes. Your archive and undo copy are unchanged.');
    return;
  }
  pendingImport = { ...result, key, revision: base?.revision || 0, base, source };
  document.getElementById('import-title').textContent = base ? 'Review archive update' : 'Open archive';
  document.getElementById('import-source').textContent = `${source} · Account: ${id || 'unknown (kept separately)'} · Exported: ${data.export_metadata?.exported_at || 'unknown date'}`;
  document.getElementById('import-summary').textContent = XArchive.summaryText(result.summary);
  document.getElementById('import-coverage').textContent = XArchive.describeCoverage(data) + (!data.export_metadata?.exported_at ? ' No export date: existing dated information will not be replaced.' : '');
  document.getElementById('import-expectation').textContent = base
    ? 'Save updates this account’s archive. Missing bookmarks and saved content are kept. Undo restores the previous archive.'
    : 'Save keeps this archive in this browser. Other accounts remain separate. Download a combined JSON backup after saving.';
  document.getElementById('import-error').textContent = '';
  document.getElementById('import-save').textContent = base ? 'Save update' : 'Save archive';
  document.getElementById('import-review').showModal();
}

async function saveImport() {
  if (!pendingImport || archiveBusy) return;
  const pending = pendingImport;
  const previous = archiveRecord;
  let committed = false;
  setArchiveBusy(true);
  document.getElementById('import-error').textContent = 'Building search and saving. Keep this tab open…';
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
    await updateArchiveControls(pending.undo ? 'Previous archive restored. Download the combined JSON to back up this version.' : `Saved. ${XArchive.summaryText(pending.summary)}. Download the combined archive for a backup.`);
  } catch (err) {
    if (committed) {
      archiveMessage(`Your archive was saved, but the controls could not refresh: ${err.message} Reload this page to reopen the saved version.`);
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
    document.getElementById('import-error').textContent = `Could not save: ${err.message} Your previous saved archive is unchanged.`;
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
  archiveMessage('Combined archive download requested. Keep the JSON file as your backup; browser storage can be cleared.');
}

async function undoArchive() {
  if (archiveBusy || !archiveRecord?.previous) return;
  pendingImport = { undo: true, key: archiveRecord.key, revision: archiveRecord.revision, data: archiveRecord.previous };
  document.getElementById('import-title').textContent = 'Restore previous archive';
  document.getElementById('import-source').textContent = `Account: ${XArchive.accountId(archiveRecord.data) || 'unknown'}`;
  document.getElementById('import-summary').textContent = `Restore ${archiveRecord.previous.bookmarks.length.toLocaleString()} bookmarks from before the last update. Current archive: ${archiveRecord.data.bookmarks.length.toLocaleString()}.`;
  document.getElementById('import-coverage').textContent = 'This restores saved content and folder assignments to their previous state.';
  document.getElementById('import-expectation').textContent = 'Downloaded JSON files are unaffected. Undo is available once. Cancel keeps the current archive.';
  document.getElementById('import-error').textContent = '';
  document.getElementById('import-save').textContent = 'Restore previous archive';
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
  document.getElementById('import-cancel').addEventListener('click', () => { pendingImport = null; document.getElementById('import-review').close(); archiveMessage('Update canceled. Your saved archive is unchanged.'); });
  document.getElementById('import-review').addEventListener('cancel', e => { if (archiveBusy) e.preventDefault(); else { pendingImport = null; archiveMessage('Update canceled. Your saved archive is unchanged.'); } });
  document.getElementById('download-archive').addEventListener('click', downloadArchive);
  document.getElementById('undo-archive').addEventListener('click', undoArchive);
  document.getElementById('archive-account').addEventListener('change', async e => {
    setArchiveBusy(true);
    try { await renderArchive(await archiveStore.get(e.target.value)); await archiveStore.select(archiveRecord.key); }
    catch (err) { archiveMessage(err.message); }
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
      archiveMessage('Your previous viewer cache has been upgraded. Update from JSON to merge your next export.');
    } else showFilePicker('Open an xarchive JSON file. Future imports can update it without losing saved bookmarks.');
  }
  const source = new URL(window.location.href).searchParams.get('url');
  if (source) {
    setArchiveBusy(true);
    try {
      const url = new URL(source, window.location.href);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Hosted archives must use HTTP or HTTPS. Use the file picker for local files.');
      archiveMessage('Fetching the requested archive for review. Your saved archive is unchanged.');
      const response = await fetch(url.href, { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`The archive server returned HTTP ${response.status}.`);
      importIntent = 'open';
      await prepareImport(await response.json(), url.href);
    } catch (err) {
      archiveMessage(`Could not load the URL: ${err.message}`);
      if (!archiveRecord) { showError('Could not load the URL', err.message); showFilePicker('Select an xarchive JSON file instead:'); }
    } finally { setArchiveBusy(false); }
  }
}
