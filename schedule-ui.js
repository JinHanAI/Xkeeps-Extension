import { getSessionUserId } from './lib/identity.js';
import { configureSource, SCHEDULE_KEY, SOURCES } from './lib/scheduled-sync.js';
import { recordEvent, errorClass } from './lib/analytics.js';

const $ = id => document.getElementById(id);
const reasons = {
  account_unavailable_or_changed: '登录账号缺失或已切换', no_cumulative_archive: '尚无累计存档',
  unfinished_snapshot: '有未完成快照', login_or_query_unavailable: '登录或查询接口未就绪',
  manual_or_other_task: '与手动采集或其他任务冲突', worker_interrupted: '后台进程中断，未重发该页',
  request_state_unresolved: '上次请求状态不明，未重发', rate_limited: 'X 限流，已冷却',
  network_error: '网络异常', auth_error: '登录失效', account_changed: '账号切换',
  page_limit: '达到本次页数上限，仅查部分', quick_boundary: '已遇到已保存内容，仅查部分',
  timeline_end: '已到末页', pagination_guard: '分页异常，仅查部分', unrecognized_response: '接口格式未识别',
  storage_error: '本地存档保存失败，未重发该页',
};
const englishReasons = {
  account_unavailable_or_changed: 'account unavailable or changed', no_cumulative_archive: 'no cumulative archive',
  unfinished_snapshot: 'unfinished snapshot', login_or_query_unavailable: 'login or query endpoint unavailable',
  manual_or_other_task: 'manual or other task in progress', worker_interrupted: 'worker interrupted; page not replayed',
  request_state_unresolved: 'previous request unresolved; not replayed', rate_limited: 'rate limited; cooling down',
  network_error: 'network error', auth_error: 'login expired', account_changed: 'account changed',
  page_limit: 'page limit reached; partial coverage', quick_boundary: 'saved-page boundary; partial coverage',
  timeline_end: 'timeline ended', pagination_guard: 'pagination guard; partial coverage', unrecognized_response: 'unrecognized response',
  storage_error: 'local archive save failed; page not replayed',
};

async function describe(config) {
  const en = XKeepsI18n.language === 'en';
  if (!config?.enabled) return en ? 'Off; no automatic X requests.' : '已关闭，不会自动更新。';
  const profileKey = `xarchive_profile_${config.userId}`;
  const profile = (await chrome.storage.local.get(profileKey))[profileKey];
  const account = typeof profile === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(profile) ? `@${profile}` : (en ? 'Name unavailable' : '昵称未知');
  const next = config.run?.phase === 'waiting' ? config.run.resumeAfter : config.nextAt;
  const result = config.lastResult;
  if (en) return `Account ${account}; next check about ${new Date(next).toLocaleString()}.`
    + (result ? ` Last: ${result.status}, ${englishReasons[result.reason] || result.reason}; ${result.pages} page(s) at ${new Date(result.at).toLocaleString()}.` : ' No automatic checks yet.');
  const status = { success: '更新成功', partial: '部分保存', skipped: '此次跳过', failed: '更新失败' };
  return `绑定账号：${account}\n下次更新：${new Date(next).toLocaleString('zh-CN')}\n`
    + (result ? `最近状态：${status[result.status] || result.status}\n最近运行：${new Date(result.at).toLocaleString('zh-CN')}\n${reasons[result.reason] || result.reason} · 已查 ${result.pages} 页` : '尚未运行。');
}

async function refresh() {
  const state = (await chrome.storage.local.get(SCHEDULE_KEY))[SCHEDULE_KEY] || {};
  for (const source of SOURCES) {
    const config = state[source];
    $(`schedule-${source}-enabled`).checked = !!config?.enabled;
    $(`schedule-${source}-interval`).value = config?.interval || 'daily';
    $(`schedule-${source}-pages`).value = '1';
    $(`schedule-${source}-status`).textContent = await describe(config);
  }
}

async function refreshStatuses() {
  const state = (await chrome.storage.local.get(SCHEDULE_KEY))[SCHEDULE_KEY] || {};
  for (const source of SOURCES) $(`schedule-${source}-status`).textContent = await describe(state[source]);
}

for (const source of SOURCES) {
  $(`schedule-${source}-save`).addEventListener('click', async () => {
    const button = $(`schedule-${source}-save`);
    const status = $(`schedule-${source}-status`);
    const enabled = $(`schedule-${source}-enabled`).checked;
    let configured = null;
    // Optional alarms permission is requested only after this explicit click.
    const permissionPromise = enabled ? chrome.permissions.request({ permissions: ['alarms'] }) : Promise.resolve(true);
    button.disabled = true;
    try {
      if (!await permissionPromise) throw new Error('未授予定时任务权限；计划仍保持关闭。');
      const current = await getSessionUserId();
      const previous = ((await chrome.storage.local.get(SCHEDULE_KEY))[SCHEDULE_KEY] || {})[source];
      const userId = current || (!enabled && previous?.userId);
      if (!userId) throw new Error('请先登录 X，以绑定要定时检查的账号。');
      if (enabled && current !== userId) throw new Error('当前 X 账号无法确认。');
      const config = await configureSource(source, {
        enabled, interval: $(`schedule-${source}-interval`).value,
        maxPages: Number($(`schedule-${source}-pages`).value), userId,
      });
      configured = config;
      const reply = await chrome.runtime.sendMessage({ type: 'xkeeps:schedule-changed' });
      if (!reply?.ok) {
        throw new Error(reply?.error || '后台计划未能确认；已恢复为关闭状态。');
      }
      status.textContent = await describe(config);
      recordEvent('schedule_configured', { source, enabled: config.enabled,
        interval_days: { daily: 1, weekly: 7, '30d': 30, '90d': 90, '180d': 180 }[config.interval], result: 'success' });
    } catch (error) {
      if (configured?.enabled) {
        try { await configureSource(source, { ...configured, enabled: false }); }
        catch { /* The persisted disabled state still prevents future X reads. */ }
      }
      await refresh().catch(() => {});
      status.textContent = `保存失败：${error.message}`;
      recordEvent('schedule_configured', { source, enabled, result: 'error', error_class: errorClass(error) });
    }
    finally { button.disabled = false; }
  });
}

refresh().catch(error => { $('schedule-bookmarks-status').textContent = `读取计划失败：${error.message}`; });
window.addEventListener('xkeeps:language-changed', () => refreshStatuses().catch(() => {}));
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes[SCHEDULE_KEY]) refreshStatuses().catch(() => {});
});
