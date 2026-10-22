// Translate product labels only; never translate archive content or schema keys.
const EXPORT_EN = {
  "推文ID": "Post ID",
  "作者昵称": "Author name",
  "用户名": "Handle",
  "作者ID": "Author ID",
  "头像URL": "Avatar URL",
  "正文": "Post text",
  "原文链接": "Post URL",
  "发布时间": "Published at",
  "首次采集时间": "First seen at",
  "最后见到时间": "Last seen at",
  "状态": "Status",
  "文件夹": "Folders",
  "媒体URL列表": "Media URLs",
  "引用推文ID": "Quoted post ID",
  "引用正文": "Quoted text",
  "点赞数": "Likes",
  "转发数": "Reposts",
  "回复数": "Replies",
  "浏览数": "Views",
  "导出范围": "Export range",
  "采集覆盖": "Collection coverage",
  "导出时间": "Exported at",
  "全量刷新": "Full refresh",
  "增量更新": "Incremental update",
  "完整": "Complete",
  "部分": "Partial",
  "未知": "Unknown",
  "分页保护触发": "Pagination guard",
  "可用": "Available",
  "暂不可用": "Unavailable",
  "累计存档": "Cumulative archive",
  "本次采集快照": "Latest collection snapshot",
  "需要包含书签列表的存档。": "An archive containing bookmarks is required.",
  "# X 书签导出": "# X bookmarks export",
  "账号": "Account",
  "条目数": "Items",
  "- 图片和视频：仅保留远程媒体链接，不包含媒体文件": "- Images and videos: remote links only; media files are not included",
  "未知作者": "Unknown author",
  "首次采集": "First seen",
  "最后见到": "Last seen",
  "原文": "Original post",
  "点赞": "Likes",
  "转发": "Reposts",
  "回复": "Replies",
  "浏览": "Views",
  "收藏": "Bookmarks",
  "引用": "Quotes",
  "互动数据": "Engagement",
  "### 正文": "### Post text",
  "### 引用内容": "### Quoted post",
  "作者": "Author",
  "引用内容不可用": "Quoted content unavailable",
  "### 媒体链接": "### Media links",
  "媒体": "Media",
  "不支持的导出格式。": "Unsupported export format.",
  "需要Xkeeps 点赞存档。": "An Xkeeps likes archive is required.",
  "来源": "Source",
  "点赞时间": "Liked at",
  "# X 点赞导出": "# X likes export",
  "- 来源：点赞": "- Source: Likes",
  "部分或未知": "Partial or unknown",
  "结束原因": "Stop reason",
  "- 点赞时间：X 未明确返回时记为未知；发布时间不能代替点赞时间": "- Liked at: unknown unless X explicitly returns it; the post publication time is not the like time"
};
const currentLocale = () => globalThis.document?.documentElement?.lang || 'zh-CN';
const isEnglish = locale => !String(locale).toLowerCase().startsWith('zh');
const tr = (value, locale = currentLocale()) => isEnglish(locale) ? (EXPORT_EN[value] || value) : value;
const fieldLabel = (value, locale) => `- ${tr(value, locale)}${isEnglish(locale) ? ': ' : '：'}`;

const COLUMNS = [
  ['tweet_id', '推文ID'], ['author_name', '作者昵称'], ['screen_name', '用户名'],
  ['author_id', '作者ID'], ['avatar_url', '头像URL'], ['full_text', '正文'],
  ['post_url', '原文链接'], ['published_at', '发布时间'], ['first_seen_at', '首次采集时间'],
  ['last_seen_at', '最后见到时间'], ['status', '状态'], ['folders', '文件夹'],
  ['media_urls', '媒体URL列表'], ['quoted_tweet_id', '引用推文ID'],
  ['quoted_text', '引用正文'], ['likes', '点赞数'], ['retweets', '转发数'],
  ['replies', '回复数'], ['views', '浏览数'], ['export_range', '导出范围'],
  ['coverage', '采集覆盖'], ['exported_at', '导出时间'],
];

const text = value => value == null ? '' : String(value);
const COVERAGE_LABELS = { full: '全量刷新', quick: '增量更新', complete: '完整', partial: '部分', unknown: '未知', pagination_guard: '分页保护触发' };
const STATUS_LABELS = { available: '可用', unavailable: '暂不可用' };
const localize = (value, locale) => tr(COVERAGE_LABELS[text(value)] || STATUS_LABELS[text(value)] || text(value), locale);
const safeWebUrl = value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
};

function postUrl(bookmark) {
  const id = text(bookmark.tweet_id || bookmark.id_str);
  const handle = text(bookmark.author?.screen_name || bookmark.author?.username).replace(/^@/, '');
  return id ? `https://x.com/${handle ? `${encodeURIComponent(handle)}/` : 'i/web/'}status/${encodeURIComponent(id)}` : '';
}

function mediaUrls(bookmark) {
  const values = [];
  for (const media of bookmark.media || []) {
    for (const candidate of [media.url, media.thumbnail_url, ...(media.variants || []).map(variant => variant.url)]) {
      const url = safeWebUrl(candidate);
      if (url && !values.includes(url)) values.push(url);
    }
  }
  return values;
}

function rowFor(bookmark, archive, exportedAt, locale) {
  const metadata = archive.export_metadata || {};
  const collection = metadata.collection || {};
  const quote = bookmark.quoted_tweet || {};
  return {
    tweet_id: text(bookmark.tweet_id),
    author_name: text(bookmark.author?.name || bookmark.author?.display_name),
    screen_name: text(bookmark.author?.screen_name || bookmark.author?.username),
    author_id: text(bookmark.author?.user_id || bookmark.author?.id_str),
    avatar_url: safeWebUrl(bookmark.author?.profile_image_url || bookmark.author?.profile_image_url_https || bookmark.author?.avatar_url),
    full_text: text(bookmark.full_text || bookmark.text),
    post_url: postUrl(bookmark),
    published_at: text(bookmark.created_at),
    first_seen_at: text(bookmark._archive?.first_seen_at || bookmark.first_seen_at),
    last_seen_at: text(bookmark._archive?.last_seen_at || bookmark.last_seen_at || (metadata.kind === 'cumulative' ? null : metadata.exported_at)),
    status: localize(bookmark.status, locale),
    folders: JSON.stringify(bookmark.folders || []),
    media_urls: JSON.stringify(mediaUrls(bookmark)),
    quoted_tweet_id: text(quote.tweet_id),
    quoted_text: text(quote.full_text),
    likes: bookmark.metrics?.likes ?? '',
    retweets: bookmark.metrics?.retweets ?? '',
    replies: bookmark.metrics?.replies ?? '',
    views: bookmark.metrics?.views ?? '',
    export_range: metadata.kind === 'cumulative' ? tr('累计存档', locale) : tr('本次采集快照', locale),
    coverage: [collection.mode, collection.bookmarks, collection.folders, collection.reason].filter(Boolean).map(value => localize(value, locale)).join('/'),
    exported_at: exportedAt,
  };
}

// Spreadsheet applications can evaluate text beginning with these characters.
// Prefixing an apostrophe keeps the displayed value literal; JSON remains canonical.
function spreadsheetCell(value, key) {
  let result = text(value);
  if (key === 'tweet_id' && result) result = `'${result}`; // prevent long numeric IDs becoming scientific notation
  else if (/^[\u0000-\u0020\uFEFF]*[=+@\-]/u.test(result)) result = `'${result}`;
  return `"${result.replaceAll('"', '""')}"`;
}

export function buildCsv(archive, { exportedAt = new Date().toISOString(), locale = currentLocale() } = {}) {
  if (!archive || !Array.isArray(archive.bookmarks)) throw new TypeError(tr('需要包含书签列表的存档。', locale));
  const header = COLUMNS.map(([, label]) => spreadsheetCell(tr(label, locale))).join(',');
  const rows = archive.bookmarks.map(bookmark => {
    const row = rowFor(bookmark, archive, exportedAt, locale);
    return COLUMNS.map(([key]) => spreadsheetCell(row[key], key)).join(',');
  });
  return `\uFEFF${[header, ...rows].join('\r\n')}\r\n`;
}

function inlineCode(value) {
  const source = text(value).replaceAll('\n', ' ').replaceAll('\r', ' ');
  const fence = '`'.repeat(Math.max(1, ...[...source.matchAll(/`+/g)].map(match => match[0].length + 1)));
  const pad = source.startsWith('`') || source.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${source}${pad}${fence}`;
}

function textFence(value) {
  const source = text(value);
  const longest = Math.max(0, ...[...source.matchAll(/`+/g)].map(match => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${source}\n${fence}`;
}

export function buildMarkdown(archive, { exportedAt = new Date().toISOString(), locale = currentLocale() } = {}) {
  if (!archive || !Array.isArray(archive.bookmarks)) throw new TypeError(tr('需要包含书签列表的存档。', locale));
  const metadata = archive.export_metadata || {};
  const collection = metadata.collection || {};
  const coverage = [collection.mode, collection.bookmarks, collection.folders, collection.reason].filter(Boolean).map(value => localize(value, locale)).join(' / ') || tr('未知', locale);
  const range = metadata.kind === 'cumulative' ? tr('累计存档', locale) : tr('本次采集快照', locale);
  const lines = [
    tr('# X 书签导出', locale), '',
    `${fieldLabel('账号', locale)}${inlineCode(metadata.screen_name ? `@${metadata.screen_name}` : metadata.user_id || tr('未知', locale))}`,
    `${fieldLabel('条目数', locale)}${archive.bookmarks.length}`,
    `${fieldLabel('导出范围', locale)}${range}`,
    `${fieldLabel('采集覆盖', locale)}${coverage}`,
    `${fieldLabel('导出时间', locale)}${inlineCode(exportedAt)}`,
    tr('- 图片和视频：仅保留远程媒体链接，不包含媒体文件', locale),
    '',
  ];
  archive.bookmarks.forEach((bookmark, index) => {
    const row = rowFor(bookmark, archive, exportedAt, locale);
    lines.push(`## ${index + 1}. ${inlineCode(row.author_name || row.screen_name || tr('未知作者', locale))}`);
    lines.push('', `${fieldLabel('用户名', locale)}${inlineCode(row.screen_name ? `@${row.screen_name}` : tr('未知', locale))}`);
    if (row.author_id) lines.push(`${fieldLabel('作者ID', locale)}${inlineCode(row.author_id)}`);
    if (row.avatar_url) lines.push(`${fieldLabel('头像URL', locale)}<${row.avatar_url}>`);
    lines.push(`${fieldLabel('发布时间', locale)}${inlineCode(row.published_at || tr('未知', locale))}`);
    if (row.first_seen_at) lines.push(`${fieldLabel('首次采集', locale)}${inlineCode(row.first_seen_at)}`);
    if (row.last_seen_at) lines.push(`${fieldLabel('最后见到', locale)}${inlineCode(row.last_seen_at)}`);
    lines.push(`${fieldLabel('推文ID', locale)}${inlineCode(row.tweet_id)}`);
    if (row.post_url) lines.push(`${fieldLabel('原文', locale)}<${row.post_url}>`);
    lines.push(`${fieldLabel('状态', locale)}${inlineCode(row.status || tr('未知', locale))}`);
    if (bookmark.folders?.length) lines.push(`${fieldLabel('文件夹', locale)}${bookmark.folders.map(inlineCode).join(isEnglish(locale) ? ', ' : '、')}`);
    if (bookmark.metrics && Object.keys(bookmark.metrics).length) {
      const metricNames = { likes: tr('点赞', locale), retweets: tr('转发', locale), replies: tr('回复', locale), views: tr('浏览', locale), bookmarks: tr('收藏', locale), quote_count: tr('引用', locale) };
      const metrics = Object.entries(bookmark.metrics).filter(([, value]) => value != null).map(([key, value]) => `${metricNames[key] || key} ${value}`);
      if (metrics.length) lines.push(`${fieldLabel('互动数据', locale)}${inlineCode(metrics.join(' / '))}`);
    }
    lines.push('', tr('### 正文', locale), '', textFence(bookmark.full_text || ''), '');
    if (bookmark.quoted_tweet) {
      lines.push(tr('### 引用内容', locale), '', `${fieldLabel('作者', locale)}${inlineCode(bookmark.quoted_tweet.author?.name || bookmark.quoted_tweet.author?.screen_name || tr('未知', locale))}`);
      if (bookmark.quoted_tweet.tweet_id) lines.push(`${fieldLabel('推文ID', locale)}${inlineCode(bookmark.quoted_tweet.tweet_id)}`);
      lines.push('', textFence(bookmark.quoted_tweet.full_text || tr('引用内容不可用', locale)), '');
    }
    const urls = mediaUrls(bookmark);
    if (urls.length) {
      lines.push(tr('### 媒体链接', locale), '');
      urls.forEach((url, mediaIndex) => lines.push(`- ${tr('媒体', locale)} ${mediaIndex + 1}${isEnglish(locale) ? ': ' : '：'}<${url}>`));
      lines.push('');
    }
    lines.push('---', '');
  });
  return `${lines.join('\n')}\n`;
}

export function exportFilename(archive, format, now = new Date()) {
  const metadata = archive?.export_metadata || {};
  const handle = String(metadata.screen_name || metadata.user_id || 'bookmarks').replace(/[^\p{L}\p{N}_-]/gu, '_').replace(/^_+|_+$/g, '') || 'bookmarks';
  const date = now.toISOString().replaceAll(':', '').replaceAll('-', '').slice(0, 15) + 'Z';
  const range = metadata.kind === 'cumulative' ? 'cumulative' : 'snapshot';
  const extension = format === 'markdown' ? 'md' : format;
  if (!['json', 'csv', 'md'].includes(extension)) throw new TypeError(tr('不支持的导出格式。'));
  return `Xkeeps_${handle}_${date}_${range}.${extension}`;
}

export const csvHeaders = COLUMNS.map(([, label]) => label);

/** Likes exports keep the same tweet fidelity, with explicit provenance. */
export function buildLikesCsv(document, { exportedAt = new Date().toISOString(), locale = currentLocale() } = {}) {
  if (document?.format !== 'xkeeps-likes' || !Array.isArray(document.likes)) throw new TypeError(tr('需要Xkeeps 点赞存档。', locale));
  const columns = [['source', tr('来源', locale)], ...COLUMNS.filter(([key]) => key !== 'folders'), ['liked_at', tr('点赞时间', locale)]];
  const adapter = { bookmarks: document.likes, export_metadata: { ...document.account,
    kind: document.kind, collection: { mode: document.collection.mode, bookmarks: document.collection.coverage, reason: document.collection.reason } } };
  const header = columns.map(([, label]) => spreadsheetCell(tr(label, locale))).join(',');
  const rows = document.likes.map(tweet => {
    const row = { ...rowFor(tweet, adapter, exportedAt, locale), source: tr('点赞', locale), liked_at: tweet.liked_at || tr('未知', locale) };
    return columns.map(([key]) => spreadsheetCell(row[key], key)).join(',');
  });
  return `\uFEFF${[header, ...rows].join('\r\n')}\r\n`;
}

export function buildLikesMarkdown(document, { locale = currentLocale() } = {}) {
  if (document?.format !== 'xkeeps-likes' || !Array.isArray(document.likes)) throw new TypeError(tr('需要Xkeeps 点赞存档。', locale));
  const lines = [tr('# X 点赞导出', locale), '', tr('- 来源：点赞', locale),
    `${fieldLabel('账号', locale)}${inlineCode(document.account.screen_name ? '@' + document.account.screen_name : document.account.user_id)}`,
    `${fieldLabel('条目数', locale)}${document.likes.length}`,
    `${fieldLabel('导出范围', locale)}${document.kind === 'cumulative' ? tr('累计存档', locale) : tr('本次采集快照', locale)}`,
    `${fieldLabel('采集覆盖', locale)}${document.collection.coverage === 'complete' ? tr('完整', locale) : tr('部分或未知', locale)}`,
    `${fieldLabel('结束原因', locale)}${inlineCode(document.collection.reason)}`,
    tr('- 点赞时间：X 未明确返回时记为未知；发布时间不能代替点赞时间', locale),
    tr('- 图片和视频：仅保留远程媒体链接，不包含媒体文件', locale), ''];
  for (const [index, tweet] of document.likes.entries()) {
    lines.push(`## ${index + 1}. ${inlineCode(tweet.author?.name || tweet.author?.screen_name || tr('未知作者', locale))}`, '',
      `${fieldLabel('用户名', locale)}${inlineCode(tweet.author?.screen_name ? '@' + tweet.author.screen_name : tr('未知', locale))}`,
      `${fieldLabel('推文ID', locale)}${inlineCode(tweet.tweet_id)}`,
      `${fieldLabel('原文', locale)}<${postUrl(tweet)}>`,
      `${fieldLabel('发布时间', locale)}${inlineCode(tweet.created_at || tr('未知', locale))}`,
      `${fieldLabel('点赞时间', locale)}${inlineCode(tweet.liked_at || tr('未知', locale))}`,
      `${fieldLabel('首次采集', locale)}${inlineCode(tweet.first_seen_at || tr('未知', locale))}`,
      `${fieldLabel('最后见到', locale)}${inlineCode(tweet.last_seen_at || tr('未知', locale))}`,
      `${fieldLabel('状态', locale)}${inlineCode(localize(tweet.status, locale) || tr('未知', locale))}`, '', tr('### 正文', locale), '', textFence(tweet.full_text || ''), '');
    if (tweet.quoted_tweet) lines.push(tr('### 引用内容', locale), '', textFence(tweet.quoted_tweet.full_text || ''), '');
    const urls = mediaUrls(tweet);
    if (urls.length) lines.push(tr('### 媒体链接', locale), '', ...urls.map(url => `- <${url}>`), '');
    lines.push('---', '');
  }
  return `${lines.join('\n')}\n`;
}

export function likesFilename(document, format, now = new Date()) {
  const handle = String(document?.account?.screen_name || document?.account?.user_id || 'likes')
    .replace(/[^\p{L}\p{N}_-]/gu, '_').replace(/^_+|_+$/g, '') || 'likes';
  const stamp = now.toISOString().replaceAll(':', '').replaceAll('-', '').slice(0, 15) + 'Z';
  const extension = format === 'markdown' ? 'md' : format;
  if (!['json', 'csv', 'md'].includes(extension)) throw new TypeError(tr('不支持的导出格式。'));
  return `Xkeeps_Likes_${handle}_${stamp}_${document.kind === 'cumulative' ? 'cumulative' : 'snapshot'}.${extension}`;
}
