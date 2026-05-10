#!/usr/bin/env bash
# Launch Chrome/Chromium with the remote-debugging port browser-eyes connects to.
# Uses a dedicated profile dir so it doesn't clobber your normal browser state,
# but you'll need to log into sites once inside this profile.
#
# Override defaults with env vars:
#   BROWSER_EYES_PORT     (default 9222)
#   BROWSER_EYES_PROFILE  (default ~/.browser-eyes-profile)
#   BROWSER_EYES_BIN      (path to Chrome binary, autodetected if unset)

set -euo pipefail

PORT="${BROWSER_EYES_PORT:-9222}"
PROFILE="${BROWSER_EYES_PROFILE:-$HOME/.browser-eyes-profile}"

CHROME="${BROWSER_EYES_BIN:-}"
if [ -z "$CHROME" ]; then
  for cand in google-chrome google-chrome-stable chromium chromium-browser \
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
              "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    if command -v "$cand" >/dev/null 2>&1 || [ -x "$cand" ]; then
      CHROME="$cand"
      break
    fi
  done
fi

if [ -z "$CHROME" ]; then
  echo "Could not find Chrome or Chromium on PATH." >&2
  echo "Set BROWSER_EYES_BIN to the binary path." >&2
  exit 1
fi

mkdir -p "$PROFILE"

echo "Launching Chrome with remote debugging:"
echo "  bin:     $CHROME"
echo "  port:    $PORT"
echo "  profile: $PROFILE"
echo

exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  "$@"
