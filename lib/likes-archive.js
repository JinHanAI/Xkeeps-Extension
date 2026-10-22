/** Separate Likes format and IndexedDB; legacy bookmark archives are untouched. */
import './archive.js';
import { updateSummary } from './update-status.js';

const copy = value => JSON.parse(JSON.stringify(value));
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function validateLikes(data) {
  if (!object(data) || data.format !== 'xkeeps-likes' || data.schema_version !== 1
    || data.source !== 'likes' || !Array.isArray(data.likes)
    || !object(data.account) || !/^\d+$/.test(data.account.user_id || '')) throw new Error('请选择Xkeeps 点赞 JSON 文件。');
  if (data.account.screen_name != null && typeof data.account.screen_name !== 'string') throw new Error('点赞文件的账号名称无效。');
  if (!object(data.collection) || !['full', 'quick', 'sample', 'import'].includes(data.collection.mode)
    || !['complete', 'partial', 'unknown'].includes(data.collection.coverage)
    || typeof data.collection.reason !== 'string') throw new Error('点赞文件的采集状态无效。');
  if (!iso(data.exported_at)) throw new Error('点赞文件的导出时间无效。');
  if (data.last_full_refresh_at != null && !iso(data.last_full_refresh_at)) throw new Error('点赞文件的最近全量时间无效。');
  if (data.kind != null && !['snapshot', 'cumulative'].includes(data.kind)) throw new Error('点赞文件的范围无效。');
  if (data.likes.length > 200000) throw new Error('点赞文件超出当前支持范围。');
  const seen = new Set();
  for (const tweet of data.likes) {
    if (!object(tweet) || !/^\d+$/.test(tweet.tweet_id || '') || seen.has(tweet.tweet_id)) throw new Error('点赞文件存在无效或重复的帖子 ID。');
    seen.add(tweet.tweet_id);
    for (const key of ['first_seen_at', 'last_seen_at', 'liked_at']) if (tweet[key] != null && !iso(tweet[key])) throw new Error(`点赞文件的 ${key} 无效。`);
  }
  // Reuse the strict content validator without changing the legacy format.
  XArchive.validate({ bookmarks: data.likes });
  return data;
}

export function likesDocument({ userId, screenName = null, mode = 'sample', reason = 'in_progress',
  coverage = 'partial', likes = [], kind = 'snapshot', exportedAt = new Date().toISOString() }) {
  return validateLikes({ format: 'xkeeps-likes', schema_version: 1, source: 'likes', kind,
    account: { user_id: userId, screen_name: screenName },
    collection: { mode, coverage, reason }, exported_at: exportedAt, likes });
}

export function mergeLikes(base, incoming) {
  validateLikes(incoming);
  if (base) { validateLikes(base); if (base.account.user_id !== incoming.account.user_id) throw new Error('点赞存档与当前账号不一致。'); }
  const byId = new Map((base?.likes || []).map(tweet => [tweet.tweet_id, copy(tweet)]));
  const before = new Set(byId.keys());
  const incomingIds = new Set(incoming.likes.map(tweet => tweet.tweet_id));
  let added = 0, updated = 0;
  for (const tweet of incoming.likes) {
    const old = byId.get(tweet.tweet_id);
    if (!old) { byId.set(tweet.tweet_id, copy(tweet)); added++; continue; }
    const incomingNewer = !old.last_seen_at || (tweet.last_seen_at && tweet.last_seen_at >= old.last_seen_at);
    const merged = incomingNewer ? XArchive.mergeFields(old, tweet) : XArchive.mergeFields(tweet, old);
    merged.first_seen_at = [old.first_seen_at, tweet.first_seen_at].filter(Boolean).sort()[0] || null;
    merged.last_seen_at = [old.last_seen_at, tweet.last_seen_at].filter(Boolean).sort().at(-1) || null;
    // A sparse/tombstone response must not erase useful prior content.
    if (tweet.status !== 'available' && old.status === 'available') {
      for (const key of ['status', 'full_text', 'author', 'media', 'entities', 'quoted_tweet', 'card']) if (old[key] != null) merged[key] = copy(old[key]);
    }
    if (JSON.stringify(old) !== JSON.stringify(merged)) updated++;
    byId.set(tweet.tweet_id, merged);
  }
  const newest = base?.exported_at && base.exported_at > incoming.exported_at ? base : incoming;
  const data = likesDocument({ userId: incoming.account.user_id,
    screenName: newest.account.screen_name || base?.account.screen_name || incoming.account.screen_name,
    mode: newest.collection.mode, reason: newest.collection.reason,
    coverage: newest.collection.coverage, kind: 'cumulative',
    likes: [...byId.values()].sort((a, b) => a.tweet_id.localeCompare(b.tweet_id)),
    exportedAt: newest.exported_at });
  data.last_full_refresh_at = [base?.last_full_refresh_at, incoming.last_full_refresh_at,
    incoming.collection.mode === 'full' && incoming.collection.coverage === 'complete' ? incoming.exported_at : null]
    .filter(Boolean).sort().at(-1) || null;
  return { data, summary: { added, updated, unchanged: incoming.likes.length - added - updated,
    retained: [...before].filter(id => !incomingIds.has(id)).length } };
}

export class LikesStore {
  constructor(name = 'xkeeps-likes-library') { this.name = name; }
  async open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('accounts', { keyPath: 'user_id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async list() {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const rows = [];
        const tx = db.transaction('accounts', 'readonly');
        tx.oncomplete = () => resolve(rows);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('无法读取点赞存档。'));
        tx.objectStore('accounts').openCursor().onsuccess = event => {
          const cursor = event.target.result;
          if (!cursor) return;
          const record = cursor.value;
          rows.push({ userId: record.user_id, screenName: record.current?.account?.screen_name || record.snapshot?.account?.screen_name || null,
            count: record.current?.likes?.length || 0 });
          cursor.continue();
        };
      });
    } finally { db.close(); }
  }
  async remove(userId) {
    if (!/^\d+$/.test(userId || '')) throw new Error('缺少已确认的账号。');
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('accounts', 'readwrite');
        tx.oncomplete = () => resolve(userId);
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('删除点赞存档失败。'));
        tx.objectStore('accounts').delete(userId);
      });
    } finally { db.close(); }
  }
  async transact(userId, action) {
    if (!/^\d+$/.test(userId || '')) throw new Error('缺少已确认的账号。');
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('accounts', 'readwrite');
        const store = tx.objectStore('accounts');
        let output;
        tx.oncomplete = () => resolve(output);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('点赞存档保存失败，原有数据保持不变。'));
        store.get(userId).onsuccess = event => {
          try {
            const record = event.target.result || { user_id: userId, revision: 0, current: null, previous: null, snapshot: null, can_undo: false };
            const result = action(record);
            output = result.output;
            if (result.save) store.put(result.record || record);
          } catch (error) { tx.abort(); reject(error); }
        };
      });
    } finally { db.close(); }
  }
  get(userId) { return this.transact(userId, record => ({ output: record })); }
  start(userId, account, mode) {
    return this.transact(userId, record => {
      if (record.snapshot?.likes?.length && !record.snapshot.merged_at) throw new Error('请先导出或合并未完成的点赞快照。');
      record.snapshot = likesDocument({ userId, screenName: account, mode });
      record.snapshot.started_at = record.snapshot.exported_at;
      record.snapshot.before_count = record.current?.likes.length || 0;
      record.snapshot.before_at = record.current?.exported_at || null;
      return { save: true, output: record.snapshot };
    });
  }
  append(userId, tweets, observedAt) {
    return this.transact(userId, record => {
      if (!record.snapshot) throw new Error('没有可继续的点赞快照。');
      const normalized = tweets.map(tweet => ({ ...tweet, liked_at: null, first_seen_at: observedAt, last_seen_at: observedAt }));
      const page = likesDocument({ userId, screenName: record.snapshot.account.screen_name,
        mode: record.snapshot.collection.mode, likes: normalized, exportedAt: observedAt });
      record.snapshot = { ...record.snapshot, ...mergeLikes(record.snapshot, page).data, kind: 'snapshot', collection: record.snapshot.collection };
      return { save: true, output: record.snapshot };
    });
  }
  finish(userId, reason, complete) {
    return this.transact(userId, record => {
      if (!record.snapshot) throw new Error('没有可完成的点赞快照。');
      if (record.snapshot.merged_at) return { output: { record, summary: null } };
      record.snapshot.collection = { ...record.snapshot.collection, reason, coverage: complete ? 'complete' : 'partial' };
      record.snapshot.exported_at = new Date().toISOString();
      const beforeCount = record.snapshot.before_count ?? record.current?.likes.length ?? 0;
      const beforeAt = record.snapshot.before_at ?? record.current?.exported_at;
      if (record.snapshot.likes.length || complete) {
        const merged = mergeLikes(record.current, record.snapshot);
        record.previous = record.current;
        record.can_undo = true;
        record.current = merged.data;
        record.revision++;
        record.snapshot.merged_at = record.snapshot.exported_at;
        record.snapshot.update_summary = updateSummary(beforeCount, beforeAt, record.current.likes.length,
          record.snapshot.exported_at, merged.summary);
        return { save: true, output: { record, summary: merged.summary } };
      }
      record.snapshot.update_summary = updateSummary(beforeCount, beforeAt, record.current?.likes.length || 0, record.snapshot.exported_at);
      return { save: true, output: { record, summary: null } };
    });
  }
  import(userId, document, expectedRevision) {
    validateLikes(document);
    return this.transact(userId, record => {
      if (document.account.user_id !== userId) throw new Error('点赞文件属于其他账号。');
      if (record.revision !== expectedRevision) throw new Error('存档已在其他页面更新，请重新打开。');
      const merged = mergeLikes(record.current, document);
      if (record.current && JSON.stringify(record.current) === JSON.stringify(merged.data)) return { output: { record, summary: merged.summary, changed: false } };
      record.previous = record.current;
      record.can_undo = true;
      record.current = merged.data;
      record.revision++;
      return { save: true, output: { record, summary: merged.summary, changed: true } };
    });
  }
  undo(userId, expectedRevision) {
    return this.transact(userId, record => {
      if (record.revision !== expectedRevision || !record.can_undo) throw new Error('无法撤销：存档已更新或没有上一版。');
      record.current = record.previous;
      record.previous = null;
      record.can_undo = false;
      record.revision++;
      return { save: true, output: record };
    });
  }
}
