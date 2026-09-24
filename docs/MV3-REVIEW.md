# Manifest V3 migration review

Reviewed commit: `b25e4af` — `feat: make extension work with manifest v3`

Review date: 2026-09-24

These findings come from static review of the migration and Chrome documentation.
The original findings were not reproduced in browser tests during review.
Follow-up fixes, automated checks, and user-reported verification are recorded
below.

## 1. [P1] Forced reauthorization is blocked by the connection guard

**Status:** Fixed. The user reported that the change seems to work after manual
testing; the specific scenarios exercised were not recorded.

**Location:** [`src/service-worker.js`](../src/service-worker.js), `Agent.connect`;
legacy authentication callbacks in [`src/global.min.js`](../src/global.min.js).

The new `Agent.connect` returns whenever `this.isConnected()` is true. In the
legacy implementation, this checks whether the transport is connected, not
whether authentication has succeeded.

The authenticator calls `Agent.connect(true)` after clearing credentials, such
as when handling an authentication `bad-mac` failure. The replacement ignores
that argument. If the existing port is still connected, it skips reconnecting
and leaves authentication recovery stalled until the transport is closed or
the extension is reloaded.

**Suggested correction:** Preserve an explicit forced reconnect path that
resets or replaces the existing transport and reloads authentication state,
while retaining the guard against ordinary overlapping connection attempts.

**Implemented correction:** `Agent.connect(true)` now closes a connected
transport before creating its replacement and reloading authentication state.
Ordinary calls still skip an existing connection, and all calls retain the
guards for desktop pause and native connection setup already in progress.

**Automated verification:** `node --test tests/reauthorization.test.cjs` passes
two regression tests against the actual legacy bundle and service worker with
mocked Chrome APIs. They cover a `bad-mac` failure followed by a fresh identifier
and handshake, closing the old port, preventing overlapping attempts, and
respecting desktop pause. JavaScript syntax and diff whitespace checks pass.

**Manual check:** Exercise reauthorization after a pairing/authentication failure
while the native port remains open. Confirm that authorization can restart and
filling recovers without reloading the extension.

## 2. [P2] Go & Fill bookmarks break in incognito

**Status:** Fix implemented; browser verification pending.

**Location:** [`src/go-and-fill-rules.json`](../src/go-and-fill-rules.json), redirect
action; [`src/service-worker.js`](../src/service-worker.js), navigation handlers.

The new declarative rule redirects Go & Fill navigations into
`go-and-fill.html`, an extension page. The manifest retains
`"incognito": "spanning"`.

Chrome blocks loading an extension page into the main frame of an incognito tab
under spanning mode. The previous implementation redirected directly to the
cleaned HTTP/HTTPS destination, so it did not encounter this restriction.
See [Chrome's incognito documentation](https://developer.chrome.com/docs/extensions/reference/manifest/incognito#spanning_mode).

**Suggested correction:** Provide an incognito-compatible navigation approach.
If switching to split mode, also account for its separate background contexts
and their native connections and authentication state.

**Implemented correction:** Retained spanning mode and its shared desktop
connection. The DNR rule now uses `queryTransform.removeParams` to redirect
directly to the website, removing the two bookmark parameters. The worker
tracks the item and vault IDs from `onBeforeNavigate` and notifies the desktop
after the page DOM is loaded and the transport is ready. Tracking and completion
both wait for worker initialization. The obsolete extension bridge and its
web-accessible-resource declaration were removed. See
[Chrome's query-transform documentation](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#type-QueryTransform).

**Automated verification:** `node --test tests/*.test.cjs` covers cold-worker
navigation/completion ordering, waiting for desktop connection, retaining query
parameters and fragments in operation metadata, worker restart, separate tab
records, and ignoring subframes and non-bookmark URLs. These are mocked worker
checks; actual Chrome redirects and incognito filling still need manual testing.

**Manual check:** Allow the extension in incognito, then open a legacy Go & Fill
bookmark in an incognito window. Confirm that the destination loads, the
bookmark parameters are removed, and the intended item fills. Repeat in a normal
window and with additional query parameters and a fragment. Keep worker DevTools
closed for a cold-start check.

## 3. [P2] The WebSocket fallback can lose its connection while idle

**Location:** [`src/service-worker.js`](../src/service-worker.js), the
`ConnectionDidEstablishConnection` listener;
legacy WebSocket transport in [`src/global.min.js`](../src/global.min.js).

The connection-established handler clears the reconnect alarm for both native
messaging and the legacy localhost WebSocket fallback. The fallback has no
heartbeat to keep the worker active.

A native messaging port keeps the service worker alive, but an idle WebSocket
does not provide the same guarantee: sending or receiving WebSocket messages
resets the idle timer. If fallback is used and no other activity occurs, worker
suspension can close the connection with no remaining alarm to restore it.
Desktop-initiated actions then lack a live transport until another browser
event wakes the worker. See
[Chrome's service worker lifecycle documentation](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle#chrome_116).

**Suggested correction:** Give the fallback an explicit lifecycle strategy,
such as a protocol-compatible heartbeat or a reliable reconnect wakeup mechanism.
Do not assume native messaging's keepalive behavior also applies to WebSockets.

**Manual check:** In a setup where the native host is unavailable and the
compatible WebSocket fallback connects, close worker DevTools and leave the
browser idle for more than 30 seconds. Then initiate an action from the desktop
app and check whether it reaches the extension without first interacting with
the browser.
