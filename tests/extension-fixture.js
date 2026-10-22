/* Synthetic Chrome/X APIs for browser QA of the real options page. */
(() => {
  const nativeFetch = window.fetch.bind(window);
  const params = new URL(document.currentScript?.src || location.href).searchParams;
  const scenario = params.get('scenario') || 'full';
  const failurePath = params.get('fail') || '';
  const pendingSaves = [];
  const directoryTest = scenario.startsWith('support-directory');
  const account = params.get('account') || '42';
  window.addEventListener('DOMContentLoaded', () => {
    const style=document.createElement('style');
    style.textContent='.qa-artifact{display:block;overflow-wrap:anywhere}';
    document.head.append(style);
  });
  if (scenario.startsWith('support-')) document.addEventListener('click', event => {
    const link = event.target.closest('a[href^="mailto:"]');
    if (link) { event.preventDefault(); document.body.dataset.emailDraft = link.href; }
  });
  if (['clipboard-stub','clipboard-fail'].includes(failurePath)) {
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{
      if(failurePath==='clipboard-fail')throw new Error('Synthetic clipboard failure');
      document.body.dataset.copiedFeedback=text;
    }}});
  }
  if (failurePath === 'confirm-stub') {
    // Only disposable fixture data. Keep production confirmation unchanged;
    // test both cancel/accept without blocking CDP on a native modal.
    window.confirm = message => {
      const accepted = document.getElementById('qa-accept-confirm')?.checked === true;
      const proof = document.createElement('pre'); proof.className='qa-confirm-artifact'; proof.hidden=true;
      proof.textContent=JSON.stringify({message,accepted}); document.body.append(proof);
      return accepted;
    };
    window.addEventListener('DOMContentLoaded', () => {
      const label=document.createElement('label');
      const checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.id='qa-accept-confirm';
      label.append(checkbox,'仅接受合成测试数据的确认'); document.body.append(label);
    });
  }
  if (failurePath === 'analytics') {
    const open=indexedDB.open.bind(indexedDB);
    indexedDB.open=(name,...args) => {
      if (name === 'xkeeps-analytics-v1') {
        document.body.dataset.syntheticAnalyticsFailures=String(Number(document.body.dataset.syntheticAnalyticsFailures || 0)+1);
        throw new DOMException('Synthetic analytics unavailable', 'QuotaExceededError');
      }
      return open(name,...args);
    };
  }
  if (scenario === 'offline-download' || scenario.startsWith('support-')) {
    // Disposable in-memory filesystem: exercise the real export UI without
    // opening OS permissions or touching the user's download folder.
    const exports = new Map();
    const directory = prefix => ({
      async getDirectoryHandle(name) { return directory(prefix + name + '/'); },
      async getFileHandle(name) { return { async createWritable() {
        const chunks = [];
        return { async write(bytes) { chunks.push(bytes); }, async abort() {}, async close() {
          if (directoryTest) {
            document.body.dataset.pendingSave = prefix + name;
            await new Promise(resolve => pendingSaves.push(resolve));
            if ((failurePath === 'large' && prefix.includes('/large/')) || name === failurePath) throw new DOMException('Synthetic disk write failed: '+name, 'QuotaExceededError');
          }
          const blob = new Blob(chunks); exports.set(prefix + name, blob);
          if (scenario.startsWith('support-')) { const link=document.createElement('a'); link.className='qa-artifact'; link.href=URL.createObjectURL(blob); link.download=name; link.textContent='保存合成产物 '+name; document.body.append(link); }
          document.body.dataset.syntheticExportFiles = JSON.stringify([...exports.keys()]);
        } };
      } }; }
    });
    window.showDirectoryPicker = async () => { if(scenario.startsWith('support-') && !directoryTest || failurePath === 'permission') throw new DOMException('Synthetic protected Downloads folder', 'NotAllowedError'); return directory(''); };
    window.showSaveFilePicker = async options => directory('').getFileHandle(options.suggestedName);
  }
  if (directoryTest) window.addEventListener('DOMContentLoaded', () => {
    const confirm=document.createElement('button');confirm.id='qa-confirm-save';confirm.textContent='确认下一个模拟文件保存';
    confirm.addEventListener('click', () => pendingSaves.shift()?.());document.body.append(confirm);
  });
  if (['playback', 'playback-failure'].includes(scenario)) {
    // Native video loads bypass window.fetch. Map only this synthetic media URL
    // to the local test clip; production URLs and runtime code are unchanged.
    const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    Object.defineProperty(HTMLMediaElement.prototype, 'src', { ...src, set(value) {
      src.set.call(this, value === 'https://video.twimg.com/xkeeps-synthetic.mp4'
        ? new URL(scenario === 'playback' ? '/tests/fixtures/preview.mp4' : '/tests/fixtures/missing-preview.mp4', location.origin).href : value);
    } });
  }
  let nextDownloadId = 1;
  const completed = new Set();
  const pendingDownloads = [];
  if (scenario === 'support-ui') window.addEventListener('DOMContentLoaded', () => {
    const confirm = document.createElement('button'); confirm.id='qa-confirm-download'; confirm.textContent='确认下一个模拟下载完成';
    confirm.addEventListener('click', () => { const id=pendingDownloads.shift(); if(id) { completed.add(id); downloadListeners.forEach(listener=>listener({id,state:{current:'complete'}})); } });
    document.body.append(confirm);
  });
  let likesRequests = 0, releaseLikesPage;
  if (scenario === 'likes-progress') window.addEventListener('DOMContentLoaded', () => {
    const button=document.createElement('button');button.id='qa-likes-page';button.textContent='返回下一页合成点赞';
    button.addEventListener('click',()=>{releaseLikesPage?.();releaseLikesPage=null;});document.body.append(button);
  });
  const downloadListeners = new Set();
  const items = { [`xarchive_profile_${account}`]: 'archive_demo',
    [`xarchive_creds_${account}`]: { authorization: 'synthetic', captured_at: Date.now(), queryId_Bookmarks: 'test', queryId_BookmarkFoldersSlice: 'test', queryId_BookmarkFolderTimeline: 'test', queryId_Likes: 'test' } };
  window.chrome = {
    i18n: { getUILanguage: () => params.get('lang') || 'zh-CN' },
    permissions: { request: async options => !(scenario === 'schedule-denied' && options.permissions?.includes('alarms')), contains: async options => !(scenario === 'schedule-denied' && options.permissions?.includes('alarms')) },
    alarms: { create: async () => {}, clear: async () => {} },
    storage: { local: {
      get: (key, cb) => { const value = typeof key === 'string' ? { [key]: items[key] } : items; if (cb) cb(value); return Promise.resolve(value); },
      set: value => { Object.assign(items, value); return Promise.resolve(); },
    } },
    cookies: { get: ({ name }, cb) => { const cookie = { value: name === 'twid' ? `u=${account}` : 'synthetic' }; if (cb) cb(cookie); return Promise.resolve(cookie); } },
    runtime: { getURL: path => new URL(`/${path}`, location.origin).href, sendMessage: async () => ({ ok: true }) },
    tabs: { create: async ({ url }) => {
      const localUrl = new URL(url);
      if (scenario.startsWith('support-')) { document.body.dataset.openedExternal = url; return {id:1002}; }
      if (localUrl.hostname === 'x.com') {
        if (scenario === 'refresh-failure') throw new Error('synthetic capture unavailable');
        for (const name of ['Bookmarks', 'BookmarkFoldersSlice', 'BookmarkFolderTimeline', 'Likes']) items[`xarchive_creds_${account}`][`queryCapturedAt_${name}`] = Date.now();
        return { id: 1001 };
      }
      if (localUrl.pathname.endsWith('/viewer.html')) localUrl.hostname = 'localhost';
      window.open(localUrl.href, '_blank', 'noopener'); return { id: 1002 };
    }, remove: async () => {} },
    downloads: {
      onChanged: { addListener: listener => downloadListeners.add(listener), removeListener: listener => downloadListeners.delete(listener) },
      download: (options, cb) => {
        const id = nextDownloadId++;
        const fail = (scenario === 'support-final-failure' && options.filename.endsWith('.md')) || scenario === 'support-save-cancel';
        document.body.dataset.downloadCount = String(id);
        document.body.dataset.lastSyntheticDownload = options.filename;
        if (scenario.startsWith('support-')) { const link = document.createElement('a'); link.className='qa-artifact'; link.href=options.url; link.download=options.filename; link.textContent='保存合成产物 '+options.filename; document.body.append(link); }
        if (scenario.startsWith('support-') && /\.(json|csv|md)$/.test(options.filename)) {
          nativeFetch(options.url).then(reply=>reply.text()).then(text=>{ const proof=document.createElement('pre'); proof.className='qa-data-artifact'; proof.hidden=true; proof.dataset.filename=options.filename; proof.textContent=text; document.body.append(proof); });
        }
        cb?.(id);
        if (scenario === 'support-ui') { pendingDownloads.push(id); return; }
        queueMicrotask(() => downloadListeners.forEach(listener => listener((scenario === 'download-cancel' || fail)
          ? { id, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } }
          : { id, state: { current: 'complete' } })));
      },
      search: (_query, cb) => cb([{ id: nextDownloadId - 1, state: scenario === 'support-ui' ? (completed.has(nextDownloadId-1) ? 'complete':'in_progress') : (scenario === 'download-cancel' || scenario === 'support-save-cancel' || (scenario === 'support-final-failure' && document.body.dataset.lastSyntheticDownload?.endsWith('.md'))) ? 'in_progress' : 'complete' }]),
    },
  };
  const tweet = (id, text) => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: {
    rest_id: id,
    core: { user_results: { result: {
      rest_id: 'demo-author-1',
      core: { name: '示例作者✨', screen_name: 'archive_author' },
      avatar: { image_url: 'https://pbs.twimg.com/xkeeps-synthetic.png' },
      is_blue_verified: false,
      legacy: { id_str: 'demo-author-1', followers_count: 123 },
    } } },
    legacy: { full_text: text, created_at: '2026-09-01T12:00:00Z', favorite_count: 3, retweet_count: 1, reply_count: 2 },
  } } } } });
  const previewAttempts = new Map();
  const publicFigureAssets = {};
  window.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (scenario === 'website-demo' && url.hostname === 'pbs.twimg.com' && publicFigureAssets[url.pathname]) {
      const path=publicFigureAssets[url.pathname],asset=await nativeFetch(path),bytes=await asset.arrayBuffer();
      const reply=new Response(options?.method==='HEAD'?null:bytes,{status:200,headers:{'content-type':path.endsWith('.webp')?'image/webp':path.endsWith('.png')?'image/png':'image/jpeg','content-length':String(bytes.byteLength)}});
      Object.defineProperty(reply,'url',{value:url.href});return reply;
    }
    if (url.hostname === 'pbs.twimg.com' && url.pathname.startsWith('/xkeeps-synthetic') && url.pathname.endsWith('.png')) {
      if (scenario === 'support-preview-retry' && options?.method !== 'HEAD') {
        const attempts=(previewAttempts.get(url.href)||0)+1;previewAttempts.set(url.href,attempts);
        if (attempts===1 || failurePath==='preview-always-fails') return new Response('synthetic unavailable',{status:404});
        if (options?.cache==='reload') document.body.dataset.previewReload='true';
      }
      if (['support-partial-media','support-browse-partial'].includes(scenario) && options?.method !== 'HEAD') return new Response('synthetic unavailable', {status:404});
      if (scenario === 'support-avatar-speed' && options?.method !== 'HEAD') await new Promise(resolve => setTimeout(resolve, 80));
      const demoAvatar = scenario === 'website-demo' && url.pathname.match(/^\/xkeeps-synthetic-demo-avatar-([1-6])\.png$/);
      const demoPhoto = scenario === 'website-demo' && url.pathname === '/xkeeps-synthetic-public-photo-1.png';
      const icon = await nativeFetch(demoAvatar ? `/tests/fixtures/website-avatar-${demoAvatar[1]}.jpg` : demoPhoto ? '/tests/fixtures/website-public-photo-1.png' : '/icons/icon48.png');
      let bytes = await icon.arrayBuffer();
      if (directoryTest && url.pathname.includes('directory-')) { const padded=new Uint8Array(80000);padded.set(new Uint8Array(bytes));bytes=padded.buffer; }
      const reply = new Response(options?.method === 'HEAD' ? null : bytes, { status: 200,
        headers: { 'content-type': demoAvatar ? 'image/jpeg' : demoPhoto ? 'image/png' : 'image/png', 'content-length': String(bytes.byteLength) } });
      Object.defineProperty(reply, 'url', { value: url.href });
      return reply;
    }
    if (url.hostname === 'video.twimg.com' && url.pathname === '/xkeeps-synthetic.mp4') {
      let bytes = Uint8Array.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,2,0,105,115,111,109,105,115,111,50]);
      if (directoryTest) { const padded=new Uint8Array(200000);padded.set(bytes);bytes=padded; }
      const reply = new Response(bytes, { headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } });
      Object.defineProperty(reply, 'url', { value: url.href }); return reply;
    }
    if (url.hostname !== 'x.com') return nativeFetch(input, options);
    let data;
    if (url.pathname.endsWith('/Likes')) {
      likesRequests++;
      if (scenario === 'likes-interrupt' && likesRequests > 1) await new Promise(resolve => setTimeout(resolve, 10000));
      const secondPage = scenario === 'likes-progress' && JSON.parse(url.searchParams.get('variables') || '{}').cursor;
      if (secondPage) {
        document.body.dataset.likesPageWaiting='true';
        await new Promise(resolve=>{releaseLikesPage=resolve;});
        document.body.dataset.likesPageWaiting='false';
        if (failurePath === 'likes-error') return new Response('{}',{status:403});
      }
      const entries = secondPage ? [tweet('203','New item on page two')] : [tweet('201', 'A liked post from the simulated extension scan ✨'), tweet('202', 'Another liked post ✅'), { entryId: 'cursor-bottom-1', content: { value: 'next' } }];
      data = { data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } } };
    }
    else if (url.pathname.endsWith('/BookmarkFoldersSlice')) data = { data: { viewer: { user_results: { result: { bookmark_collections_slice: { items: [{ id: 'f1', name: 'Read later' }] } } } } } };
    else if (url.pathname.endsWith('/BookmarkFolderTimeline')) {
      if (scenario === 'folder-error') return new Response('{}', { status: 403 });
      data = { data: { bookmark_collection_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [tweet('102', 'New bookmark')] }] } } } };
    } else if (url.pathname.endsWith('/Bookmarks')) {
      if (scenario === 'bookmarks-slow') await new Promise(resolve => setTimeout(resolve, 2500));
      if (scenario === 'bad-response') data = { unexpected: true };
      else data = { data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [tweet('102', 'A new bookmark from the simulated extension scan ✨'), tweet('103', 'Another bookmark from the simulated extension scan ✅')] }] } } } };
    } else throw new Error(`Unexpected X request in test: ${url.pathname}`);
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
})();
