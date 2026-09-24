# 1Password Classic Chrome Extension with Manifest V3 Support

An unofficial Manifest V3 port of the classic 1Password browser extension for use with the **1Password 7 desktop app**. It requires **Chrome/Chromium 120 or newer** and a compatible desktop helper.

## Changes

- Migrated the extension from Manifest V2 to Manifest V3, including a background service worker and updated Chrome APIs.
- Fixed forced desktop reauthorization after authentication failures.
- Updated Go & Fill bookmarks to support incognito windows while retaining a shared desktop connection.
- Bound pending fills and credential delivery to their initiating browser documents, canceling stale operations after navigation.
- Reduced temporary session storage to essential pending-bookmark metadata, restricted access to trusted extension contexts, and added a two-minute expiration period with cleanup.
- Preserved the original extension ID and legacy authentication and filling logic.

## Installation

1. Download the extension ZIP file from the [latest release](https://github.com/petejkim/1password-classic-chrome-extension/releases/latest).
2. Extract the ZIP into a permanent folder. `manifest.json` must be directly inside the folder you select below.
3. On macOS, open the extracted folder in Finder, open its `scripts` folder, and double-click **`register-chrome-native-host.command`**. Terminal opens and runs the script to register the 1Password 7 native messaging host with Google Chrome.

   The script checks for the helper in `/Applications/1Password 7.app` and leaves existing registrations untouched. Read the result in Terminal and resolve any reported errors before continuing. This script is for macOS only and does not require `sudo`.

4. Open 1Password 7, then open `chrome://extensions` and enable **Developer mode**.
5. Disable the old extension, then click **Load unpacked** and select the extracted folder. Chrome cannot load the ZIP directly. If an existing copy with the same extension ID prevents installation, remove that copy first. This clears its stored authorization and may require pairing again. If you already loaded this extension before running the registration script, click **Reload** instead.
6. Click the 1Password toolbar button and complete desktop authorization if prompted.
7. For incognito use, enable **Allow in incognito** in the extension's details.

Keep the extracted folder in place after installation. This unpacked build does not receive automatic vendor updates; install future releases manually.

## Credits

The original 1Password Classic extension was developed by AgileBits (1Password). OpenAI's Codex carried out the Manifest V3 migration, follow-up fixes, security review, automated regression tests, and documentation under the repository maintainer's direction. Manual browser testing was performed by the maintainer.
