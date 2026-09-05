# Maintenance, troubleshooting and releases

## Development checks

No build or package installation is needed. Use Node.js 24:

```sh
node --test tests/*.test.mjs
git diff --check
```

CI runs these checks on Windows and Linux. Unit tests use synthetic data; no test authenticates to X. Check syntax for any changed modules with `node --check path/to/file.js`. Browser fixture tests are manual and are not currently part of CI.

Serve the repository from an unused localhost port to isolate test storage from real archives:

```sh
python -m http.server 8000 --bind 127.0.0.1
```

- Open `/tests/browser-storage.html` for disposable native IndexedDB save, undo, revision and transaction checks.
- Open `/viewer.html?url=tests/fixtures/base.json`, review and save, then open `?url=tests/fixtures/update.json`. Expect one added bookmark, one refreshed bookmark and one retained older bookmark. Repeat the import for no changes; review Undo and verify the prior two-bookmark archive returns after reload.
- Open `/tests/extension-fixture.html` for the actual options UI backed by synthetic Chrome/X APIs. Full refresh collects synthetic folder/main results. Quick update then stops at known records and keeps folders. Try `?scenario=folder-error` and `?scenario=bad-response`; expect explicit incomplete coverage and retention. `?account=43` checks account separation.
- Check a narrow viewport, folder controls, keyboard navigation, media loading/error layouts and browser console errors. Node tests exercise actual `File` objects; separately test native selection and drag/drop in a supported browser.

The extension fixture and viewer share storage on the test origin. The installed extension and a standalone viewer have different origins and independent archives. Never serve personal archive files from a public development server or add them to test fixtures.

## Troubleshooting

| Symptom | Next action and expected outcome |
|---|---|
| No account detected | Sign in on `x.com`. Identity comes from its current cookie; a stale stored handle cannot authorize a scan. |
| HTTP 400, 404 or 422 | Click **Refresh X connection**, then retry. It discovers current request IDs/settings without changing the archive. If rejection persists, report the status and operation; the private API may need a parser/request update. |
| HTTP 401/403 | Refresh your X session, visit bookmarks and refresh the connection. Saved content remains intact. |
| Repeated rate limits | Stop and try later. Collection backs off and eventually reports incomplete coverage. No pacing can guarantee acceptance by X. |
| Folder checks incomplete | Visit a folder on X, refresh the connection and run Full refresh. Unchecked assignments remain saved. |
| Another tab changed the archive | Cancel the review and reload to obtain its current revision. Reimport or recover the staged snapshot. |
| Save/quota error | Keep the old archive. Download the staged snapshot in the extension, and preserve source JSON files in the viewer. Free browser storage or use another profile before retrying. |
| Closed tab during scanning | Reopen the extension and merge/download the collected snapshot before starting another scan. Resume only works in a still-open tab. |
| Hosted JSON cannot load | Verify the exact URL and CORS settings, or use file import. An explicit URL is fetched again for review. |
| Missing images/video | The archive stores remote URLs, not media files. Hosts can remove or restrict them. Text and saved records remain. |

Issue reports should include extension/browser versions, action taken, terminal status, and a sanitized minimal example where needed. Exclude cookies, auth headers, private post text and account identifiers. The public web-application bearer constant in `lib/api.js` is not a personal session token.

## Release checklist

1. Update `manifest.json` and `version.js` together. No automatic Git hook updates them. Schema changes require migration tests and updates to `incremental-archives.md` independently of the application version.
2. Run the automated checks and relevant browser fixtures. For private API changes, validate the unpacked extension with a real session and review main/folder counts, stop/recovery and account switching before describing compatibility as verified.
3. Review the intended file list for personal exports/secrets and inspect the diff. Normal `xarchive_*.json` exports are ignored; synthetic fixtures are named explicitly.
4. Commit and push the reviewed paths. Verify the local, tracking and remote commit IDs match. A Git push does not by itself create a GitHub release or reload the user's installed extension.
5. Users reload the unpacked extension in `chrome://extensions/`. Keep combined JSON backups before browser/profile changes. Host-permission changes may need Chrome's acknowledgement.

## Dependency policy

Keep vendored dependencies minimal. Before replacing Dexie, verify the upstream version, distribution hash, license and compatibility with existing staging databases, then run the storage/browser checks. Do not edit the vendored bundle to patch application behavior. See [third-party-notices.md](third-party-notices.md).
