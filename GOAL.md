# Project goal

xarchive helps a signed-in X user keep a portable, cumulative JSON archive of their bookmarks and folder assignments, including available text, author details, media URLs and other returned metadata.

Reliability means preserving collected and previously saved data, making incomplete or unknown coverage visible, and allowing recovery after an interruption. It does not mean claiming that the private API has returned every bookmark.

Repeated full refreshes and explicitly limited quick updates must remain understandable: show what will be checked, progress while working, what was saved, and how to transfer or recover it. Accounts stay separate. The viewer previews imports, retains history, supports one persistent undo step, and downloads combined backups.

See [README.md](README.md) for usage and [docs/incremental-archives.md](docs/incremental-archives.md) for the data contract.
