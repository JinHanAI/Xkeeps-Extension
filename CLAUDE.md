# CLAUDE.md

## Project Overview

xarchive is a Chrome browser extension (Manifest V3) that collects bookmarks from X.com, maintains a cumulative archive per account, and exports JSON. The independent viewer imports/merges JSON with preview and persistent undo. Current behavior and schema are documented in `docs/incremental-archives.md`; `PLAN.md` describes the architecture and `FINDINGS.md` records the review findings. Historical planning/research remains linked in Git history.

## Key Architecture Decisions

- **Options page as runtime**: All heavy logic (API calls, pagination, storage, export) runs in the options page tab, NOT the service worker. The service worker only handles passive auth header capture via `webRequest.onSendHeaders`, opening the options page on icon click, and registering a dynamic `declarativeNetRequest` rule at install time.
- **No MAIN world injection needed**: Auth capture uses `webRequest`. The ISOLATED content script stores account-scoped display handles. Request identity is read from the actual session cookie through `lib/identity.js`.
- **Direct GraphQL API calls**: The extension makes its own paginated `fetch()` calls to X.com's internal GraphQL API from the options page, using `credentials: 'include'` for cookie forwarding.
- **`declarativeNetRequest` for origin spoofing**: A dynamic rule registered at install time (in `background.js`) injects `Origin: https://x.com` header, scoped to extension-originated requests via `initiatorDomains: [chrome.runtime.id]`. Static rules can't reference the extension ID, so the rule is created dynamically — no `rules.json` file is needed.
- **Separate staging and archive storage**: Dexie database `xarchive` holds the latest scan and its persisted `run_info`. Native IndexedDB `xarchive-library` holds per-account cumulative archives, one undo copy, and revisions. Clearing staging must never clear cumulative archives. Archive saves/undo are atomic and reject stale revisions; Web Locks serialize access to staging across extension tabs.
- **One shared merge implementation**: `lib/archive.js` is a classic script supporting both file-based viewer use and MV3 imports. Always preserve tweet IDs as strings, source observation dates, stable folder IDs, last good content, and unknown/partial completeness. Never infer deletion from missing API records. Quick mode is a documented heuristic; full refresh remains necessary.
- **Dynamic query ID capture**: Query IDs can rotate without notice. Capture them from real X page requests, with bounded background-tab discovery and structured bundle parsing as fallbacks. Do not recapture the extension's own requests or guess IDs from adjacent strings. Only declared X bundle hosts may be fetched; never execute downloaded code.
- **Conservative rate limiting**: 2.5s base delay between API calls with random jitter, exponential backoff on 429s, 5-minute cooldown after repeated failures.

## Key Files

- `PLAN.md` - Current architecture, data flow and development priorities
- `FINDINGS.md` - Review findings and verification boundaries; links to historical research
- `GOAL.md` - Project goal statement

### Source Files

| File | Purpose |
|---|---|
| `background.js` | Service worker: passive header/query-ID capture, icon click handler, dynamic DNR rule |
| `content.js` | Content script (ISOLATED world): reads user ID from cookie, screen name from DOM |
| `options.js` | Main entry point: export orchestration, UI state, event handlers |
| `options.html` | Export UI markup |
| `options.css` | Dark theme styling |
| `lib/api.js` | GraphQL request construction, header assembly, feature flags |
| `lib/identity.js` | Actual account cookie and serialized credential updates |
| `lib/fetcher.js` | Paginated fetching with retry and rate limiting |
| `lib/parser.js` | Response parsing: tweet extraction, tombstone handling, media/entities |
| `lib/folders.js` | Folder enumeration and tweet-to-folder cross-referencing |
| `lib/db.js` | IndexedDB storage layer via Dexie |
| `lib/exporter.js` | JSON assembly and download trigger |
| `lib/archive.js` | Schema validation, chronological/account-safe merge, persistent transactional archive/undo storage |
| `lib/viewer-workflow.js` | Viewer import preview, save, undo, account selection, URL/file loading, cache migration |
| `docs/incremental-archives.md` | Current workflow, schema v2, merge/storage semantics and limitations |
| `lib/query-ids.js` | Query ID management with JS bundle scraping fallback |
| `lib/utils.js` | Shared rate-limiting constants and timing helpers |
| `version.js` | Release version, synchronized with manifest.json and checked by tests |
| `manifest.json` | Chrome MV3 extension manifest |

## Important Constraints

- Never hardcode GraphQL query IDs -- they can rotate without notice
- Always use rate limiting between API calls (2.5s+ with jitter) -- Twillot's zero-delay approach caused account freezing
- Handle `TweetWithVisibilityResults`, `TweetTombstone`, and null `tweet_results.result` in response parsing
- Prefer `note_tweet.note_tweet_results.result.text` over `legacy.full_text` for tweets >280 chars
- Support array of folder IDs per tweet (not single folder like Twillot)
- Re-read `ct0` and the account cookie for each request; replay captured transaction IDs without fabrication
- Scope `declarativeNetRequest` rules narrowly to avoid interfering with normal X.com browsing
- Check the account before and after collection requests. Do not relabel an older staged snapshot using whichever account is currently signed in.
- Record folder list, per-folder, and bookmark completion independently. Pagination guards and unknown responses are partial, never complete.
- Keep `viewer.html`, `lib/archive.js`, and `lib/viewer-workflow.js` usable directly from disk without a build step.
- Run `node --test tests/*.test.mjs`. Use the disposable browser storage tests and synthetic extension fixture described in the README for storage/UI checks. Live X API behavior requires separate verification.
