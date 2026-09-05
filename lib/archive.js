/** Shared archive format, merge rules and transactional storage.
 * Classic script intentionally supports file:// viewer use as well as MV3.
 * No browser APIs are used by the pure validation/merge functions.
 */
(function (root) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
  const latest = (...values) => values.filter(Boolean).sort().at(-1) || null;
  const earliest = (...values) => values.filter(Boolean).sort()[0] || null;
  const mergeFields = (old, incoming) => {
    const result = copy(old);
    for (const [key, value] of Object.entries(incoming)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
      if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
      result[key] = object(value) && object(old[key]) ? mergeFields(old[key], value) : copy(value);
    }
    return result;
  };
  const stable = value => JSON.stringify(value, function (key, val) {
    if (object(val)) return Object.fromEntries(Object.keys(val).sort().map(k => [k, val[k]]));
    return val;
  });
  const accountId = data => {
    const id = data?.export_metadata?.user_id;
    return typeof id === 'string' && id.trim() && id !== 'unknown' ? id : null;
  };
  const coverage = data => data?.export_metadata?.collection || {};
  const isComplete = data => coverage(data).bookmarks === 'complete' && coverage(data).folders === 'complete';

  function fields(value, strings = [], numbers = []) {
    if (value == null) return;
    if (!object(value)) throw new Error('Invalid archive object.');
    for (const key of strings) if (value[key] != null && typeof value[key] !== 'string') throw new Error(`Invalid ${key}: expected text.`);
    for (const key of numbers) if (value[key] != null && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)) throw new Error(`Invalid ${key}: expected a nonnegative number.`);
  }
  function dates(value, keys) {
    for (const key of keys) if (value?.[key] != null && !date(value[key])) throw new Error(`Invalid ${key}: expected a date or null.`);
  }

  function validate(data) {
    if (!object(data) || !Array.isArray(data.bookmarks)) throw new Error('Choose an xarchive JSON file with a bookmarks array.');
    if (data.export_metadata != null && !object(data.export_metadata)) throw new Error('Invalid export metadata.');
    fields(data.export_metadata, ['user_id', 'screen_name', 'kind']);
    if (data.export_metadata?.schema_version != null && (!Number.isInteger(data.export_metadata.schema_version) || data.export_metadata.schema_version < 1)) throw new Error('Invalid schema version.');
    if (data.export_metadata?.schema_version > 2) throw new Error('This archive needs a newer version of xarchive.');
    if (data.export_metadata?.exported_at && !date(data.export_metadata.exported_at)) throw new Error('Invalid export date. Use a valid ISO date or omit an unknown date.');
    if (data.folders != null && !Array.isArray(data.folders)) throw new Error('Invalid folder list.');
    fields(data.archive_metadata);
    dates(data.archive_metadata, ['last_full_refresh_at']);
    fields(data.export_metadata?.collection, ['mode', 'bookmarks', 'folders', 'folder_list', 'reason']);
    fields(coverage(data).folder_contents);
    for (const f of data.folders || []) {
      if (!object(f) || typeof f.id !== 'string' || !f.id || typeof f.name !== 'string') throw new Error('Each folder needs a string ID and name.');
      dates(f, ['observed_at']);
    }
    for (const b of data.bookmarks) {
      if (!object(b) || typeof b.tweet_id !== 'string' || !b.tweet_id) throw new Error('Each bookmark needs a nonempty string tweet_id.');
      for (const key of ['folders', 'folder_ids']) {
        if (b[key] != null && (!Array.isArray(b[key]) || b[key].some(v => typeof v !== 'string'))) throw new Error(`Invalid ${key} for bookmark ${b.tweet_id}.`);
      }
      for (const key of ['full_text', 'created_at', 'unavailable_reason']) {
        if (b[key] != null && typeof b[key] !== 'string') throw new Error(`Invalid ${key} for bookmark ${b.tweet_id}.`);
      }
      if (b.author != null && !object(b.author)) throw new Error('Invalid bookmark author.');
      for (const key of ['name', 'screen_name', 'user_id', 'profile_image_url']) {
        if (b.author?.[key] != null && typeof b.author[key] !== 'string') throw new Error('Invalid author information.');
      }
      if (b.media != null && !Array.isArray(b.media)) throw new Error('Invalid bookmark media.');
      if (b.entities != null && !object(b.entities)) throw new Error('Invalid bookmark entities.');
      for (const key of ['hashtags', 'mentions', 'urls']) {
        if (b.entities?.[key] != null && !Array.isArray(b.entities[key])) throw new Error('Invalid bookmark entities.');
      }
      if (b.entities?.hashtags?.some(v => typeof v !== 'string')) throw new Error('Invalid hashtags.');
      fields(b, ['status', 'sort_index', 'in_reply_to_tweet_id']);
      fields(b.author, [], ['followers_count']);
      fields(b.metrics, [], ['likes', 'retweets', 'replies', 'bookmarks', 'views']);
      fields(b.card, ['type', 'url', 'title', 'description']);
      fields(b.quoted_tweet, ['tweet_id', 'status', 'full_text']);
      fields(b.quoted_tweet?.author, ['name', 'screen_name']);
      for (const u of b.entities?.urls || []) { if (!object(u)) throw new Error('Invalid URL entry.'); fields(u, ['url', 'expanded_url', 'display_url']); }
      for (const m of b.entities?.mentions || []) { if (!object(m)) throw new Error('Invalid mention.'); fields(m, ['screen_name', 'user_id']); }
      for (const m of b.media || []) {
        if (!object(m)) throw new Error('Invalid media entry.');
        fields(m, ['type', 'url', 'thumbnail_url', 'alt_text'], ['duration_ms']);
        if (m.variants != null && !Array.isArray(m.variants)) throw new Error('Invalid media variants.');
        for (const v of m.variants || []) { if (!object(v)) throw new Error('Invalid media variant.'); fields(v, ['url', 'content_type'], ['bitrate']); }
      }
      fields(b._archive);
      dates(b._archive, ['first_seen_at', 'last_seen_at', 'content_updated_at', 'folders_updated_at']);
      if (b._archive?.folder_checks != null && !Array.isArray(b._archive.folder_checks)) throw new Error('Invalid folder observations.');
      for (const c of b._archive?.folder_checks || []) {
        if (!object(c) || !c.id || typeof c.id !== 'string' || typeof c.present !== 'boolean' || typeof c.complete !== 'boolean') throw new Error('Invalid folder observation.');
        dates(c, ['checked_at']);
      }
    }
    return data;
  }

  function normalize(input) {
    validate(input);
    const data = copy(input);
    const exportedAt = date(data.export_metadata?.exported_at);
    data.export_metadata = { ...data.export_metadata, schema_version: 2 };
    data.folders ||= [];
    const names = new Map();
    for (const f of data.folders) {
      f.observed_at = Object.hasOwn(f, 'observed_at') ? date(f.observed_at) : exportedAt;
      const ids = names.get(f.name) || [];
      ids.push(f.id);
      names.set(f.name, ids);
    }
    for (const b of data.bookmarks) {
      // Never serialize viewer search/scroll helpers into the durable archive.
      for (const key of Object.keys(b)) if (key.startsWith('_') && key !== '_archive') delete b[key];
      const hasArchiveInfo = object(b._archive);
      const info = hasArchiveInfo ? b._archive : {};
      // Explicit null means unknown, including in combined-file round trips.
      const observed = (key, fallback) => Object.hasOwn(info, key) ? date(info[key]) : fallback;
      b._archive = {
        first_seen_at: observed('first_seen_at', exportedAt),
        last_seen_at: observed('last_seen_at', exportedAt),
        content_updated_at: observed('content_updated_at', b.full_text || b.media?.length ? exportedAt : null),
        folders_updated_at: observed('folders_updated_at', exportedAt),
        folders_complete: typeof info.folders_complete === 'boolean' ? info.folders_complete : coverage(data).folders === 'complete',
        folder_checks: Array.isArray(info.folder_checks) ? info.folder_checks.filter(c => object(c) && typeof c.id === 'string' && date(c.checked_at)).map(c => ({ id: c.id, checked_at: date(c.checked_at), present: !!c.present, complete: !!c.complete })) : [],
      };
      b.folders ||= [];
      if (!b.folder_ids) {
        b.folder_ids = b.folders.map(name => names.get(name)?.length === 1 ? names.get(name)[0] : `legacy:${name}`);
      }
      b.folder_ids = [...new Set(b.folder_ids)].sort();
      if (!hasArchiveInfo && !b._archive.folders_complete) {
        if (!b.folder_ids.length) b._archive.folders_updated_at = null;
        const completed = Object.entries(coverage(data).folder_contents || {}).filter(([, status]) => status === 'complete').map(([id]) => id);
        b._archive.folder_checks = [...new Set([...b.folder_ids, ...completed])].sort().map(id => ({
          id, checked_at: exportedAt, present: b.folder_ids.includes(id), complete: completed.includes(id),
        })).filter(c => c.checked_at);
      }
      for (let i = 0; i < b.folder_ids.length; i++) {
        const id = b.folder_ids[i];
        if (id.startsWith('legacy:') && !data.folders.some(f => f.id === id)) data.folders.push({ id, name: id.slice(7), observed_at: exportedAt });
      }
    }
    return data;
  }

  function mergeRecord(old, incoming) {
    if (!old) return copy(incoming);
    const a = old._archive, b = incoming._archive;
    const newer = !!b.last_seen_at && (!a.last_seen_at || b.last_seen_at > a.last_seen_at);
    const sameObservation = b.last_seen_at === a.last_seen_at;
    let result = copy(old);
    // Availability and retained content have independent clocks: a September
    // tombstone must not prevent recovering an August edit from another file.
    if (newer || (sameObservation && old.status === 'unavailable' && incoming.status === 'available')) {
      if (incoming.status) result.status = incoming.status;
      if (incoming.sort_index) result.sort_index = incoming.sort_index;
      if (incoming.status === 'unavailable') result.unavailable_reason = incoming.unavailable_reason || old.unavailable_reason;
      else delete result.unavailable_reason;
    }
    const contentNewer = b.content_updated_at && (!a.content_updated_at || b.content_updated_at > a.content_updated_at);
    const contentKeys = ['full_text', 'created_at', 'lang', 'source', 'conversation_id', 'in_reply_to_tweet_id', 'in_reply_to_user_id', 'author', 'media', 'entities', 'metrics', 'card', 'quoted_tweet'];
    const oldContent = Object.fromEntries(contentKeys.filter(k => old[k] != null).map(k => [k, old[k]]));
    const newContent = Object.fromEntries(contentKeys.filter(k => incoming[k] != null).map(k => [k, incoming[k]]));
    Object.assign(result, contentNewer ? mergeFields(oldContent, newContent) : mergeFields(newContent, oldContent));
    const foldersNewer = !!b.folders_updated_at && (!a.folders_updated_at || b.folders_updated_at > a.folders_updated_at);
    const foldersEqual = b.folders_updated_at === a.folders_updated_at;
    let folderIds = new Set(old.folder_ids);
    let folderInfo = a;
    let checks = new Map((a.folder_checks || []).map(c => [c.id, c]));
    if (b.folders_complete && (foldersNewer || (foldersEqual && !a.folders_complete))) {
      folderIds = new Set(incoming.folder_ids);
      folderInfo = b;
      checks = new Map([...checks].filter(([, c]) => c.checked_at > b.folders_updated_at));
      for (const c of checks.values()) c.present ? folderIds.add(c.id) : folderIds.delete(c.id);
    }
    const incomingChecks = b.folder_checks || [];
    for (const c of incomingChecks) {
      const previousAt = checks.get(c.id)?.checked_at || folderInfo.folders_updated_at;
      if (c.checked_at && (!previousAt || c.checked_at > previousAt || (c.checked_at === previousAt && c.complete && !checks.get(c.id)?.complete && !folderInfo.folders_complete))) {
        if (c.present) folderIds.add(c.id);
        else if (c.complete) folderIds.delete(c.id);
        checks.set(c.id, c);
      }
    }
    result.folder_ids = [...folderIds].sort();
    result._archive = {
      first_seen_at: earliest(a.first_seen_at, b.first_seen_at),
      last_seen_at: latest(a.last_seen_at, b.last_seen_at),
      content_updated_at: latest(a.content_updated_at, b.content_updated_at),
      folders_updated_at: folderInfo.folders_updated_at,
      folders_complete: folderInfo.folders_complete,
      folder_checks: [...checks.values()].sort((x, y) => x.id.localeCompare(y.id)),
    };
    return result;
  }

  function merge(base, input) {
    const incoming = normalize(input);
    const old = base ? normalize(base) : null;
    if (old && (!accountId(old) || !accountId(incoming))) throw new Error('An account ID is missing. Open this archive separately; it cannot safely be merged with another archive.');
    if (old && accountId(old) !== accountId(incoming)) throw new Error('These archives belong to different X accounts. Open the other archive separately.');
    const byId = new Map();
    for (const b of old?.bookmarks || []) byId.set(b.tweet_id, mergeRecord(byId.get(b.tweet_id), b));
    const before = new Map([...byId].map(([id, b]) => [id, stable(b)]));
    const incomingIds = new Set();
    for (const b of incoming.bookmarks) {
      incomingIds.add(b.tweet_id);
      byId.set(b.tweet_id, mergeRecord(byId.get(b.tweet_id), b));
    }
    const folders = new Map((old?.folders || []).map(f => [f.id, f]));
    for (const f of incoming.folders) {
      const prev = folders.get(f.id);
      if (!prev || (f.observed_at && (!prev.observed_at || f.observed_at > prev.observed_at))) folders.set(f.id, f);
    }
    const summary = { added: 0, updated: 0, unchanged: 0, retained: 0 };
    for (const [id, b] of byId) {
      b.folders = b.folder_ids.map(fid => folders.get(fid)?.name || fid);
      if (!before.has(id)) summary.added++;
      else if (!incomingIds.has(id)) summary.retained++;
      else if (stable(b) !== before.get(id)) summary.updated++;
      else summary.unchanged++;
    }
    const incomingAt = date(incoming.export_metadata.exported_at);
    const oldAt = date(old?.export_metadata.exported_at);
    const latestSource = !old || (incomingAt && (!oldAt || incomingAt > oldAt)) ? incoming : old;
    const fullRefreshAt = latest(old?.archive_metadata?.last_full_refresh_at, incoming.archive_metadata?.last_full_refresh_at,
      old && old.export_metadata.kind !== 'cumulative' && isComplete(old) ? oldAt : null,
      incoming.export_metadata.kind !== 'cumulative' && isComplete(incoming) ? incomingAt : null);
    const data = {
      export_metadata: { ...latestSource.export_metadata, kind: 'cumulative', schema_version: 2, exported_at: latest(oldAt, incomingAt) },
      archive_metadata: { last_full_refresh_at: fullRefreshAt },
      folders: [...folders.values()].sort((a, b) => a.id.localeCompare(b.id)),
      bookmarks: [...byId.values()].sort((a, b) => a.tweet_id.localeCompare(b.tweet_id)),
    };
    const available = data.bookmarks.filter(b => b.status === 'available').length;
    data.export_metadata.stats = {
      total_bookmarks: data.bookmarks.length, available_bookmarks: available,
      unavailable_bookmarks: data.bookmarks.length - available, total_folders: data.folders.length,
    };
    return { data, summary, changed: !old || stable(data) !== stable(old) };
  }

  function describeCoverage(data) {
    const c = coverage(data);
    const reason = {
      user_stopped: ' You stopped the scan.', tab_interrupted: ' The previous tab closed before the scan finished.',
      unrecognized_response: ' X returned a response this version could not interpret.',
      pagination_guard: ' Pagination repeated or stopped making progress.',
      auth_error: ' X rejected the session credentials.', rate_limit_exceeded: ' X kept rate-limiting the requests.',
      query_error: ' X rejected the request. Refresh the X connection before retrying.',
      max_retries: ' Requests failed after retries.', error: ' An error interrupted collection; see the extension log.',
    }[c.reason] || '';
    if (data?.export_metadata?.kind === 'cumulative') return 'Combined archive. Each bookmark keeps its own observation dates; older saved content is retained.';
    if (c.mode === 'quick') return 'Quick update: recent pages only. Older bookmarks and folder changes were not checked.' + reason;
    if (isComplete(data)) return 'Full scan finished. Missing bookmarks are retained; absence does not prove deletion.';
    if (c.bookmarks || c.folders) return (c.bookmarks === 'complete' ? 'Bookmark pages finished, but folder checks are incomplete.' : 'Incomplete scan.') + ' Collected bookmarks and successful folder checks are merged. Older bookmarks and unchecked folder assignments are kept.' + reason;
    return 'Legacy archive: collection completeness is unknown. Missing data and previous folder assignments are preserved.';
  }
  const summaryText = s => `${s.added.toLocaleString()} added · ${s.updated.toLocaleString()} refreshed · ${s.unchanged.toLocaleString()} unchanged · ${s.retained.toLocaleString()} older bookmarks retained`;

  // One atomic record holds current and previous data. Compare revisions inside
  // the same transaction to avoid silent overwrites from another open tab.
  class ArchiveStore {
    constructor(name = 'xarchive-library') { this.name = name; }
    async transaction(mode, action) {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(this.name, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('archives', { keyPath: 'key' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('archives', mode);
          let value, failure;
          tx.oncomplete = () => resolve(value);
          tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('Archive storage failed. Your previous archive is unchanged.'));
          const fail = err => { failure = err; tx.abort(); };
          try { action(tx.objectStore('archives'), result => { value = result; }, fail); }
          catch (err) { fail(err); }
        });
      } finally { db.close(); }
    }
    async get(key) {
      return this.transaction('readonly', (store, done) => { store.get(key).onsuccess = e => done(e.target.result || null); });
    }
    async list() {
      return this.transaction('readonly', (store, done) => {
        // A cursor avoids holding every account and every undo copy in memory.
        const summaries = [];
        store.openCursor().onsuccess = e => {
          const cursor = e.target.result;
          if (!cursor) return done(summaries);
          const r = cursor.value;
          if (r.key !== 'active') summaries.push({ key: r.key, userId: accountId(r.data), screenName: r.data.export_metadata.screen_name, count: r.data.bookmarks.length });
          cursor.continue();
        };
      });
    }
    async select(key) { return this.transaction('readwrite', (store, done) => { store.put({ key: 'active', value: key }); done(key); }); }
    async save(key, data, revision = 0) {
      validate(data);
      const id = accountId(data);
      if ((id && key !== `user:${id}`) || (!id && !key.startsWith('unknown:'))) throw new Error('Archive storage account does not match the file.');
      return this.transaction('readwrite', (store, done, fail) => {
        store.get(key).onsuccess = e => {
          const prev = e.target.result;
          if ((prev?.revision || 0) !== revision) return fail(new Error('This archive changed in another tab. Reopen it before updating.'));
          const record = { key, data, previous: prev?.data || null, revision: revision + 1 };
          store.put(record);
          store.put({ key: 'active', value: key });
          done(record);
        };
      });
    }
    async undo(key, revision) {
      return this.transaction('readwrite', (store, done, fail) => {
        store.get(key).onsuccess = e => {
          const prev = e.target.result;
          if (prev?.revision !== revision || !prev.previous) return fail(new Error('Undo is unavailable or the archive changed in another tab. Reopen it first.'));
          const record = { key, data: prev.previous, previous: null, revision: revision + 1 };
          store.put(record);
          store.put({ key: 'active', value: key });
          done(record);
        };
      });
    }
  }
  root.XArchive = { validate, normalize, merge, mergeFields, accountId, coverage, isComplete, describeCoverage, summaryText, ArchiveStore };
})(globalThis);
