import { SCHEDULE_KEY, configureSource, ensureAlarms, runScheduledSource } from '../lib/scheduled-sync.js';
import { LikesStore, likesDocument } from '../lib/likes-archive.js';
const userId = '815010';
const store = new XArchive.ArchiveStore();
const likes = new LikesStore();
const originalFetch = window.fetch;
let requests = 0, failures = 0, tests = 0;
let responseMode = 'normal';
const alarms = new Map();
chrome.alarms.create = async (name, options) => alarms.set(name, options);
chrome.alarms.clear = async name => alarms.delete(name);
window.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.hostname === 'x.com') {
    requests++;
    if (responseMode === '429') return new Response('{}', { status: 429 });
    if (responseMode === 'network') throw new TypeError('synthetic offline');
  }
  return originalFetch(input, options);
};
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const state = async () => (await chrome.storage.local.get(SCHEDULE_KEY))[SCHEDULE_KEY];
const due = async source => {
  const all = await state();
  all[source].nextAt = Date.now() - 1;
  await chrome.storage.local.set({ [SCHEDULE_KEY]: all });
};
const test = async (label, fn) => {
  tests++;
  const li = document.createElement('li');
  try { await fn(); li.textContent = 'PASS：' + label; }
  catch (error) { failures++; li.textContent = 'FAIL：' + label + ' — ' + error.message; }
  document.getElementById('results').append(li);
};
try {
  await store.remove(`user:${userId}`); await likes.remove(userId);
  const base = await (await fetch('fixtures/base.json')).json();
  base.export_metadata.user_id = userId;
  await store.save(`user:${userId}`, XArchive.merge(null, base).data);
  await likes.import(userId, likesDocument({ userId, screenName: 'schedule_demo', mode: 'import', likes: [{tweet_id:'200',full_text:'历史点赞',status:'available'}] }), 0);
  await test('收藏/点赞独立保存；未到期不请求', async () => {
    await configureSource('bookmarks', { enabled: true, interval:'daily', maxPages:1, userId });
    await configureSource('likes', { enabled: true, interval:'weekly', maxPages:1, userId });
    await runScheduledSource('bookmarks'); await runScheduledSource('likes');
    assert(requests === 0 && alarms.size === 2, '计划或请求数不符');
  });
  await test('收藏到期：真实解析合并并重新读取，2 → 4 条，历史保留', async () => {
    await due('bookmarks'); await runScheduledSource('bookmarks');
    const saved = await new XArchive.ArchiveStore().get(`user:${userId}`);
    assert(saved.data.bookmarks.length === 4 && saved.data.bookmarks.some(p=>p.tweet_id==='100'), '收藏未完整合并');
    assert((await state()).bookmarks.lastResult.pages === 1 && requests === 1, '非单页执行');
  });
  await test('点赞到期：真实解析合并并重新读取，1 → 3 条，收藏不变', async () => {
    await due('likes'); await runScheduledSource('likes');
    const saved = await new LikesStore().get(userId);
    assert(saved.current.likes.length === 3 && saved.current.likes.some(p=>p.tweet_id==='200'), '点赞未完整合并');
    assert((await store.get(`user:${userId}`)).data.bookmarks.length === 4 && requests === 2, '来源隔离异常');
  });
  await test('重复触发不重复请求；关闭收藏不关闭点赞', async () => {
    await runScheduledSource('likes'); assert(requests===2, '重复请求');
    await configureSource('bookmarks', {enabled:false,interval:'daily',maxPages:1,userId});
    assert(!alarms.has('xkeeps-sync-bookmarks') && alarms.has('xkeeps-sync-likes'), '来源关闭联动');
  });
  await test('429 限流不重试；存档不变，冷却至少一小时', async () => {
    responseMode='429'; await due('likes');
    const before=JSON.stringify(await likes.get(userId));
    await runScheduledSource('likes'); await runScheduledSource('likes');
    const config=(await state()).likes;
    assert(requests===3 && config.lastResult.reason==='rate_limited' && config.nextAt >= Date.now()+59*60_000, '限流处理异常');
    assert(JSON.stringify(await likes.get(userId))===before, '失败改写存档');
  });
  await test('网络中断不重试且给出失败记录', async () => {
    responseMode='network';await due('likes');await runScheduledSource('likes');await runScheduledSource('likes');
    assert(requests===4 && (await state()).likes.lastResult.reason==='network_error', '网络失败处理异常');
  });
  await test('Chrome 重启恢复计划；中断页不重发', async () => {
    alarms.clear();const all=await state();
    all.likes.run={phase:'requesting',pages:0,account:userId};
    await chrome.storage.local.set({[SCHEDULE_KEY]:all});
    await ensureAlarms({startup:true}); await runScheduledSource('likes');
    assert(alarms.size===1 && requests===4 && (await state()).likes.lastResult.reason==='worker_interrupted','重启恢复异常');
  });
} catch (error) { failures++; document.getElementById('results').append('SETUP FAIL: '+error.message); }
finally {
  await store.remove(`user:${userId}`); await likes.remove(userId);
  document.getElementById('status').textContent=`${tests-failures}/${tests} 项通过；真实 Chrome 定时触发与真实 X 响应未验证。`;
}
