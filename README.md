<p align="center">
  <img src="docs/images/pi-mobile-icon.png" width="160" alt="Pi Mobile app icon">
</p>

# Pi Mobile

An unofficial iOS companion app for the [Pi coding agent](https://pi.dev) — browse your projects and sessions, read full chat history, and keep talking to your agents while away from your Mac.

Pi is a terminal agent, so this app pairs a small companion server on your Mac (which reads Pi's session files and drives Pi over its RPC protocol) with a native SwiftUI app on the phone. Everything it touches is documented Pi surface — the session JSONL format and the RPC mode — no undocumented internals.

<p align="center"><em>Start a task in your terminal → go for a walk → keep directing the agent from your phone → come back and `pi -c` to continue on the desktop.</em></p>

## Features

- **Projects & workspaces** — every folder you've run `pi` in, grouped by git repo (worktrees appear under their main checkout), with branches and live status badges
- **Full chat history** — messages, thinking blocks, tool calls, inline images
- **Send messages** — continue any session from your phone; because the phone and the terminal share the same session file, `pi -c` on the Mac picks up exactly where you left off — no restarts, no forked conversations
- **New sessions & workspaces** — start a fresh session, or spin up a new git worktree, from the phone
- **Model picker** — Pi's full model catalog (15+ providers), switchable per-send, mid-session, with optional thinking level
- **Ask approval mode** — confirm tool calls on the phone (Auto stays the default; Ask loads a bundled Pi extension)
- **Photos & dictation** — attach images and dictate into the composer
- **Diffs** — review each workspace's uncommitted/branch changes on your phone

## How it works

```
iPhone app (SwiftUI)
      │  HTTP + bearer token (use Tailscale to reach your Mac from anywhere)
      ▼
Companion server on the Mac (Bun, single file)
      ├─ READ:  ~/.pi/agent/sessions/*.jsonl → projects, sessions, messages
      └─ RUN:   pi --mode rpc, resuming the session file in its project folder
                (pi appends the new turns to the same file itself)
```

## Setup

### Mac (companion server)

Requires [Bun](https://bun.sh) and [Pi](https://pi.dev).

```sh
curl -fsSL https://raw.githubusercontent.com/MRL-00/pi-mobile/main/server/install.sh | bash
```

(Or from a checkout: `./server/install.sh`.)

This starts the server now and prints the auth token and pairing QR for the phone app. By default it runs **on demand**: it does not start at login. While it runs, it keeps the Mac awake (`caffeinate -s`) and restarts after a crash.

Control it from any terminal (no checkout needed):

```sh
pi-companion start    # start and print the QR + token
pi-companion stop     # stop it when you finish (the Mac can sleep again)
pi-companion status   # also what plain `pi-companion` does
pi-companion install  # reinstall; keeps the current mode
```

To keep it always on (start at every login), install with `--always-on`. A later reinstall keeps that mode. Switch back with `pi-companion install --on-demand`.

```sh
curl -fsSL https://raw.githubusercontent.com/MRL-00/pi-mobile/main/server/install.sh | bash -s -- --always-on
```

`pi-companion` links to `~/.pi-companion/install.sh`. If `~/.local/bin` is not on your `PATH`, run that file directly. If you installed before these commands existed, run the install line again to get them. `stop` also ends any agent turn that is running. Token persists in `~/.pi-companion/token`; logs in `~/.pi-companion/server.log`. Uninstall with `pi-companion --uninstall`. (Or just run it manually: `cd server && bun run server.ts`.)

### iPhone

Open `PiMobile.xcodeproj` in Xcode (26+), build to your device (iOS 26+). Then either:

- Scan the QR code the server prints with the iPhone camera — it fills in the address and token automatically. Or manually, in the app's Settings:
- **Server address** — `http://<your-mac>:8940` (a [Tailscale](https://tailscale.com) hostname makes this work from anywhere)
- **Auth token** — the token the server printed

## Caveats

- Turns default to **Auto** tool permissions. **Ask** mode confirms each tool on the phone via the bundled `server/pi-mobile-approval` extension (loaded for that turn; optional `pi install` for desktop use too).
- A session that's open in a terminal `pi` and driven from the phone at the same time can race; finish one before the other (Pi's file format keeps history safe either way).
- Session titles are derived from the first user message (Pi sessions have no title field).

## Security

The server exposes your chat history and can run agents in your repos. It requires a bearer token on every request, serves attachments only from within project directories, and should only be reachable over a private network (LAN or Tailscale). Don't port-forward it to the open internet.
