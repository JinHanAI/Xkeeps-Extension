const PERIOD_DAYS = { week: 7, month: 30, half: 183, year: 365 };

export function postTimeCoverage(document, now = Date.now()) {
  const posts = document.likes || document.bookmarks || [];
  const times = posts.map(post => Date.parse(post.created_at || '')).filter(Number.isFinite);
  const counts = {};
  for (const period of Object.keys(PERIOD_DAYS)) {
    const range = dateWindow(period, { now });
    counts[period] = times.filter(time => time >= range.start && time <= range.end).length;
  }
  return { total: posts.length, oldest: times.length ? new Date(times.reduce((a, b) => Math.min(a, b), Infinity)).toISOString() : null,
    newest: times.length ? new Date(times.reduce((a, b) => Math.max(a, b), -Infinity)).toISOString() : null, counts };
}

export function dateWindow(period, { now = Date.now(), from = '', to = '' } = {}) {
  if (period === 'all') return null;
  if (period === 'custom') {
    const start = from ? Date.parse(`${from}T00:00:00`) : -Infinity;
    const end = to ? Date.parse(`${to}T23:59:59.999`) : Infinity;
    if (!Number.isFinite(start) && start !== -Infinity || !Number.isFinite(end) && end !== Infinity || start > end) throw new Error('请选择有效的开始和结束日期。');
    return { start, end };
  }
  if (!Object.hasOwn(PERIOD_DAYS, period)) throw new Error('不支持的时间范围。');
  return { start: now - PERIOD_DAYS[period] * 86400000, end: now };
}

export function filterPosts(document, period, options = {}) {
  const range = dateWindow(period, options);
  if (!range) return structuredClone(document);
  const result = structuredClone(document);
  const key = Array.isArray(result.likes) ? 'likes' : 'bookmarks';
  if (!Array.isArray(result[key])) throw new Error('存档缺少帖子列表。');
  result[key] = result[key].filter(item => {
    const time = Date.parse(item.created_at || '');
    return Number.isFinite(time) && time >= range.start && time <= range.end;
  });
  // A time slice is never evidence that the entire X timeline was inspected.
  if (key === 'likes') {
    result.collection = { ...result.collection, coverage: 'partial', reason: 'time_filtered' };
    result.last_full_refresh_at = null;
  } else {
    result.export_metadata = { ...result.export_metadata,
      collection: { ...result.export_metadata?.collection, bookmarks: 'partial', folders: 'unknown',
        folder_list: 'unknown', folder_contents: {}, reason: 'time_filtered' } };
    if (result.archive_metadata) result.archive_metadata.last_full_refresh_at = null;
  }
  result.time_filter = { field: 'created_at', period, from: options.from || null, to: options.to || null,
    note: '按原帖发布时间筛选；时间未知的帖子不包含在本次导出中。' };
  return result;
}

export function selectedTimeOptions(root) {
  const period = root?.querySelector('.xk-time-buttons .selected')?.dataset.period || 'all';
  return { period, from: root?.querySelector('input[data-edge="from"]')?.value || '',
    to: root?.querySelector('input[data-edge="to"]')?.value || '' };
}

// Show observed precision only. Date-only legacy records have no known hour.
export function formatPostTimestamp(value, language = 'zh-CN') {
  const en = language.startsWith('en');
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return en ? 'Time not recorded' : '时间未记录';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value + (en ? ' (time not recorded)' : '（具体时间未记录）');
  return new Intl.DateTimeFormat(en ? 'en-GB' : 'zh-CN', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value)) + ' (UTC+8)';
}
