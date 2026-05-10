#!/usr/bin/env bash
# Launch Chrome/Chromium with the remote-debugging port browser-eyes connects to.
# Uses a dedicated profile dir so it doesn't clobber your normal browser state,
# but you'll need to log into sites once inside this profile.
#
# Usage:
#   start-chrome.sh                start in the background (default)
#   start-chrome.sh --foreground   keep Chrome attached to this terminal
#   start-chrome.sh --stop         stop the Chrome we previously started
#   start-chrome.sh --status       report whether our Chrome is running
#
# Env vars:
#   BROWSER_EYES_PORT      (default 9222)
#   BROWSER_EYES_PROFILE   (default ~/.browser-eyes-profile, or snap path)
#   BROWSER_EYES_BIN       (path to Chrome binary, autodetected if unset)
#   BROWSER_EYES_HEADLESS  (0 = GUI, 1 = headless, auto = based on $DISPLAY)
#   BROWSER_EYES_WINDOW    (window size in headless mode, default 1280,800)
#   BROWSER_EYES_LOG       (log file in background mode, default $PROFILE/chrome.log)

set -euo pipefail

MODE=background
while [ "$#" -gt 0 ]; do
  case "$1" in
    --foreground|-F) MODE=foreground; shift ;;
    --stop|-S)       MODE=stop; shift ;;
    --status)        MODE=status; shift ;;
    --help|-h)       sed -n '2,18p; 18q' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --) shift; break ;;
    -*) echo "Unknown flag: $1" >&2; exit 2 ;;
    *)  break ;;
  esac
done

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

PID_FILE="$PROFILE/.browser-eyes.pid"
LOG="${BROWSER_EYES_LOG:-$PROFILE/chrome.log}"

pid_alive() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null; }
port_ready() { curl -sf --max-time 1 "http://localhost:$PORT/json/version" >/dev/null 2>&1; }

if [ "$MODE" = "stop" ]; then
  if pid_alive; then
    PID="$(cat "$PID_FILE")"
    kill "$PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "Stopped Chrome (pid $PID)."
  else
    rm -f "$PID_FILE"
    if pkill -f -- "--remote-debugging-port=$PORT" 2>/dev/null; then
      echo "Stopped Chrome via pkill (no pidfile)."
    else
      echo "Nothing to stop on :$PORT."
    fi
  fi
  exit 0
fi

if [ "$MODE" = "status" ]; then
  if pid_alive && port_ready; then
    echo "Running: pid $(cat "$PID_FILE"), CDP at localhost:$PORT"
    exit 0
  elif pid_alive; then
    echo "Process alive (pid $(cat "$PID_FILE")) but CDP not responding on :$PORT"
    exit 1
  else
    echo "Not running."
    rm -f "$PID_FILE" 2>/dev/null || true
    exit 1
  fi
fi

if port_ready; then
  if pid_alive; then
    echo "Already running (pid $(cat "$PID_FILE")); CDP at localhost:$PORT" >&2
    echo "Stop with: $(basename "$0") --stop" >&2
  else
    echo "Something else is already listening on :$PORT." >&2
    echo "Stop it, or set BROWSER_EYES_PORT to another port." >&2
  fi
  exit 1
fi

CHROME_ARGS=(
  --remote-debugging-port="$PORT"
  --user-data-dir="$PROFILE"
  --no-first-run
  --no-default-browser-check
  "${HEADLESS_ARGS[@]}"
  "$@"
)

echo "Launching Chrome with remote debugging:"
echo "  bin:      $CHROME"
[ "$IS_SNAP" = 1 ] && echo "  (snap-confined; profile pinned to snap-writable path)"
echo "  port:     $PORT"
echo "  profile:  $PROFILE"
echo "  headless: $([ "$HEADLESS" = 1 ] && echo yes || echo no)"
echo "  mode:     $MODE"

if [ "$MODE" = "foreground" ]; then
  echo
  exec "$CHROME" "${CHROME_ARGS[@]}"
fi

echo "  log:      $LOG"

# Detach: nohup ignores SIGHUP, redirects free us from the controlling tty,
# disown removes the job from the shell's table.
nohup "$CHROME" "${CHROME_ARGS[@]}" >"$LOG" 2>&1 </dev/null &
PID=$!
disown "$PID" 2>/dev/null || true
echo "$PID" >"$PID_FILE"

for _ in $(seq 1 30); do
  if port_ready; then
    echo
    echo "Chrome running in background (pid $PID); CDP at localhost:$PORT"
    echo "Stop with: $(basename "$0") --stop  (or: kill $PID)"
    echo "Log:       $LOG"
    exit 0
  fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.2
done

echo >&2
if kill -0 "$PID" 2>/dev/null; then
  echo "Chrome started (pid $PID) but CDP isn't responding on :$PORT after 6s." >&2
else
  echo "Chrome exited during startup." >&2
fi
echo "Tail the log: tail -n 50 $LOG" >&2
exit 1
