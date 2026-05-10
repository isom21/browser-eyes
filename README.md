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
| `eval_js` | Run a JS expression in the active tab and return the result. Top-level `await` works. |
| `list_tabs` | List open Chrome tabs. |
| `select_tab` | Switch which tab the MCP is attached to. |
| `clear_buffers` | Reset the console & network-error buffers. Useful before "click X then look". |

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
claude mcp add browser-eyes node /home/dev/browser-eyes/dist/index.js
```

(Use `--scope user` to make it available across all projects.)

## Running Chrome

You need Chrome running with the remote-debugging port enabled. Use the
included helper:

```bash
~/browser-eyes/bin/start-chrome.sh
```

This launches Chrome on port `9222` with a dedicated profile at
`~/.browser-eyes-profile`. First launch is empty — log in to whatever sites
you need; the profile persists across runs.

If you'd rather use your normal Chrome, fully quit it and relaunch with
`--remote-debugging-port=9222`. **Don't expose this port to the internet** —
it gives full control of your browser. Localhost only.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `BROWSER_EYES_HOST` | `localhost` | Host where Chrome's debug port is reachable. |
| `BROWSER_EYES_PORT` | `9222` | Chrome's `--remote-debugging-port`. |
| `BROWSER_EYES_PROFILE` | `~/.browser-eyes-profile` | Profile dir used by `start-chrome.sh`. |
| `BROWSER_EYES_BIN` | autodetect | Path to the Chrome/Chromium binary. |

### Browser on a different machine than Claude Code

Chrome's debug port only listens on localhost (good — it's a remote-control
hole). If your browser is on a different machine, forward the port over SSH
rather than binding it publicly:

```bash
# from the machine running Claude Code, tunnel to where Chrome runs:
ssh -L 9222:localhost:9222 your-browser-host
```

Then leave `BROWSER_EYES_HOST=localhost` and it just works.

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

## How the agent should use it

Hint Claude Code, e.g. via project `CLAUDE.md`:

> When working on the web UI, use the `look` tool from the `browser-eyes` MCP
> to see the current state of my browser. Call it after each visible change
> and whenever you suspect a console error.

That single nudge is usually enough; the tool description tells Claude what
each call returns.

## Background

Built to scratch the itch of: "I'm building a web app with Claude Code, I see
something wrong in the browser, and I have to screenshot+paste every single
time." Now the agent just looks.
