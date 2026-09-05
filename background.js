/**
 * xarchive service worker — intentionally minimal.
 *
 * Three responsibilities only:
 *   1. Passively capture auth headers + GraphQL query IDs from X.com
 *      requests via webRequest.onSendHeaders.
 *   2. Open the options page when the extension icon is clicked.
 *   3. Register a dynamic declarativeNetRequest rule at install time
 *      to inject Origin/Referer headers on extension-originated
 *      GraphQL requests (scoped via `initiatorDomains`).
 *
 * All heavy logic (API calls, pagination, storage, export) runs in the
 * options page tab so it is unaffected by service worker lifecycle
 * termination.
 */

import { getSessionUserId, updateCredentials } from './lib/identity.js';

/** Matches bookmark-related GraphQL operations to capture their query IDs. */
const GRAPHQL_PATTERN = /\/graphql\/([^/]+)\/(Bookmarks|BookmarkFoldersSlice|BookmarkFolderTimeline)\b/;

/** Auth-related headers to persist for later use by the options page. */
const CAPTURE_HEADERS = ['authorization', 'x-csrf-token', 'x-client-uuid', 'x-client-transaction-id'];

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    // Capture real page requests only. Replaying our own calls must not make
    // stale query IDs or credentials appear freshly captured.
    if (!['https://x.com', 'https://twitter.com'].includes(details.initiator)) return;
    const url = new URL(details.url);
    const headerMap = {};

    // Collect relevant auth headers from the outgoing request.
    for (const h of details.requestHeaders || []) {
      if (CAPTURE_HEADERS.includes(h.name.toLowerCase())) {
        headerMap[h.name.toLowerCase()] = h.value;
      }
    }

    // Extract query ID and operation name from GraphQL URL path.
    const match = url.pathname.match(GRAPHQL_PATTERN);
    if (match) {
      const [, queryId, operation] = match;
      headerMap[`queryId_${operation}`] = queryId;
      headerMap[`queryCapturedAt_${operation}`] = Date.now();
    }

    // Capture feature flags from query string for later replay.
    const featuresParam = url.searchParams.get('features');
    if (featuresParam && match) {
      headerMap[`features_${match[2]}`] = featuresParam;
    }

    if (Object.keys(headerMap).length === 0) return;

    // Store captured data namespaced by the logged-in user ID.
    getSessionUserId().then(uid => updateCredentials(uid, { ...headerMap, captured_at: Date.now() }))
      .catch(() => { /* The options page reports missing credentials/storage. */ });
  },
  { urls: ['https://x.com/i/api/graphql/*'], types: ['xmlhttprequest'] },
  ['requestHeaders', 'extraHeaders']
);

/** Open the options page when the extension icon is clicked. */
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

/**
 * Install a dynamic declarativeNetRequest rule that injects
 * `Origin: https://x.com` and `Referer: https://x.com/` on the
 * extension's own GraphQL requests.
 *
 * Static rules (rules.json) cannot reference the extension's own
 * origin, so we register a dynamic rule at install time using
 * `chrome.runtime.id` as the `initiatorDomains` value.  This scopes
 * the rule to extension-originated requests only, avoiding
 * interference with normal X.com browsing (Twillot issue #127).
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'https://x.com' },
          { header: 'Referer', operation: 'set', value: 'https://x.com/' },
        ],
      },
      condition: {
        urlFilter: 'https://x.com/i/api/graphql/*',
        resourceTypes: ['xmlhttprequest'],
        initiatorDomains: [chrome.runtime.id],
      },
    }],
  });
});
