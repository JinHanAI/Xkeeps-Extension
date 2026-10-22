# Development and maintenance

Run `node --test tests/*.test.mjs` with Node.js 24. No dependency installation is required.
Build a Chrome Web Store ZIP with `node scripts/package-local.mjs --store`.
The extension itself loads directly from this directory in desktop Chrome 120+.
Use disposable synthetic data for local browser fixtures. Automated tests do not authenticate to X.
Before uninstalling or changing the extension ID/profile, export bookmarks and likes separately as cumulative JSON, import and compare them in the new installation, and keep the old installation until verified.
