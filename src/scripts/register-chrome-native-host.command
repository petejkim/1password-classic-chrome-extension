#!/bin/sh
# Register the installed 1Password 7 helper for this extension in Google Chrome.
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS only." >&2
  exit 1
fi

helper="/Applications/1Password 7.app/Contents/Library/LoginItems/1Password Extension Helper.app/Contents/MacOS/1PasswordNativeMessageHost"
host_name="2bua8c4s2c.com.agilebits.1password"
host_dir="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
manifest="$host_dir/$host_name.json"
system_manifest="/Library/Google/Chrome/NativeMessagingHosts/$host_name.json"

for existing in "$manifest" "$system_manifest"; do
  if [ -e "$existing" ] || [ -L "$existing" ]; then
    printf 'Registration already exists; no changes made:\n%s\n' "$existing"
    echo "If the connection still fails, check this file and the service worker's native messaging error."
    exit 0
  fi
done

if [ ! -x "$helper" ]; then
  printf '1Password 7 helper not found or not executable:\n%s\n' "$helper" >&2
  echo "Check that 1Password 7 is installed in /Applications." >&2
  exit 1
fi

mkdir -p "$host_dir"
# Refuse to overwrite a registration created since the check above.
set -C
cat > "$manifest" <<EOF
{
  "name": "$host_name",
  "description": "1Password Extension",
  "path": "$helper",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://phicbbndgmmpogmijjkbmdhpioaieaha/"
  ]
}
EOF

printf 'Chrome native messaging registration created:\n%s\n' "$manifest"
echo "Open 1Password 7, reload the extension at chrome://extensions, then click its toolbar button."
