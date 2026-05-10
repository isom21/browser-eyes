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

# Headless mode: explicit via BROWSER_EYES_HEADLESS=1, or auto-enabled when
# there's no display. Set BROWSER_EYES_HEADLESS=0 to force GUI mode.
HEADLESS="${BROWSER_EYES_HEADLESS:-auto}"
if [ "$HEADLESS" = "auto" ]; then
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ] && [ "$(uname)" != "Darwin" ]; then
    HEADLESS=1
  else
    HEADLESS=0
  fi
fi

HEADLESS_ARGS=()
if [ "$HEADLESS" = "1" ]; then
  # --headless=new is the post-2023 implementation, identical CDP surface to
  # full Chrome. --disable-dev-shm-usage avoids crashes on hosts where
  # /dev/shm is small (Docker default 64MB).
  HEADLESS_ARGS=(
    "--headless=new"
    "--disable-gpu"
    "--disable-dev-shm-usage"
    "--window-size=${BROWSER_EYES_WINDOW:-1280,800}"
  )
fi

# Resolve symlinks to detect snap-confined Chromium, which can only write
# inside ~/snap/chromium/common/ — using a profile elsewhere fails with
# "Failed to create .../SingletonLock: Permission denied".
RESOLVED="$(readlink -f "$(command -v "$CHROME" 2>/dev/null || echo "$CHROME")" 2>/dev/null || echo "$CHROME")"
IS_SNAP=0
case "$CHROME$RESOLVED" in
  *"/snap/"*) IS_SNAP=1 ;;
esac

if [ "$IS_SNAP" = 1 ]; then
  DEFAULT_PROFILE="$HOME/snap/chromium/common/browser-eyes-profile"
else
  DEFAULT_PROFILE="$HOME/.browser-eyes-profile"
fi
PROFILE="${BROWSER_EYES_PROFILE:-$DEFAULT_PROFILE}"

mkdir -p "$PROFILE"

echo "Launching Chrome with remote debugging:"
echo "  bin:      $CHROME"
[ "$IS_SNAP" = 1 ] && echo "  (snap-confined; profile pinned to snap-writable path)"
echo "  port:     $PORT"
echo "  profile:  $PROFILE"
echo "  headless: $([ "$HEADLESS" = 1 ] && echo yes || echo no)"
echo

exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  "${HEADLESS_ARGS[@]}" \
  "$@"
