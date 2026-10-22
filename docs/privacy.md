# Privacy and permissions

Xkeeps 0.9.2 stores account-separated archives in IndexedDB and session connection information in Chrome local storage. It does not send archives or local usage events to the developer. Exported JSON, CSV, Markdown and ZIP files remain wherever you save or share them.

| Access | Purpose |
| --- | --- |
| storage / unlimitedStorage | Local settings and archives |
| cookies / webRequest | Read the current X session and capture relevant authentication headers and query IDs |
| declarativeNetRequestWithHostAccess | Add required headers to this extension's X requests |
| downloads | Save files you select |
| x.com / twitter.com | Fetch content visible to your signed-in account |
| abs.twimg.com | Read public bundle text to discover query IDs; downloaded code is not executed |
| Optional alarms | Scheduled checks when enabled |
| Optional pbs.twimg.com / video.twimg.com | Media previews and selected downloads |

X receives the authentication needed for its requests. Media requests contact the relevant hosts; opening an external online archive also contacts its server. External author/support links have their own privacy policies. The website has a separate, consent-based analytics policy; website visits are not extension usage telemetry.

Local usage events exclude post text, account IDs, search terms and local paths. On each new event write, entries older than 90 days are removed and the list is capped at 5,000 events. Without another write, older entries may remain. Events can be viewed, exported or cleared in Settings. Removing an archive or uninstalling the extension does not delete files already exported to disk. Back up bookmarks and likes before uninstalling or changing browser profiles or extension identities.

Do not publish cookies, authorization headers, personal account IDs or complete private archives in issues. Use the private contact entry on the [maintainer website](https://www.jinhanai.com/#email-link) for security reports. This software does not provide an encrypted vault or guarantee complete retrieval from X.
