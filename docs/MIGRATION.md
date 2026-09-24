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
`phicbbndgmmpogmijjkbmdhpioaieaha`. The static Go & Fill rule uses that ID;
changing the key requires updating `go-and-fill-rules.json` as well.

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
  native connection setup, retry wakeup alarm, and session storage for pending
  navigation metadata. Pending navigation records expire after two minutes;
  password values and in-flight filling callbacks are not persisted. A worker
  restart reconnects and authenticates the desktop transport.
- `go-and-fill-rules.json`, `go-and-fill.html`, `go-and-fill.js`: replace the
  blocking webRequest redirect. GET navigations containing a nonempty
  `onepasswdfill` parameter visit the extension bridge, which records the item
  and vault IDs before navigating to the cleaned URL. Top-level navigation
  events preserve the original fragment when omitted from network matching.
- Manifest version is `4.7.5.91`; the desktop protocol still identifies itself
  as `4.7.5`, matching the original bundle.

## Browser testing

JavaScript syntax, JSON, manifest fields, and referenced package files were
checked. Browser behavior and desktop integration have not been tested.

Check toolbar and context-menu opening, desktop pairing/unlocking, filling and
saving on a disposable login page, and a legacy Go & Fill bookmark. For the bookmark, check that ordinary query parameters and a URL fragment survive, `onepasswdfill`/`onepasswdvault` are removed, and the intended item fills. Also
check multiple bookmark tabs and reconnecting after quitting/reopening the
desktop app or restarting the browser.

For failures, use the extension's **Errors** button and the **service worker**
inspection link on the extensions page. Record the error text and the action
that produced it; do not include passwords or native message payloads.

## Chrome references

- https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers
- https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest
- https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
