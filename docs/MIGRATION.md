# Local Manifest V3 migration

This directory is the migrated extension. Requires Chrome/Chromium 120 or
newer and a compatible 1Password desktop application/helper.

## Load it

1. Open `chrome://extensions` (or `brave://extensions` in Brave).
2. Enable **Developer mode**.
3. Disable the old copy if it is still installed, then choose **Load unpacked**
   and select this directory. If the old installed extension prevents loading
   another copy with the same ID, remove the old extension first. Removing an
   extension clears its stored authorization, so desktop pairing may be needed.
4. Click the 1Password toolbar button and complete any desktop authorization.

The manifest public key is preserved. The expected extension ID is
`phicbbndgmmpogmijjkbmdhpioaieaha`.

The Chrome native host configuration found on this machine already includes
that extension ID in its allowed origins. Browser-specific native host setup
and desktop authorization still apply.

## Changes

- `manifest.json`: Manifest V3, action API, service worker, separated host
  permissions, navigation/alarms/declarative redirect permissions. Removed the
  legacy vendor update URL so this local build does not request MV2 updates.
- `global.min.js`: replaced background `window` references, guarded overlapping
  native connection attempts, reset disconnected native ports, and removed the
  old Chrome event setup. The original authentication and filling code remains.
- `service-worker.js`: synchronous Chrome event registration, MV3 context menu,
  native connection setup, retry wakeup alarm, and minimal session snapshots for
  unsent bookmarks bound to committed documents. Snapshots contain item/vault
  IDs, Chrome document ID, creation time, completion state, and a URL fingerprint.
  Full URLs, desktop contexts, password values, and in-flight filling callbacks
  are not persisted. A worker restart reconnects and authenticates the desktop
  transport. Operations already sent to the desktop require a retry after restart.
- Go & Fill operations bind to the committed document. Abandoned navigations,
  history/fragment changes, and expired operations are canceled. Pending state
  can resume only when its committed document still matches. Credential messages
  target the Chrome document that supplied the fields. Ambiguous redirect or
  restarted navigation sequences cancel safely and may require a retry.
- Pending operations and collected-document routing metadata have a two-minute
  deadline, with timer/alarm cleanup and startup purging. Expiry checks at use
  and storage-write time reject stale work even if browser suspension delays
  cleanup. Session storage access is restricted to trusted extension contexts.
- `go-and-fill-rules.json`: replaces the blocking webRequest redirect. GET
  navigations containing a nonempty `onepasswdfill` parameter redirect directly
  to the website with `onepasswdfill` and `onepasswdvault` removed. The worker
  records the item and vault IDs from the original top-level navigation event.
  Other query parameters and the fragment are retained. No extension bridge
  page is needed, so the same path supports normal and incognito tabs while
  keeping a single shared background connection (`"incognito": "spanning"`).
- Removed the obsolete bridge page and its web-accessible-resource declaration.
  Chrome-generated `_metadata` ruleset files are ignored in version control;
  `go-and-fill-rules.json` is the rule source.
- Manifest version is `4.7.5.91`; the desktop protocol still identifies itself
  as `4.7.5`, matching the original bundle.

## Browser testing

Run `node --test tests/*.test.cjs` for the mocked service worker regression
checks. These exercise the legacy bundle and worker but do not run Chrome's
redirect engine or the real desktop app. Browser testing remains manual.

Check toolbar and context-menu opening, desktop pairing/unlocking, filling and
saving on a disposable login page, and a legacy Go & Fill bookmark. For the bookmark, check that ordinary query parameters and a URL fragment survive, `onepasswdfill`/`onepasswdvault` are removed, and the intended item fills. Also
check multiple bookmark tabs and reconnecting after quitting/reopening the
desktop app or restarting the browser.

For incognito Go & Fill, reload the extension and enable **Allow in incognito**
in its extension details. Open a bookmark in an incognito window and verify
that it stays in that window, opens the cleaned destination, and fills the
intended item. Repeat in a normal window, including bookmarks with additional
query parameters and fragments. Test with service worker DevTools closed as
well, so a cold worker can exercise navigation tracking during initialization.

For failures, use the extension's **Errors** button and the **service worker**
inspection link on the extensions page. Record the error text and the action
that produced it; do not include passwords or native message payloads.

## Chrome references

- https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest
- https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
