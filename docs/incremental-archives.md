# Incremental archives

The archive is cumulative. A scan or JSON import adds observations to a saved collection; it does not delete records missing from the new source. Both the extension and viewer use `lib/archive.js` for validation, normalization, merging, and storage.

## User workflows

In the extension, import an existing JSON for the signed-in account or start with **Full refresh**. Later choose Full refresh or **Quick update**. The scan uses separate staging tables. Finishing or stopping merges collected bookmarks into the cumulative archive. **Download combined archive** includes all saved history; **Download latest snapshot** includes only this scan. The archive panel reports counts and the last complete full refresh. A seven-day reminder is advisory; it schedules no network activity.

In the viewer, **Update from JSON** previews the merge against the selected account. **Open another archive** chooses the file's account, opens a new saved record when necessary, or previews an update to that account's existing record. Saving persists current and previous versions atomically. Cancel leaves both unchanged. **Undo last update** restores the prior version once and remains available after reload. Identical imports leave the current version and undo record untouched.

The two interfaces have independent browser storage. Download and import JSON to transfer updates. Opening the same `?url=` again fetches fresh data for review; it does not bypass review or blindly use cached data. HTTP(S) sources need normal browser CORS access. No personal JSON or credentials are bundled with the project.

## Scan modes and completeness

- **Full:** walks bookmark pagination and enumerates folders and their contents. The bookmark and folder phases have independent completion states.
- **Quick:** walks recent bookmark pages until a whole nonempty page contains already archived tweet IDs, or the timeline ends. It stores the boundary page, skips folders, and never treats the boundary as a complete bookmark scan. It can miss older changes, gaps, and folder moves. Use full refreshes regularly.
- **Partial:** user stop, account change, request failure, unrecognized response, or a pagination guard. Data already collected remains recoverable. Failed/unchecked folders cannot remove membership.
- **Unknown:** legacy files/runs without completeness metadata. Absence carries no removal meaning.

Normal pagination termination is evidence about the response stream, not proof that X supplied a complete account snapshot. The source can change while pagination is running. Looping cursors and repeated empty-page guards report partial coverage instead of claiming completion. The account is checked before and after requests so a detected session switch cannot store that response in the old account's scan.

Pause/Resume works while the options tab remains open. Closing it ends the running code. Collected pages and scan metadata survive; **Merge collected snapshot** recovers them after reopening. Collection does not resume from a persisted cursor. A new scan starts at the beginning and replaces staging data. Recover or download the staged snapshot before starting another scan if necessary.

## Merge rules

1. Validate the top-level structure, string tweet IDs, folder references, relevant field types, and supported schema version. Malformed input never replaces saved data.
2. Merge only matching known account IDs. Handles are display labels, not account identity. Unidentified files can be opened in an isolated viewer record but cannot merge with another archive or the extension.
3. Deduplicate by `tweet_id`. Retain all prior records absent from the input. Count added, refreshed, unchanged, and older retained records in the review/receipt.
4. Compare each record's observation date, not the date a combined file was downloaded. Availability and retained content have independent clocks: an August edit can update saved July text even if a September observation says unavailable. Older records can fill missing fields without reverting newer content or availability. Equal or missing dates do not authorize destructive replacement. Explicit unknown dates stay null across combined-file round trips.
5. Preserve the last saved text, media references, author and other content when a later response is a tombstone. Recovery of content does not imply the tweet is currently available. Files store media URLs, not media bytes.
6. Match folders by stable ID. Legacy names resolve to IDs only when the source folder list has an unambiguous match; otherwise a `legacy:` reference preserves the name. Newer folder names refresh display labels without duplicating the folder.
7. A complete folder scan can replace the known membership set. During partial scans, successful individual folder checks can add/remove that folder's assignment for observed bookmarks. Failed checks only add observed positive memberships; missing assignments remain. Per-folder observation dates prevent an older full scan from reverting a newer successful partial check. Bookmarks absent from the snapshot retain prior memberships.
8. Build the candidate before saving. The viewer indexes/renders a disposable copy under the review dialog before committing, preventing indexing errors from poisoning its saved archive. Browser-only index fields are never exported.

“Refreshed” includes updated observation dates even when the tweet text is unchanged. “Retained” means missing from this input, not proven deleted or unbookmarked. The viewer labels records whose last observation predates the most recent complete full refresh.

## JSON schema version 2

Existing `export_metadata`, `folders`, and `bookmarks` remain. Version 1 files require no manual conversion. New fields are additive:

```json
{
  "export_metadata": {
    "tool": "xarchive",
    "schema_version": 2,
    "kind": "snapshot",
    "user_id": "42",
    "screen_name": "example",
    "exported_at": "2026-09-04T18:00:00.000Z",
    "collection": {
      "mode": "full",
      "bookmarks": "complete",
      "folders": "partial",
      "folder_list": "complete",
      "folder_contents": { "folder-a": "complete", "folder-b": "partial" },
      "reason": "complete"
    }
  },
  "folders": [{ "id": "folder-a", "name": "Reading" }],
  "bookmarks": [{
    "tweet_id": "100",
    "status": "available",
    "full_text": "Saved text",
    "folders": ["Reading"],
    "folder_ids": ["folder-a"]
  }]
}
```

`collection.reason` records bookmark pagination's terminal reason (`complete`, `quick_boundary`, `user_stopped`, `pagination_guard`, `unrecognized_response`, an API error, `error`, or `tab_interrupted`). Consult the independent folder states too; `reason: complete` alone does not imply successful folder collection.

Combined downloads set `kind: cumulative`. `export_metadata.exported_at` is the latest source observation time, not download time; `collection` describes that latest source, not the entire accumulated archive. `stats` counts cumulative records. `archive_metadata.last_full_refresh_at` records the latest scan known to have completed both phases, or null.

Each cumulative bookmark adds `_archive`:

- `first_seen_at`, `last_seen_at`: earliest/latest source observations, not the date the user bookmarked the tweet.
- `content_updated_at`: the observation associated with retained content.
- `folders_updated_at`, `folders_complete`: timestamp and completeness of the base membership set.
- `folder_checks`: dated per-folder observations (`id`, `checked_at`, `present`, `complete`) that preserve successful partial checks across later merges and combined-file round trips.

Unknown dates remain null. Folder definitions add `observed_at` for rename ordering. Consumers can continue using `folders` names; updated consumers should use `folder_ids` for identity. Future schema versions are rejected with an upgrade message instead of being silently interpreted.

## Persistence and recovery

The original Dexie database, `xarchive`, stages a single scan's bookmarks, folder mappings and `run_info`. Its reset is transactional. The separate native IndexedDB database, `xarchive-library`, stores per-account current data, one previous version, and an increasing revision. The viewer migrates its original `xbm` cache without deleting the source cache.

Folder pages persist both their tweet content and membership mappings together. Tweets returned only by a folder remain in the snapshot even if the main timeline does not return them. Repeated pages are deduplicated during assembly/merge. Main and folder responses still have separate completeness states. Membership checks apply to bookmarks present in the combined scan results; missing historical records retain their prior memberships.

Imported media, link cards, metrics, authors, and observation metadata are validated before saving. The viewer allows only HTTP(S) links and media sources, escapes text, and never executes JSON values. This does not make the destinations trustworthy; clicking links or displaying media makes normal browser requests to those hosts.

Archive save and undo use one transaction. A revision comparison inside that transaction rejects stale writes from another tab. Failed or aborted writes keep current and previous data intact. The options page also uses a Web Lock to serialize scanning, recovering, and downloading staging data across tabs. Browser storage is local to its origin/profile; clearing it removes these copies. Download combined JSON for durable backups and transfers.

## Verification

Run `node --test tests/*.test.mjs` for merge, malformed input, account separation, per-folder chronology, cumulative round trips, pagination coverage, stop/account-switch behavior, and viewer indexing regressions. `tests/browser-storage.html` exercises actual IndexedDB persistence, undo, transaction aborts, stale revision rejection, validation, and account separation in a disposable database. Synthetic files in `tests/fixtures` support viewer import/review tests. `tests/extension-fixture.html` runs the real options UI with synthetic APIs, including folder failure and unexpected-response scenarios. These tests do not verify live X API behavior or Chrome extension permissions.
