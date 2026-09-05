# Third-party notices

Project-authored code is licensed under the root [MIT license](../LICENSE).

`vendor/dexie.mjs` is Dexie.js 4.0.11 by David Fahlander and contributors, distributed under [Apache License 2.0](../vendor/DEXIE-LICENSE). Its existing file header also includes the Microsoft helper-code permission notice; retain both notices when redistributing the bundle.

- Project: [Dexie.js](https://github.com/dexie/Dexie.js)
- Versioned distribution: [dexie@4.0.11/dist/dexie.mjs](https://unpkg.com/dexie@4.0.11/dist/dexie.mjs)
- Upstream license: [v4.0.11 LICENSE](https://github.com/dexie/Dexie.js/blob/v4.0.11/LICENSE)
- Verified SHA-256: `1da361f2a2ff3b17fd2747dffa011ff9053f952f6fcbcea50f0159f5315f4cb5`

The vendored module matched this upstream distribution during the incremental-archive review. There is no runtime package download or npm installation.

The additional `abs.twimg.com` host permission supports reading X's JavaScript bundles for query discovery. Chrome requires declared host access for extension-origin cross-origin requests; see [Chrome's network request documentation](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests). Downloaded bundle text is parsed for IDs and never executed.
