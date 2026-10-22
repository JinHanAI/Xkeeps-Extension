/* Shared, local-only search rules for the viewer and the main page. */
(function (root) {
  function tokenize(value) {
    return String(value || '').toLowerCase()
      .replace(/(\p{Extended_Pictographic})/gu, ' $1 ')
      .replace(/[^\p{L}\p{N}_\s@#\p{Extended_Pictographic}]/gu, ' ')
      .split(/\s+/)
      .filter(token => token.length > 1 || /[\p{Script=Han}\p{Extended_Pictographic}]/u.test(token));
  }
  function searchableText(item) {
    const parts = [item.full_text || '', item.tweet_id || ''];
    if (item.author?.screen_name) parts.push(item.author.screen_name);
    if (item.author?.name) parts.push(item.author.name);
    if (item.entities?.hashtags) parts.push(item.entities.hashtags.join(' '));
    if (item.entities?.mentions) parts.push(item.entities.mentions.map(mention => mention.screen_name).join(' '));
    for (const url of item.entities?.urls || []) parts.push(url.url || '', url.expanded_url || '', url.display_url || '');
    if (item.card?.title) parts.push(item.card.title);
    if (item.card?.description) parts.push(item.card.description);
    if (item.quoted_tweet?.full_text) parts.push(item.quoted_tweet.full_text);
    if (item.folders) parts.push(item.folders.join(' '));
    return parts.join(' ');
  }
  function createIndex(items) {
    const index = new Map();
    for (let position = 0; position < items.length; position++) {
      add(index, items[position], position);
    }
    return finish(index, items.length);
  }
  function add(index, item, position) {
    for (const token of new Set(tokenize(searchableText(item)))) {
      if (!index.has(token)) index.set(token, []);
      index.get(token).push(position);
    }
  }
  async function createIndexAsync(items, batchSize = 500) {
    const index = new Map();
    for (let position = 0; position < items.length; position++) {
      add(index, items[position], position);
      if (position && position % batchSize === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return finish(index, items.length);
  }
  function finish(index, length) {
    const keys = [...index.keys()].sort();
    function search(query) {
      const tokens = tokenize(query);
      if (!tokens.length) return null;
      let result = null;
      for (const token of tokens) {
        const matches = new Set();
        let lo = 0, hi = keys.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (keys[mid] < token) lo = mid + 1;
          else hi = mid;
        }
        for (let cursor = lo; cursor < keys.length && keys[cursor].startsWith(token); cursor++) {
          for (const position of index.get(keys[cursor])) matches.add(position);
        }
        result = result === null ? matches : new Set([...result].filter(position => matches.has(position)));
        if (!result.size) break;
      }
      return result || new Set();
    }
    return { search, size: length };
  }
  root.XKeepsSearch = { tokenize, searchableText, createIndex, createIndexAsync };
})(globalThis);
