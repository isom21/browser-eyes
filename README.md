# browser-eyes

A small MCP server that gives Claude Code one-shot access to the live state of
your Chrome tab — screenshot + URL + recent console messages + recent failed
network requests, all from a single tool call.

It's the "step 1 + step 2" combo from the
[chat that spawned this project](#background): no more manually screenshotting
and pasting; the agent just calls `look` whenever it wants to see what you see.

## What it gives the agent

| Tool | What it does |
|------|-----|
| `look` | Returns a screenshot (image) + URL + title + recent console + recent network errors. The default thing the agent should call. |
| `navigate` | Drive the browser to a URL. Waits for the page load event. Essential in headless mode since there's no UI. |
| `eval_js` | Run a JS expression in the active tab and return the result. Top-level `await` works. |
| `list_tabs` | List open Chrome tabs. |
| `select_tab` | Switch which tab the MCP is attached to. |
| `clear_buffers` | Reset the console & network-error buffers. Useful before "click X then look". |
| `close_browser` | Stop the Chrome the MCP spawned (no-op if Chrome was started externally). |

The MCP keeps a rolling 200-entry buffer of console output and network errors
in memory, so when the agent calls `look` it sees what *happened*, not just
what's currently on screen.

## Setup

```bash
cd ~/browser-eyes
npm install
npm run build
```

Then register with Claude Code:

```bash
claude mcp add browser-eyes node ~/browser-eyes/dist/index.js
```

(Use `--scope user` to make it available across all projects.)

### How the agent should use it

Hint Claude Code, e.g. via project `CLAUDE.md`:

> When working on the web UI, use the `look` tool from the `browser-eyes` MCP
> to see the current state of my browser. Call it after each visible change
> and whenever you suspect a console error.

That single nudge is usually enough; the tool description tells Claude what
each call returns.

## Running Chrome

**The MCP manages Chrome's lifecycle automatically.** On the first tool
call it checks whether CDP is reachable; if not, it spawns Chrome via
`bin/start-chrome.sh` (headless on dev hosts, GUI on desktops). When the
MCP shuts down — Claude Code exits, conversation ends, signal received —
it stops Chrome again. So in most cases you can just register the MCP
and forget Chrome exists.

```bash
# (after npm install && npm run build)
claude mcp add browser-eyes node ~/browser-eyes/dist/index.js
# done — the agent's first look/navigate call will spawn Chrome
```

The MCP only stops a Chrome it spawned itself. If you started Chrome
manually (e.g. via `bin/start-chrome.sh`) the MCP attaches to that one
and leaves it running on shutdown. The `close_browser` tool lets the
agent end the spawned Chrome early; it's a no-op against an externally-
managed Chrome.

To disable auto-spawn (and require Chrome to be already running), set
`BROWSER_EYES_AUTO_SPAWN=0`.

### Manual launching

You can still drive Chrome yourself with the included helper — useful for
debugging, or for a long-running Chrome you want to keep across many
Claude Code sessions:

```bash
~/browser-eyes/bin/start-chrome.sh
```

This launches Chrome on port `9222` with a dedicated profile at
`~/.browser-eyes-profile` (or `~/snap/chromium/common/browser-eyes-profile`
when snap-Chromium is detected — see below). First launch is empty — log in
to whatever sites you need; the profile persists across runs.

If you'd rather use your normal Chrome, fully quit it and relaunch with
`--remote-debugging-port=9222`. **Don't expose this port to the internet** —
it gives full control of your browser. Localhost only.

The launcher backgrounds Chrome by default, redirects all of Chrome's
noisy output to a logfile, and returns control to your shell as soon as
the debug port is reachable. Useful flags:

| Flag | Effect |
|---|---|
| (none) | Start in the background. Pidfile + log under `$PROFILE/`. |
| `--foreground` | Attach Chrome to the current terminal (old behavior). |
| `--stop` | Stop the Chrome this script started. |
| `--status` | Report whether our Chrome is running. |
| `--help` | Show usage. |

A second `start-chrome.sh` while one is already running refuses cleanly
instead of fighting over the port.

### Headless mode (recommended for remote dev hosts)

If you're working on a headless dev host (no X server, no `$DISPLAY`),
the launcher auto-enables `--headless=new`:

```bash
~/browser-eyes/bin/start-chrome.sh
# headless: yes  — runs in the background, no UI, full CDP available
```

The agent drives the browser via the `navigate` tool — point it at a URL
and it loads the page, then `look` returns the rendered screenshot plus
buffered console/network. Everything stays on the dev host; nothing
tunnels out. This is the right shape for "I'm building a web app on a
cloud VM, I want Claude to see it" — no laptop browser, no port forwards.

To force headless even when a display is present: `BROWSER_EYES_HEADLESS=1`.
To force GUI mode: `BROWSER_EYES_HEADLESS=0`. Set the viewport with
`BROWSER_EYES_WINDOW=1920,1080` (default `1280,800`).

### Ubuntu snap-Chromium gotcha

Snap-confined Chromium can only write to a handful of directories under
`~/snap/chromium/common/`. If you try to use a profile elsewhere you'll see:

```
Failed to create /path/to/profile/SingletonLock: Permission denied
```

The launcher detects snap-Chromium and pins the profile under
`~/snap/chromium/common/` automatically. If you'd rather skip the sandbox
entirely (faster, fewer surprises), install real Chrome:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo apt install ./google-chrome-stable_current_amd64.deb
```

The `libpxbackend-1.0.so: cannot open shared object file` warning at startup
is harmless — it's a libproxy plugin missing from the snap, not a real
problem.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `BROWSER_EYES_HOST` | `localhost` | Host where Chrome's debug port is reachable. |
| `BROWSER_EYES_PORT` | `9222` | Chrome's `--remote-debugging-port`. |
| `BROWSER_EYES_PROFILE` | `~/.browser-eyes-profile` (or `~/snap/chromium/common/browser-eyes-profile` on snap) | Profile dir used by `start-chrome.sh`. |
| `BROWSER_EYES_BIN` | autodetect | Path to the Chrome/Chromium binary. |
| `BROWSER_EYES_AUTO_SPAWN` | `1` | `0` to disable auto-spawning Chrome from the MCP. |
| `BROWSER_EYES_LAUNCHER` | `<repo>/bin/start-chrome.sh` | Path to the launcher script the MCP shells out to. |

### Browser on a different machine than Claude Code

This is the common case: Claude Code runs on a remote dev host (cloud VM,
work server, WSL), but the browser you actually look at lives on your
laptop. Chrome's debug port only listens on localhost — and that's a
feature, since exposing it publicly hands anyone full control of your
browser. The fix is to forward the port over SSH.

**Standard layout — you SSH from laptop → dev host:**

```bash
# 1. on your laptop, run Chrome with the debug port:
google-chrome --remote-debugging-port=9222 \
              --user-data-dir=$HOME/.browser-eyes-profile

# 2. open a separate SSH session from laptop → dev host with a reverse
#    forward, so the dev host's localhost:9222 → laptop's Chrome:
ssh -R 9222:localhost:9222 user@dev-host
```

On the dev host, leave `BROWSER_EYES_HOST=localhost` (the default) — the
MCP connects to localhost:9222 and the SSH tunnel routes to your laptop.

**Inverse layout — Claude Code can SSH out to the browser host:**

```bash
# from the machine running Claude Code:
ssh -L 9222:localhost:9222 your-browser-host
```

Use this only if the box with the browser is reachable by SSH from the
Claude Code box (rare — most laptops are behind NAT).

### WSL / Windows

If Claude Code runs in WSL but Chrome runs on Windows, set
`BROWSER_EYES_HOST` to the Windows host IP (the gateway from WSL's
perspective):

```bash
export BROWSER_EYES_HOST="$(ip route | awk '/default/ {print $3}')"
```

You'll also need to launch Chrome with
`--remote-debugging-address=127.0.0.1` and a port-proxy, OR use SSH-style
forwarding. Easiest: just run Chrome inside WSL.


## Background

Built to scratch the itch of: "I'm building a web app with Claude Code, I see
something wrong in the browser, and I have to screenshot+paste every single
time." Now the agent just looks.
