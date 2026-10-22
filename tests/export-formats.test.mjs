import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCsv, buildMarkdown, exportFilename, csvHeaders, buildLikesCsv, buildLikesMarkdown } from '../lib/export-formats.js';

function parseCsv(input) {
  const source = input.replace(/^\uFEFF/, '').replace(/\r\n$/, '');
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted && ch === '"' && source[i + 1] === '"') { value += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { row.push(value); value = ''; }
    else if (ch === '\r' && !quoted && source[i + 1] === '\n') { row.push(value); rows.push(row); row = []; value = ''; i++; }
    else value += ch;
  }
  row.push(value);
  rows.push(row);
  return rows;
}

const archive = {
  export_metadata: { kind: 'cumulative', user_id: '42', screen_name: 'reader', exported_at: '2026-09-01T00:00:00.000Z', collection: { mode: 'quick', bookmarks: 'partial' } },
  bookmarks: [{
    tweet_id: '900719925474099312345', full_text: '=HYPERLINK("https://evil.example")\nquoted, "text"', created_at: '2026-08-01T12:00:00.000Z',
    status: 'available', author: { name: 'A, "B"', screen_name: 'reader', user_id: '123', profile_image_url: 'https://pbs.twimg.com/avatar.jpg' },
    _archive: { first_seen_at: '2026-08-02T00:00:00.000Z', last_seen_at: '2026-08-03T00:00:00.000Z' },
    folders: ['Read, later'], media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg' }, { type: 'video', variants: [{ url: 'javascript:alert(1)', content_type: 'video/mp4' }, { url: 'https://video.twimg.com/a.mp4', content_type: 'video/mp4' }] }],
    quoted_tweet: { tweet_id: '77', full_text: 'Quoted\ntext' }, metrics: { likes: 3, retweets: 4, replies: 5, views: 6 },
  }],
};

test('CSV preserves one row per bookmark, commas, quotes, newlines and long IDs', () => {
  const csv = buildCsv(archive, { exportedAt: '2026-09-28T01:00:00.000Z' });
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('\r\n'));
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], csvHeaders);
  assert.equal(rows[1].length, rows[0].length);
  const cells = Object.fromEntries(rows[0].map((header, i) => [header, rows[1][i]]));
  assert.equal(cells['推文ID'], "'900719925474099312345");
  assert.equal(cells['作者昵称'], 'A, "B"');
  assert.equal(cells['正文'], "'=HYPERLINK(\"https://evil.example\")\nquoted, \"text\"");
  assert.equal(cells['发布时间'], '2026-08-01T12:00:00.000Z');
  assert.equal(cells['最后见到时间'], '2026-08-03T00:00:00.000Z');
  assert.deepEqual(JSON.parse(cells['文件夹']), ['Read, later']);
  assert.deepEqual(JSON.parse(cells['媒体URL列表']), ['https://pbs.twimg.com/media/a.jpg', 'https://video.twimg.com/a.mp4']);
  assert.match(cells['采集覆盖'], /增量更新\/部分/);
  assert.equal(cells['状态'], '可用');
  assert.equal(cells['导出时间'], '2026-09-28T01:00:00.000Z');
});

test('Markdown keeps untrusted post text literal and filters unsafe media URLs', () => {
  const data = structuredClone(archive);
  data.bookmarks[0].full_text = '```html\n<script>alert(1)</script>\n[click](javascript:alert(1))';
  const md = buildMarkdown(data, { exportedAt: '2026-09-28T01:00:00.000Z' });
  assert.match(md, /````text\n```html/);
  assert.match(md, /<script>alert\(1\)<\/script>/);
  assert.match(md, /https:\/\/video\.twimg\.com\/a\.mp4/);
  assert.match(md, /作者ID：`123`/);
  assert.match(md, /头像URL：<https:\/\/pbs\.twimg\.com\/avatar\.jpg>/);
  assert.match(md, /首次采集：`2026-08-02T00:00:00.000Z`/);
  assert.match(md, /点赞 3/);
  assert.doesNotMatch(md, /^- 媒体 \d+：<javascript:/m);
  assert.match(md, /累计存档/);
  assert.match(md, /作者昵称|A, "B"/);
});

test('filenames distinguish range and format while removing path characters', () => {
  const now = new Date('2026-09-28T01:02:03.000Z');
  assert.equal(exportFilename(archive, 'csv', now), 'Xkeeps_reader_20260928T010203Z_cumulative.csv');
  const snapshot = { export_metadata: { kind: 'snapshot', screen_name: '../demo' }, bookmarks: [] };
  assert.equal(exportFilename(snapshot, 'markdown', now), 'Xkeeps_demo_20260928T010203Z_snapshot.md');
  assert.throws(() => exportFilename(archive, 'pdf', now), /不支持/);
});


test('English export labels preserve source content and spreadsheet protections across all formats', () => {
  const data = structuredClone(archive);
  data.bookmarks[0].full_text = '=中文原文, "keep"';
  data.bookmarks[0].folders = ['中文文件夹', 'Research'];
  const before = JSON.stringify(data);
  const csv = parseCsv(buildCsv(data, { locale: 'en', exportedAt: 'fixed' }));
  const cells = Object.fromEntries(csv[0].map((label, i) => [label, csv[1][i]]));
  assert.equal(cells['Post text'], "'=中文原文, \"keep\"");
  assert.equal(cells['Post ID'], "'900719925474099312345");
  assert.equal(cells.Status, 'Available');
  assert.equal(cells['Collection coverage'], 'Incremental update/Partial');
  assert.equal(cells.Folders, '["中文文件夹","Research"]');
  const md = buildMarkdown(data, { locale: 'en' });
  assert.match(md, /^# X bookmarks export/);
  assert.match(md, /- Images and videos: remote links only/);
  assert.match(md, /- Folders: `中文文件夹`, `Research`/);
  assert.ok(md.includes(data.bookmarks[0].full_text));
  const likes = { format: 'xkeeps-likes', kind: 'cumulative', account: { user_id: '42', screen_name: 'demo' }, collection: { mode: 'quick', coverage: 'partial', reason: 'known_boundary' }, likes: data.bookmarks };
  const likeCsv = parseCsv(buildLikesCsv(likes, { locale: 'en' }));
  assert.equal(likeCsv[0][0], 'Source'); assert.equal(likeCsv[1][0], 'Likes');
  assert.equal(likeCsv[1].at(-1), 'Unknown');
  const likeMd = buildLikesMarkdown(likes, { locale: 'en' });
  assert.match(likeMd, /^# X likes export/); assert.match(likeMd, /- Source: Likes/);
  assert.match(likeMd, /- Liked at: `Unknown`/);
  assert.equal(JSON.stringify(data), before);
});

test('language is read at export time, explicit locale wins, and empty/error exports stay localized', () => {
  const prior = globalThis.document;
  try {
    globalThis.document = { documentElement: { lang: 'en' } };
    assert.match(buildMarkdown({ bookmarks: [] }), /^# X bookmarks export/);
    assert.match(buildMarkdown({ bookmarks: [] }, { locale: 'zh-CN' }), /^# X 书签导出/);
    globalThis.document.documentElement.lang = 'zh-CN';
    assert.match(buildMarkdown({ bookmarks: [] }), /^# X 书签导出/);
    assert.throws(() => buildCsv(null, { locale: 'en' }), /archive containing bookmarks/);
    assert.throws(() => buildLikesMarkdown(null, { locale: 'en' }), /likes archive/);
    assert.equal(parseCsv(buildCsv({ bookmarks: [] }, { locale: 'en' })).length, 1);
  } finally { if (prior === undefined) delete globalThis.document; else globalThis.document = prior; }
});
