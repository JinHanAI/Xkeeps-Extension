// Fetch up to four avatars ahead; ZIP writes stay ordered and large media streams unchanged.
// Keep at most four 1 MiB avatar buffers, never the complete collection in memory.
import { validatedMedia } from './media-backup.js';
const MAX_AVATAR_BYTES = 1024 * 1024;
export function avatarPrefetch(items, { fetchImpl = fetch, signal, concurrency = 4 } = {}) {
  const width = Math.max(1, Math.min(4, Math.floor(concurrency) || 1));
  const controller = new AbortController();
  const pending = new Map();
  async function prepare(item) {
    let response;
    try {
      const requestSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(20000)]);
      response = await fetchImpl(item.url, { credentials: 'omit', redirect: 'follow', signal: requestSignal });
      if (Number(response.headers.get('content-length')) > MAX_AVATAR_BYTES) {
        await response.body?.cancel().catch(() => {}); return { fallback: true };
      }
      const chunks = []; let size = 0;
      for await (const chunk of validatedMedia(response, 'avatar')) {
        if (requestSignal.aborted) throw requestSignal.reason;
        size += chunk.length;
        if (size > MAX_AVATAR_BYTES) return { fallback: true };
        chunks.push(chunk);
      }
      return { chunks, size, contentType: response.headers.get('content-type'), url: response.url };
    } catch (error) { await response?.body?.cancel().catch(() => {}); return { error }; }
  }
  return {
    async take(index) {
      if (controller.signal.aborted || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      for (let next = index; next < Math.min(items.length, index + width); next++) {
        if (items[next].type === 'avatar' && !pending.has(next)) pending.set(next, prepare(items[next]));
      }
      if (!pending.has(index)) return null;
      const result = await pending.get(index); pending.delete(index);
      if (result.error) throw result.error;
      if (result.fallback) return null;
      const response = new Response(new Blob(result.chunks), { headers: { 'content-type': result.contentType, 'content-length': String(result.size) } });
      Object.defineProperty(response, 'url', { value: result.url }); return response;
    },
    close() { controller.abort(); pending.clear(); },
  };
}
