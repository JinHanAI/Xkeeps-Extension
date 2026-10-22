// Self-contained, script-free reader. Post text is evidence, never HTML.
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const MEDIA_PATH = '(?:media/(?:photo|video|thumbnail|avatar)/\\d+_[a-f0-9]{8}\\.(?:jpg|png|gif|webp|mp4))';
const LOCAL_PATH = new RegExp(`^(?:(?:part-\\d{3,6}|large)/)?${MEDIA_PATH}$`);
export function safeLocalMediaPath(value) { return typeof value === 'string' && LOCAL_PATH.test(value) ? value : null; }

export function offlineHtml(document, inventory, { language = 'zh-CN', part = null, root = false, status = 'complete' } = {}) {
  const en = language === 'en';
  const t = (zh, english) => en ? english : zh;
  const posts = document.bookmarks || document.likes || [];
  const byPost = new Map();
  for (const item of inventory.items || []) {
    if (item.status !== 'complete') continue;
    const path = safeLocalMediaPath(item.saved_path || item.path);
    if (!path) continue;
    for (const id of item.tweet_ids || []) {
      if (!byPost.has(String(id))) byPost.set(String(id), []);
      byPost.get(String(id)).push({ ...item, localPath: path });
    }
  }
  const title = t('已保存的内容', 'Saved posts');
  const cards = posts.map(post => {
    const media = byPost.get(String(post.tweet_id)) || [];
    const name = String(post.author?.name || post.author?.screen_name || t('作者未知', 'Unknown author'));
    const avatar = media.find(item => item.type === 'avatar');
    const header = avatar ? `<img class="avatar" src="${escape(avatar.localPath)}" alt="${escape(name)}">`
      : `<span class="avatar initial" aria-label="${t('未保存头像', 'Avatar not saved')}">${escape(Array.from(name)[0] || '?')}</span>`;
    const photos = media.filter(item => item.type === 'photo').map(item => `<a href="${escape(item.localPath)}"><img class="photo" src="${escape(item.localPath)}" alt="${t('已保存照片', 'Saved photo')}" loading="lazy"></a>`).join('');
    const videos = media.filter(item => item.type === 'video').map(item => {
      const poster = media.find(other => other.type === 'thumbnail');
      return `<video controls preload="none" playsinline${poster ? ` poster="${escape(poster.localPath)}"` : ''} src="${escape(item.localPath)}"></video>`;
    }).join('');
    const thumbnails = media.some(item => item.type === 'video') ? '' : media.filter(item => item.type === 'thumbnail')
      .map(item => `<img class="photo" src="${escape(item.localPath)}" alt="${t('仅保存了视频封面', 'Only the video thumbnail was saved')}" loading="lazy">`).join('');
    const missing = (post.media || []).some(item => item.type === 'photo') && !photos
      ? `<p class="muted">${t('此页未包含照片文件。', 'Photo files are not included in this page.')}</p>` : '';
    const missingVideo = (post.media || []).some(item => ['video', 'animated_gif'].includes(item.type)) && !videos
      ? `<p class="muted">${t('此页未包含可播放的视频文件。', 'Playable video files are not included in this page.')}</p>` : '';
    const quote = post.quoted_tweet ? `<blockquote><strong>${escape(post.quoted_tweet.author?.name || post.quoted_tweet.author?.screen_name || '')}</strong><p class="text">${escape(post.quoted_tweet.full_text || '')}</p></blockquote>` : '';
    const id = /^\d+$/.test(String(post.tweet_id || '')) ? String(post.tweet_id) : null;
    return `<article><header>${header}<div><h2>${escape(name)}</h2><p class="muted">${post.author?.screen_name ? '@' + escape(post.author.screen_name) + ' · ' : ''}${escape(post.created_at || '')}</p></div></header><p class="text">${escape(post.full_text || t('未采集到正文', 'Post text was not collected'))}</p>${quote}<div class="photos">${photos}${thumbnails}</div>${videos}${missing}${missingVideo}${id ? `<a class="original" href="https://x.com/i/status/${id}" target="_blank" rel="noopener noreferrer">${t('联网打开原帖', 'Open original online')} ↗</a>` : ''}</article>`;
  }).join('');
  return `<!doctype html><html lang="${en ? 'en' : 'zh-CN'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Xkeeps · ${title}</title><style>
*{box-sizing:border-box}body{margin:0;background:#080808;color:#f2f2f2;font:16px/1.6 system-ui,sans-serif}main{max-width:920px;padding:24px;margin:auto}h1{font-size:28px;margin:0}h2{font-size:17px;margin:0;overflow-wrap:anywhere}.muted{color:#b3b3b3;font-size:14px;margin:4px 0}.summary{padding:16px 0 24px}article{border:1px solid #333;border-radius:8px;padding:20px;margin:0 0 16px;background:#101010}header{display:flex;gap:12px;align-items:center}header>div{min-width:0}.avatar{width:44px;height:44px;border-radius:50%;object-fit:cover;flex:none}.initial{background:#292929;display:grid;place-items:center}.text{white-space:pre-wrap;overflow-wrap:anywhere}.photos{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px}.photo{display:block;width:100%;max-height:560px;object-fit:contain}video{display:block;width:100%;max-height:560px;margin:12px 0}a{color:#86cef4;overflow-wrap:anywhere}.original{font-size:14px;display:inline-block;margin-top:12px}blockquote{border-left:3px solid #555;margin:16px 0;padding:0 16px}@media(max-width:480px){main{padding:16px}article{padding:16px}h1{font-size:24px}}
</style></head><body><main><h1>Xkeeps · ${title}</h1><div class="summary"><p>${posts.length.toLocaleString(en ? 'en' : 'zh-CN')} ${t('条内容', 'posts')}${part ? ' · ' + t('分包', 'Part') + ' ' + part : ''}</p><p class="muted">${root ? t('先将所有 ZIP 解压到此文件所在文件夹，再打开本页查看。', 'Extract all ZIPs into the folder containing this file, then open this page.') : t('正文和昵称可离线阅读；本页仅显示此分包内成功保存的媒体。', 'Read text and names offline. This page displays media successfully saved in this part.')}</p>${status === 'complete' ? '' : `<p class="muted">${t('部分媒体未保存，请查看 media-manifest.json 中的结果。', 'Some media were not saved. Check media-manifest.json for details.')}</p>`}</div>${cards || `<p>${t('所选范围暂无内容。', 'There are no posts in this selection.')}</p>`}</main></body></html>`;
}
