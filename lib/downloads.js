function waitForChromeDownload(options, timeoutMs = 300_000) {
  return new Promise((resolve, reject) => {
    const api = globalThis.chrome?.downloads;
    if (!api) return reject(new Error('Chrome 下载接口不可用。'));
    let id = null;
    let timer;
    const queued = new Map();
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      api.onChanged?.removeListener?.(onChanged);
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      error ? reject(error) : resolve(id);
    };
    const check = delta => {
      if (!delta || delta.id !== id) return false;
      if (delta.error?.current) return finish(new Error(`下载中断：${delta.error.current}`)), true;
      if (delta.state?.current === 'complete') return finish(null), true;
      if (delta.state?.current === 'interrupted') return finish(new Error('下载已中断，请重试。')), true;
      return false;
    };
    function onChanged(delta) {
      if (id == null) queued.set(delta.id, delta);
      else check(delta);
    }
    api.onChanged?.addListener?.(onChanged);
    timer = setTimeout(() => finish(new Error('等待下载完成超时。请检查Chrome下载列表后重试。')), timeoutMs);
    try {
      api.download(options, downloadId => {
        const lastError = globalThis.chrome?.runtime?.lastError;
        if (lastError) return finish(new Error(lastError.message || 'Chrome未能启动下载。'));
        if (!Number.isInteger(downloadId)) return finish(new Error('Chrome未返回有效的下载任务。'));
        id = downloadId;
        if (check(queued.get(id))) return;
        api.search({ id }, items => {
          const error = globalThis.chrome?.runtime?.lastError;
          if (error) return finish(new Error(error.message));
          const item = items?.[0];
          if (item?.state === 'complete') finish(null);
          else if (item?.state === 'interrupted') finish(new Error(`下载中断：${item.error || '请重试'}`));
        });
      });
    } catch (error) { finish(error); }
  });
}

export async function downloadBlob(blob, filename, context = null) {
  const url = URL.createObjectURL(blob);
  try {
    if (globalThis.chrome?.downloads?.download) {
      const id = await waitForChromeDownload({ url, filename, saveAs: true });
      // Chrome can report the actual user-chosen destination after completion.
      // This local hint never grants file-read access and must not be logged or transmitted.
      try {
        if (globalThis.chrome?.storage?.local?.set) {
          const item = await new Promise(resolve => chrome.downloads.search({ id }, rows => resolve(rows?.[0] || null)));
          if (item?.filename && context?.userId && ['bookmarks', 'likes'].includes(context.source)) {
            await chrome.storage.local.set({ xkeeps_last_download: { path: item.filename, at: new Date().toISOString(),
              userId: String(context.userId), source: context.source } });
          }
        }
      } catch { /* A saved download remains successful if path metadata is unavailable. */ }
      return { filename, downloadId: id, state: 'complete' };
    }
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    return { filename, downloadId: null, state: 'requested' };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
