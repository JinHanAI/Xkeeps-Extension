# Review findings and evidence

This describes the repository review for the incremental-archive release. The original third-party research, example endpoints, star counts and exploratory techniques remain in [Git history](https://github.com/sytelus/xarchive/blob/e74d04115f9df07b3589f71f9886b33ed34f62b1/FINDINGS.md). Those historical observations are not current API guarantees or implementation instructions.

## Contribution path

The repository's Issues feature was enabled during the initial project investigation. GitHub showed issue creation allowed for all users, and the new-issue form opened. No setting change was needed. The repository now includes structured bug and feature templates so reports identify the relevant workflow and avoid sharing private archives or credentials. GitHub feature permissions are repository settings; templates alone do not enable Issues.

## Findings addressed

| Finding | Resulting behavior |
|---|---|
| Each new export cleared the only staging data; viewer imports replaced one cache | Separate cumulative archives retain history, with reviewed imports and persistent undo |
| Viewer ignored documented URL input and requested a fixed filename | Explicit HTTP(S) URL input is fetched for review; cache reload and file updates are separate actions |
| Undated folder/record observations gained dates during combined-file normalization | Explicit null timestamps survive round trips |
| A later tombstone blocked recovery of an intermediate saved edit | Content and availability use independent observation dates |
| Folder pages could be discarded if the main timeline omitted a tweet or a later request failed | Each folder page persists its content and membership together |
| Unknown response shapes and pagination guards could appear complete | Unsupported shapes, cursor loops and no-progress guards report partial coverage |
| Null visibility wrappers could throw | Unavailable IDs are retained, including nested quoted-post wrappers |
| Retry waits ignored Pause/Stop; thrown network failures skipped retries | Every retry checks controls, waits are interruptible, network/body requests have a timeout |
| Arbitrary mutation of captured transaction IDs; query extraction guessed by capitalization/proximity | Captured IDs are replayed unchanged; query extraction requires explicit operation/ID structure |
| Query discovery lacked bundle-host permission and could fetch arbitrary hosts found in HTML | Only X/its declared asset host are fetched; bundle requests omit credentials and never execute code |
| Global stored identity/handle and overlapping credential writes could drift across accounts | Actual cookie identity, account-scoped display labels and serialized credential updates |
| Viewer embedded untrusted URL/text values in HTML and rewrote generated links | HTTP(S) URL checks, escaped text, single-pass linkification, typed import validation and DOM error handlers |
| Folder names collided, including an internal Unfiled label | Folder identity uses IDs; internal Unfiled state is distinct, with keyboard-accessible controls |
| Search omitted expanded URLs and non-Latin text; card heights changed after media loaded | Expanded URLs/Unicode search and visible-card size observation |
| Reopening staging used a racy lock query | Recovery inspection runs under the same staging lock as scans and downloads |
| Chrome download errors were reported as success | Failure/cancellation is surfaced; the UI distinguishes a requested download from completion |
| Version docs claimed a nonexistent automatic hook; Dexie's full license was absent | Explicit synchronized release versions, configuration tests and third-party notices |

## Verification boundaries

Node tests use synthetic fixtures and cover merge chronology, data validation, request behavior, account separation, parser shapes, viewer rendering/search, import/save/undo failures and configuration consistency. Browser fixtures exercise real IndexedDB, the options UI and viewer workflows on a local test origin. See [maintenance.md](docs/maintenance.md) to reproduce them.

Vendored `dexie.mjs` was compared byte-for-byte by SHA-256 with the published Dexie 4.0.11 distribution; the hash and attribution are recorded in [third-party-notices.md](docs/third-party-notices.md). Application icons and preview art are static assets; none contains bookmark data.

A live X collection, real Chrome extension permission installation, and every native file-picker/browser combination require separate manual verification. Private endpoint compatibility, source completeness, account restrictions and remote media availability cannot be inferred from the regression suite. Conservative pacing reduces request volume; it is not an account-safety guarantee.
