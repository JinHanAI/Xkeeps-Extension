# Architecture and development plan

This document describes the current implementation. The original exploratory plan is preserved in [Git history](https://github.com/sytelus/xarchive/blob/e74d04115f9df07b3589f71f9886b33ed34f62b1/PLAN.md); its proposed MAIN-world injection, transaction-ID mutation, cursor resumption, and snapshot-only storage are not current behavior.

## Runtime boundaries

| Component | Inputs | Responsibilities and outputs |
|---|---|---|
| `background.js` | X page request headers and operation URLs | Capture account-scoped credentials/query IDs, open options, install narrowly scoped Origin/Referer rules |
| `content.js` | Visible profile link and page cookie | Store an account-scoped display handle; request identity comes from the actual session cookie |
| `options.js` | User actions, current session, saved account archive | Coordinate full/quick scans, progress, partial recovery, import review, download and undo |
| `lib/identity.js`, `lib/api.js` | Current cookies and captured headers | Verify account identity and construct bounded, authenticated X requests |
| `lib/query-ids.js` | Page requests or allowed X bundle text | Discover named operation IDs; never execute downloaded bundles or guess nearby strings |
| `lib/fetcher.js`, `lib/folders.js`, `lib/parser.js` | Private API responses | Parse recognized shapes, paginate with rate limits, persist pages, report independent coverage |
| `lib/db.js` | Collected pages and run metadata | Dexie staging store for the latest scan; reset separately from cumulative archives |
| `lib/archive.js` | Legacy/schema-v2 JSON and a previous archive | Validate, normalize, merge by account/tweet/folder ID, save atomically with revision checks and one undo copy |
| `lib/exporter.js` | Staged content, folder mappings, pinned run identity | Assemble a snapshot and request a JSON download |
| `viewer.html`, `lib/viewer-workflow.js` | JSON files/URLs and saved archives | Review changes, save/undo/select accounts, index/search/render a disposable data copy, download combined backups |

The extension has no server and no build step. Dexie is vendored with its license. The viewer loads classic scripts so it can open directly from disk; it does not call extension APIs.

## Data flow

1. The current `twid` cookie selects an account; a handle is only a label.
2. The extension acquires the staging Web Lock, pins run identity, and resets staging transactionally.
3. Full mode collects folder definitions, folder pages, then main bookmark pages. Quick mode collects main pages until a whole page is already archived, or pagination ends.
4. Requests verify identity before and after the network call. Recognized pages are persisted. Backoff, pause, stop and terminal coverage are explicit.
5. A finished/stopped scan becomes a snapshot. The shared merge builds a cumulative candidate while retaining absent history and last good content.
6. An atomic revision-checked save records current and previous versions. Failure leaves the saved archive unchanged and staging available for recovery.
7. JSON downloads transfer data between the independent extension and viewer stores. Viewer imports require review before a save; downloading alone does not update another copy.

See [incremental-archives.md](docs/incremental-archives.md) for the authoritative schema and chronological merge rules. `collection.reason` describes main pagination; folder states must be checked separately. A normally terminated response stream is not independent proof that X returned every bookmark.

## Maintenance priorities

1. Verify a real, authenticated extension run after private API changes, including accounts with folders and rate-limit behavior. Synthetic tests cannot establish live compatibility.
2. Keep sanitized fixtures for newly observed response shapes and add a regression before extending the parser.
3. Profile large archives before introducing workers, a different storage format, or more history. Current merges and JSON serialization require the whole archive in memory; saved undo needs additional storage.
4. Consider optional media-file backups only as a separate feature with explicit download controls, quotas, and portable paths. Current archives retain URLs.

Use the [maintenance guide](docs/maintenance.md) for checks, troubleshooting and release steps.
