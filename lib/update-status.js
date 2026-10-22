const WEEK = 7 * 86400000;
const timestamp = value => Number.isFinite(Date.parse(value || '')) ? Date.parse(value) : null;

export function recommendUpdate({ count = 0, lastFullAt, now = Date.now() }) {
  const full = timestamp(lastFullAt);
  if (!count) return { mode: 'full', reason: 'empty' };
  if (full == null) return { mode: 'full', reason: 'unverified' };
  if (now - full > WEEK) return { mode: 'full', reason: 'overdue' };
  return { mode: 'quick', reason: 'recent' };
}

export function updateRecommendationText(input, english = false) {
  const recommendation = recommendUpdate(input);
  const reasons = english ? {
    empty: 'No saved records. Start with a full update.',
    unverified: 'No completed full update is recorded. A full update is recommended.',
    overdue: 'The last full update was over 7 days ago. A full update is recommended.',
    recent: 'A full update completed within 7 days. An recent update is recommended.',
  } : {
    empty: '首次使用，建议全部更新。',
    unverified: '尚未完整检查，建议全部更新。',
    overdue: '超过7天未完整检查，建议全部更新。',
    recent: '7天内已完整检查，建议近期更新。',
  };
  const latest = timestamp(input.lastUpdatedAt);
  return `${latest == null ? '' : `${english ? 'Last update: ' : '最近更新：'}${formatUpdateTime(input.lastUpdatedAt, english)}\n`}${reasons[recommendation.reason]}`;
}

export function formatUpdateTime(value, english = false) {
  return timestamp(value) == null ? (english ? 'Not recorded' : '未记录') : new Date(value).toLocaleString(english ? 'en-GB' : 'zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// Persist the transition at merge time: a later refresh/import must not rewrite it.
export function updateSummary(beforeCount, beforeAt, afterCount, finishedAt, summary = {}) {
  return { before_count: beforeCount, after_count: afterCount, before_at: beforeAt || null,
    finished_at: finishedAt, added: summary.added || 0, updated: summary.updated || 0,
    unchanged: summary.unchanged || 0, retained: summary.retained || 0 };
}
