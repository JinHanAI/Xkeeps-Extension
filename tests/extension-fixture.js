/* Synthetic Chrome/X APIs for browser QA of the real options page. */
(() => {
  const nativeFetch = window.fetch.bind(window);
  const params = new URL(location.href).searchParams;
  const scenario = params.get('scenario') || 'full';
  const account = params.get('account') || '42';
  const items = { [`xarchive_profile_${account}`]: 'archive_demo',
    [`xarchive_creds_${account}`]: { authorization: 'synthetic', captured_at: Date.now(), queryId_Bookmarks: 'test', queryId_BookmarkFoldersSlice: 'test', queryId_BookmarkFolderTimeline: 'test' } };
  window.chrome = {
    storage: { local: {
      get: (key, cb) => { const value = typeof key === 'string' ? { [key]: items[key] } : items; if (cb) cb(value); return Promise.resolve(value); },
      set: value => { Object.assign(items, value); return Promise.resolve(); },
    } },
    cookies: { get: ({ name }, cb) => { const cookie = { value: name === 'twid' ? `u=${account}` : 'synthetic' }; if (cb) cb(cookie); return Promise.resolve(cookie); } },
    downloads: { download: (options, cb) => { document.getElementById('library-status').textContent = `Test download requested: ${options.filename}`; cb?.(); } },
  };
  const tweet = (id, text) => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: { rest_id: id, legacy: { full_text: text, created_at: '2026-09-01T12:00:00Z' } } } } } });
  window.fetch = async (input, options) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.hostname !== 'x.com') return nativeFetch(input, options);
    let data;
    if (url.pathname.endsWith('/BookmarkFoldersSlice')) data = { data: { viewer: { user_results: { result: { bookmark_collections_slice: { items: [{ id: 'f1', name: 'Read later' }] } } } } } };
    else if (url.pathname.endsWith('/BookmarkFolderTimeline')) {
      if (scenario === 'folder-error') return new Response('{}', { status: 403 });
      data = { data: { bookmark_collection_timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [tweet('102', 'New bookmark')] }] } } } };
    } else if (url.pathname.endsWith('/Bookmarks')) {
      if (scenario === 'bad-response') data = { unexpected: true };
      else data = { data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [tweet('102', 'A new bookmark from the simulated extension scan.'), tweet('103', 'Another bookmark from the simulated extension scan.')] }] } } } };
    } else throw new Error(`Unexpected X request in test: ${url.pathname}`);
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
})();
