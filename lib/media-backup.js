import { offlineHtml } from './offline-view.js';

const CDN_HOSTS = new Set(['pbs.twimg.com', 'video.twimg.com']);
const MB = 1024 * 1024;
export const MAX_ZIP_BYTES = 2 * 1024 * MB;
const ROUGH_BYTES = { photo: 300 * 1024, video: 8 * MB, thumbnail: 100 * 1024, avatar: 24 * 1024 };

export function safeMediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !CDN_HOSTS.has(url.hostname) || url.port || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function shortHash(value) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

function videoVariant(variants) {
  const mp4 = (variants || []).filter(item => item.content_type === 'video/mp4' && safeMediaUrl(item.url));
  mp4.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4.find(item => item.bitrate >= 400000 && item.bitrate <= 1200000) || mp4.at(-1) || null;
}

export function buildMediaInventory(document, choices = {}) {
  const items = document.bookmarks || document.likes || [];
  const byUrl = new Map();
  const rejected = [];
  function add(rawUrl, type, tweetId, bitrate = 0, durationMs = 0) {
    const url = safeMediaUrl(rawUrl);
    if (!url) { rejected.push({ tweet_id: tweetId, type, reason: 'unsafe_or_unsupported_url' }); return; }
    if (byUrl.has(url)) { byUrl.get(url).tweet_ids.push(tweetId); return; }
    const parsed = new URL(url);
    const format = parsed.searchParams.get('format') || parsed.pathname.match(/\.(jpe?g|png|gif|webp)(?:$|:)/i)?.[1] || 'jpg';
    const extension = type === 'video' ? '.mp4' : `.${({ jpeg: 'jpg', jpg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' })[format.toLowerCase()] || 'jpg'}`;
    const path = `media/${type}/${tweetId}_${shortHash(url)}${extension}`;
    byUrl.set(url, { url, path, type, tweet_ids: [tweetId], expected_bytes: bitrate && durationMs ? Math.ceil(bitrate * durationMs / 8000) : null,
      estimate_source: bitrate && durationMs ? 'bitrate_duration' : 'unknown', status: 'pending', actual_bytes: null });
  }
  for (const tweet of items) {
    if (!/^\d+$/.test(tweet.tweet_id || '')) continue;
    if (choices.avatars && tweet.author?.profile_image_url) add(tweet.author.profile_image_url, 'avatar', tweet.tweet_id);
    for (const media of tweet.media || []) {
      if (media.type === 'photo' && choices.photos) add(media.url, 'photo', tweet.tweet_id);
      if (['video', 'animated_gif'].includes(media.type)) {
        if (choices.videos) {
          const variant = videoVariant(media.variants);
          if (variant) add(variant.url, 'video', tweet.tweet_id, variant.bitrate, media.duration_ms);
          else rejected.push({ tweet_id: tweet.tweet_id, type: 'video', reason: 'no_mp4_variant' });
        }
        if (choices.thumbnails && media.thumbnail_url) add(media.thumbnail_url, 'thumbnail', tweet.tweet_id);
      }
    }
  }
  return { items: [...byUrl.values()], rejected, tweet_count: items.length };
}

export function summarizeEstimate(inventory) {
  const byType = {};
  for (const item of inventory.items) {
    const bucket = byType[item.type] ||= { count: 0, known_bytes: 0, estimated_bytes: 0, unknown_count: 0, sampled_count: 0, missing_count: 0 };
    bucket.count++;
    if (item.estimate_source === 'head' && item.expected_bytes != null) {
      bucket.known_bytes += item.expected_bytes;
      bucket.sampled_count++;
      bucket.estimated_bytes += item.expected_bytes;
    } else {
      bucket.unknown_count++;
      if (item.expected_bytes != null) bucket.estimated_bytes += item.expected_bytes;
      else bucket.missing_count++;
    }
  }
  for (const [type, bucket] of Object.entries(byType)) {
    if (!bucket.missing_count) continue;
    bucket.estimated_bytes += Math.ceil((bucket.sampled_count
      ? bucket.known_bytes / bucket.sampled_count : ROUGH_BYTES[type]) * bucket.missing_count);
  }
  return { byType, total_count: inventory.items.length,
    estimated_bytes: Object.values(byType).reduce((sum, group) => sum + group.estimated_bytes, 0),
    unknown_count: Object.values(byType).reduce((sum, group) => sum + group.unknown_count, 0),
    unreliable_count: Object.values(byType).reduce((sum, group) => sum + (group.sampled_count ? 0 : group.missing_count), 0),
    rejected_count: inventory.rejected.length };
}

/** ZIP stores text without compression. Media links and final statuses add a small variable margin. */
export function estimateArchiveBytes(document, inventory) {
  const encode = value => new TextEncoder().encode(value).length;
  const json = encode(JSON.stringify(document, null, 2) + '\n');
  const index = encode(markdownIndex(document, { items: [] }));
  const html = encode(offlineHtml(document, { items: inventory.items.map(item => ({ ...item, status: 'complete' })) }));
  const manifest = encode(JSON.stringify({ media: inventory.items, rejected: inventory.rejected,
    estimated: summarizeEstimate(inventory), counts: { complete: 0, failed: 0, partial: 0, cancelled: 0 } }, null, 2));
  return json + index + html + manifest + 4096 + inventory.items.length * 600;
}

export async function sampleMediaSizes(inventory, { fetchImpl = fetch, signal, perType = 3 } = {}) {
  const counts = new Map();
  for (const item of inventory.items) {
    if (item.expected_bytes != null || (counts.get(item.type) || 0) >= perType) continue;
    counts.set(item.type, (counts.get(item.type) || 0) + 1);
    try {
      const response = await fetchImpl(item.url, { method: 'HEAD', redirect: 'follow', credentials: 'omit', signal: signal || AbortSignal.timeout(5000) });
      if (!response.ok || !safeMediaUrl(response.url)) continue;
      const size = Number(response.headers.get('content-length'));
      if (Number.isSafeInteger(size) && size > 0 && size < MAX_ZIP_BYTES) {
        item.expected_bytes = size; item.estimate_source = 'head';
      }
    } catch { /* Unknown size remains unknown. */ }
  }
  return summarizeEstimate(inventory);
}

function crcTable() {
  return Uint32Array.from({ length: 256 }, (_, index) => {
    let c = index;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
}
const CRC_TABLE = crcTable();
function crc32(crc, bytes) {
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
function u16(view, offset, value) { view.setUint16(offset, value, true); }
function u32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

/* Stored ZIP entries with data descriptors permit streaming without buffering media. */
export class ZipStream {
  constructor(writable, maxBytes = MAX_ZIP_BYTES) { this.writable = writable; this.maxBytes = maxBytes; this.offset = 0; this.entries = []; }
  async write(bytes) {
    if (this.offset + bytes.length > this.maxBytes) throw new Error('zip_budget_exceeded');
    try { await this.writable.write(bytes); }
    catch (error) { throw new Error('storage_write_failed', { cause: error }); }
    this.offset += bytes.length;
  }
  async add(path, chunks) {
    if (!/^(?:part-\d{3,6}\/)?(?:media\/(?:photo|video|thumbnail|avatar)\/\d+_[a-f0-9]{8}\.(?:jpg|png|gif|webp|mp4)|(?:archive\.(?:json|csv|md)|media-manifest\.json|index\.md|README\.txt|打开查看\.html))$/.test(path)) throw new Error('invalid_zip_path');
    const name = new TextEncoder().encode(path);
    const localOffset = this.offset;
    const header = new Uint8Array(30 + name.length);
    const h = new DataView(header.buffer);
    u32(h, 0, 0x04034b50); u16(h, 4, 20); u16(h, 6, 0x0808); u16(h, 8, 0); u16(h, 26, name.length);
    header.set(name, 30);
    await this.write(header);
    let size = 0, crc = 0xffffffff, failure = null;
    try {
      for await (const chunk of chunks) {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        if (bytes.length > this.maxBytes - this.offset - 22) throw new Error('zip_budget_exceeded');
        await this.write(bytes); size += bytes.length; crc = crc32(crc, bytes);
      }
    } catch (error) {
      if (error.message === 'storage_write_failed') throw error;
      failure = error;
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const descriptor = new Uint8Array(16);
    const d = new DataView(descriptor.buffer);
    u32(d, 0, 0x08074b50); u32(d, 4, crc); u32(d, 8, size); u32(d, 12, size);
    await this.write(descriptor);
    this.entries.push({ name, size, crc, localOffset });
    return { size, failure };
  }
  async finish() {
    const centralOffset = this.offset;
    for (const entry of this.entries) {
      const record = new Uint8Array(46 + entry.name.length);
      const view = new DataView(record.buffer);
      u32(view, 0, 0x02014b50); u16(view, 4, 20); u16(view, 6, 20); u16(view, 8, 0x0808);
      u32(view, 16, entry.crc); u32(view, 20, entry.size); u32(view, 24, entry.size);
      u16(view, 28, entry.name.length); u32(view, 42, entry.localOffset);
      record.set(entry.name, 46);
      await this.write(record);
    }
    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    u32(view, 0, 0x06054b50); u16(view, 8, this.entries.length); u16(view, 10, this.entries.length);
    u32(view, 12, this.offset - centralOffset); u32(view, 16, centralOffset);
    await this.write(end);
    await this.writable.close();
  }
}

export function bytesOf(text) { return [new TextEncoder().encode(text)]; }

export function mediaSignature(bytes, type) {
  if (type === 'video') return bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
  return (bytes[0] === 0xff && bytes[1] === 0xd8)
    || (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    || String.fromCharCode(...bytes.slice(0, 3)) === 'GIF'
    || (String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP');
}

export async function* validatedMedia(response, type) {
  if (!response.ok || !safeMediaUrl(response.url)) throw new Error('media_response_rejected');
  const contentType = response.headers.get('content-type') || '';
  if (type === 'video' ? !/^video\/mp4(?:;|$)/i.test(contentType) : !/^image\/(jpeg|png|gif|webp)(?:;|$)/i.test(contentType)) throw new Error('media_content_type_rejected');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('media_body_missing');
  const declared = Number(response.headers.get('content-length'));
  let received = 0;
  try {
    let prefix = new Uint8Array(0);
    while (prefix.length < 12) {
      const next = await reader.read();
      if (next.done) break;
      const joined = new Uint8Array(prefix.length + next.value.length);
      joined.set(prefix); joined.set(next.value, prefix.length); prefix = joined;
    }
    if (!mediaSignature(prefix, type)) throw new Error('media_signature_rejected');
    received += prefix.length;
    yield prefix;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.length;
      yield chunk.value;
    }
    if (!response.headers.get('content-encoding') && Number.isSafeInteger(declared) && declared > 0 && received !== declared) throw new Error('media_body_truncated');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function markdownIndex(document, inventory) {
  const items = document.bookmarks || document.likes || [];
  const literal = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&');
  const lines = ['# Xkeeps offline archive', '', `Source: ${document.source || (document.likes ? 'likes' : 'bookmarks')}`, ''];
  const mediaByTweet = new Map();
  for (const media of inventory.items) if (media.status === 'complete') {
    for (const tweetId of media.tweet_ids) {
      if (!mediaByTweet.has(tweetId)) mediaByTweet.set(tweetId, []);
      mediaByTweet.get(tweetId).push(media);
    }
  }
  for (const item of items) {
    lines.push(`## ${literal(item.author?.name || item.author?.screen_name || 'Unknown author')} — ${item.tweet_id}`, '', literal(item.full_text || '[Unavailable]'), '', `Original: https://x.com/i/status/${item.tweet_id}`, '');
    for (const media of mediaByTweet.get(item.tweet_id) || []) lines.push(`[${media.type}](./${media.path})`);
    lines.push('');
  }
  return lines.join('\n');
}
