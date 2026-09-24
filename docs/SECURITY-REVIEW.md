# Manifest V3 migration security review

Review date: 2026-09-24

## Scope and conclusion

Compared the original Manifest V2 source in commit `13da728` with the code
through `f56af8c`: the MV3 migration, the forced reauthorization fix in `bab9a61`,
and the incognito Go & Fill fix that replaces the extension bridge with a direct
HTTP/HTTPS redirect.

The review did not identify a demonstrated new password-exfiltration or
authentication-bypass path. It did identify security-relevant gaps in pending
navigation handling and metadata retention, plus a change in responsibility
for security updates. Follow-up navigation and retention fixes are recorded
below; they do not replace end-to-end browser and desktop verification.

This assessment is based on source comparison and synthetic checks using the
actual legacy bundle and service worker with mocked Chrome APIs. It is not an
end-to-end security audit of Chrome and the 1Password desktop app. No real
credentials were used in the synthetic checks, and no implementation changes
were made as part of the security review.

## 1. Pending Go & Fill requests can outlive their initiating navigation

**Status:** Fixed in commit [`eaf820e`](https://github.com/petejkim/1password-classic-chrome-extension/commit/eaf820e876fa1d81896161cb952b9c8570e453d9).

**Locations:** [`src/service-worker.js`](../src/service-worker.js),
`prepareBookmark`, `flushBookmarks`, `restoreState`, and the
`onDOMContentLoaded` listener.

Completion is associated with a tab ID rather than a particular navigation or
document. A later page load in the same tab can mark an older bookmark operation
complete. Pending operations can also survive worker restarts and wait for the
desktop transport to reconnect.

### Evidence and limits

A synthetic check performed this sequence:

1. Started a bookmark navigation to `https://saved.example/login` with a
   synthetic item ID while the desktop handshake was incomplete.
2. Navigated the same tab to `https://unrelated.example/` and delivered its DOM
   completion event.
3. Completed the mocked desktop handshake.

The worker sent the earlier `loginBookmarkLoaded` notification despite the
unrelated navigation. A subsequent check supplied `saved.example` as the
operation's allowed domain and invoked the legacy Go & Fill check for
`unrelated.example`. The existing domain check prevented form collection.

This demonstrates a stale bookmark notification, not password disclosure. The
concern is that a stale operation could cause unexpected filling on a domain
that passes the existing checks. Actual desktop behavior still needs manual
verification.

### Relationship to the original source

Tab-only matching partly predates the migration. The new session persistence
and deferred replay increase the lifetime and circumstances in which stale
operations can be acted upon. This is an amplified inherited weakness rather
than a demonstrated newly introduced domain-check bypass.

### Recommended hardening

- Bind an operation to its intended navigation/document, accounting for
  legitimate redirects.
- Cancel operations on abandoned or failed navigation and unrelated navigation
  in the same tab.
- Revalidate the current target and operation age before notifying the desktop
  or executing a fill, while retaining the existing domain checks.

### Implemented correction

Pending operations bind to Chrome's committed document ID and URL. A new
navigation after commit, failed navigation, history-state change, or fragment
change cancels the operation. Server redirects within a tracked navigation can
bind to the resulting document; ambiguous or restarted navigation sequences
cancel safely and may require retrying Go & Fill. Restoration rejects operations
that never committed or whose document has been replaced.

Before notifying the desktop, the worker checks the current document, pending
navigation, and operation age. It rechecks identity after asynchronous browser
calls. Credential-bearing messages are separately validated and addressed to
the exact Chrome document that supplied the collected fields. The legacy domain
checks remain in place.

`node --test tests/*.test.cjs` covers these cases, including a navigation change
during asynchronous bookmark/fill validation. These checks use mocked Chrome
APIs. Manually verify regular and incognito filling, subframe login forms,
redirecting login pages, cancellation, and worker restart before deployment.

## 2. Navigation metadata survives worker shutdown without guaranteed expiry

**Status:** Fixed in commit [`09bf73b`](https://github.com/petejkim/1password-classic-chrome-extension/commit/09bf73bfe5e8fe8d46ff09acc705f0bdf445a82e).

**Locations:** [`src/service-worker.js`](../src/service-worker.js), `persist`,
`restoreState`, and `flushBookmarks`.

The migration stores pending operation metadata in `chrome.storage.session`,
including item and vault identifiers, destination URLs, and operation context.
It does not intentionally persist password fields or full login objects.
However, complete URLs can themselves contain sensitive query parameters,
fragments, or embedded credentials.

The two-minute lifetime is checked when state is restored or bookmarks are
flushed. It is not a scheduled deletion deadline: records can remain beyond
two minutes if those paths do not run and no other cleanup removes them.

This storage is memory-only and is not exposed to content scripts by default.
Consequently, persistence here does not establish a new route for ordinary
websites to read the data. See
[Chrome's session storage documentation](https://developer.chrome.com/docs/extensions/reference/api/storage#session).

### Relationship to the original source

The original background page already held operation metadata in memory. The
migration adds a storage copy that survives service worker shutdown. The
concern is the additional retention and storage surface, not a change from
encrypted passwords to plaintext password storage.

### Recommended hardening

- Persist only the metadata required to safely resume an operation.
- Avoid retaining URL components containing secrets when they are not needed
  for target validation or navigation.
- Enforce expiry independently of successful filling and revalidate age at
  every use; browser scheduling delays should never make expired records usable.
- Preserve the default restriction on content-script access to session storage.

### Implemented correction

Session storage now contains only an allowlisted snapshot of an unsent bookmark
that has a committed document: schema version, creation time, item and vault
IDs, Chrome document ID, completion flag, and a SHA-256 fingerprint of the
normalized URL. Full URLs, userinfo, query strings, fragments, allowed-domain
lists, and desktop contexts are not copied to session storage. The fingerprint
supports exact target validation; it is not encryption or an anonymity guarantee.
Access is explicitly restricted to trusted extension contexts.

Snapshots are removed after desktop notification or cancellation. Uncommitted
bookmarks and desktop-initiated operations are not persisted. Restoration drops
old snapshot formats and verifies the document and URL fingerprint before
reconstructing the live operation from the current browser document. Operations
already handed to the desktop do not resume across worker restart; retrying may
be necessary.

A timer and a Chrome alarm schedule cleanup at the earliest two-minute deadline
for pending operations and collected-document routing metadata. Startup also
purges expired state. Browser suspension can delay physical cleanup, so expiry
is independently enforced during lookup, restoration, notification, credential
dispatch, and before asynchronous storage writes. Delayed work cannot extend an
operation's validity or write expired metadata back into session storage.

`node --test tests/*.test.cjs` includes checks for sensitive URL/context omission,
post-notification removal, timer and alarm cleanup without desktop connection,
expired/legacy snapshots, URL changes across restart, delayed hashing, and
credential dispatch when cleanup delivery is delayed. Manually verify normal
and incognito Go & Fill, redirects, and worker restart with the real browser
and desktop app.

## 3. Vendor security updates are no longer automatic

**Status:** Intentional operational tradeoff; maintenance responsibility.

**Location:** [`src/manifest.json`](../src/manifest.json), removal of the original
vendor `update_url` during migration.

The update URL was removed so the local MV3 build would not request the vendor's
MV2 updates. Security fixes for this fork must therefore be reviewed and applied
explicitly. Preserving the original extension identity does not make the local
modifications vendor-maintained or vendor-reviewed.

**Recommended:** Maintain an explicit process for reviewing relevant upstream
security fixes and updating the locally installed extension. No claim is made
that updates for the original legacy version remain available.

## Protections preserved by the changes

Source comparison confirmed the following:

- [`src/ext/sjcl.js`](../src/ext/sjcl.js) and
  [`src/injected.min.js`](../src/injected.min.js) are byte-for-byte unchanged
  from the original MV2 source.
- The cryptographic/authenticator implementation and domain-checked filling
  logic in [`src/global.min.js`](../src/global.min.js) are unchanged.
- HTTP/HTTPS host access, content-script matching, the manifest public key, and
  spanning incognito mode are unchanged.
- Forced reauthorization closes the existing connection and invokes the
  existing authentication setup; it does not directly mark a connection
  authenticated or bypass desktop authorization.
- The worker checks internal message senders against the extension ID.
- The current incognito fix removes the web-accessible extension bridge and its
  dedicated message handler, using a direct HTTP/HTTPS redirect instead.

These comparisons support the limited conclusion above. They do not establish
that the inherited cryptography, native helper, localhost WebSocket fallback,
or legacy filling behavior are independently free of vulnerabilities.
