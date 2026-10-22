# Xkeeps

Find and reuse your saved X posts. Archive bookmarks and likes locally, search them, and export files for offline reading.

[Website and installation](https://xkeeps.jinhanai.com/) · [中文说明](README.zh-CN.md) · [Privacy](docs/privacy.md) · [JinHanAI](https://www.jinhanai.com/) · [Author on X](https://x.com/AIJinHan)

Maintained by **JinHanAI**, built on [xarchive](https://github.com/sytelus/xarchive). Independent project, not affiliated with X. The official website lists currently available distribution channels; do not assume a store listing is live from this repository alone.

## What it does

- Keeps bookmarks and likes separately, with archives isolated by X account.
- Searches saved content by keyword, author and date.
- Exports JSON for backup/import, CSV for spreadsheets and Markdown for reading.
- Creates ZIP archives with a reader and selected, successfully downloaded media.
- Offers English and Chinese interfaces; export labels follow the selected language while post text remains unchanged.

## Install for free

Use desktop Chrome 120 or later. No Node.js or build step is required to use the extension.

1. Open this repository's **Releases** page and download `Xkeeps-v0.9.2-local.zip` from Assets. GitHub's automatically generated source archives are for developers.
2. Extract it into a folder you will keep.
3. Open `chrome://extensions/`, enable Developer mode, and choose **Load unpacked**.
4. Select `Xkeeps-v0.9.2-local`, the folder directly containing `manifest.json`.
5. Sign in to your own X account in the same browser and open X once. Open Xkeeps from the extension toolbar and confirm the connected account.

To run from source, load the repository root instead. A GitHub release ZIP is a manual installation and does not receive Chrome Web Store automatic updates.

## First export and updates

Choose Bookmarks or Likes, update the archive, then export. **Latest collection** contains the latest run's observations, including existing items. **All saved content** includes the accumulated history. Bookmarks and likes require separate JSON backups; CSV and Markdown cannot restore archives.

Before updating, finish active tasks and export both cumulative JSON archives. Keep the same unpacked folder and extension identity when reloading a local version. A store installation or a different extension ID has separate storage: import and compare both JSON archives there before removing the old installation. Never assume automatic migration.

## Privacy and limits

Archives and usage events are stored locally; there is no developer upload endpoint for them. Fetching posts uses your local X session and sends requests to X. Media previews and downloads contact their hosts. Session information in browser storage and exported files are sensitive; local storage is not an encrypted vault.

X's interfaces, login state and rate limits can change. A completed operation does not guarantee retrieval of every historical post. Offline media must have downloaded successfully. Optional scheduled checks require Chrome to be running and are not an always-on backup service. See [privacy and permissions](docs/privacy.md).

## Development

Node.js 24 and the system `zip` command are used for tests and packaging. No npm packages are required.

```sh
node --test tests/*.test.mjs
node scripts/package-local.mjs
node scripts/package-local.mjs --store
```

Packaging uses an explicit file list. Local packages have one top-level folder; store packages have `manifest.json` at their root. Browser fixtures use synthetic examples. Automated checks do not prove a real X account or store installation works. See [maintenance](docs/maintenance.md), [contributing](CONTRIBUTING.md) and [security reports](SECURITY.md).

## License and credits

MIT; the original xarchive copyright and license are retained in [LICENSE](LICENSE). Xkeeps improvements are maintained by JinHanAI. Dexie.js and its bundled helper notices are preserved in [third-party notices](docs/third-party-notices.md). Brand names identify the project and maintainer; they do not imply endorsement of third-party forks. This does not add restrictions to the MIT code license.
