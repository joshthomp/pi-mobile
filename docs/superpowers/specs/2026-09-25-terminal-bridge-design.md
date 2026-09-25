# Terminal bridge: drive a terminal `pi` from the phone

Date: 2026-09-25
Branch: `feat/terminal-bridge` (stacked on `feat/terminal-mirror`)
Status: draft — waiting for review

## 1. Goal

You start a prompt in a terminal `pi` on the Mac. You leave the Mac. From the phone you:

1. see the terminal turn live (status and messages),
2. stop the running turn,
3. send the next message into **the same terminal `pi` process**.

Success: the message you send from the phone shows up in the terminal, and that
terminal `pi` runs it. No second `pi` process writes to the session file.

## 2. Constraints

- **No iOS change.** The app is not ours, and there is no Xcode or developer
  certificate. The feature must work through the API calls the app makes today.
- Mac-side only: `server/server.ts`, a new Pi extension, `server/install.sh`.
- Use only the documented Pi extension API (Pi 0.87.1).
- The bridge is optional. With no bridge, everything works as it does on
  `feat/terminal-mirror`.

## 3. What the current app can do (fixed)

From `PiMobile/Views/ChatView.swift`:

| App action | API call | When |
|---|---|---|
| Poll status | `GET /sessions/:id/status` → `{running, activity, pending_ui}` | every 1.5 s while `running` |
| Send | `POST /sessions/:id/send` `{text, model, thinking, approvalMode, images}` | only when **not** running |
| Stop | `POST /sessions/:id/stop` | only when running |
| Refresh messages | `GET /sessions/:id/messages` | on each poll |

So the bridge gives the phone exactly two actions: **send when idle** and
**stop when busy**. Steer and follow-up work in Pi (the spike proved it), but the
app cannot send them. They are out of scope.

## 4. Spike facts this design relies on

From the throwaway spike (interactive `pi` in a pty, fake model):

1. `pi.sendUserMessage(text)` from outside a handler starts a real turn in the
   interactive terminal. The terminal shows the message.
2. A send without `deliverAs` while Pi is busy fails with
   `Agent is already processing…`. The error shows only in the terminal. The
   caller does not see it.
3. `ctx.abort()` during a tool call kills the tool at once. Pi writes
   `stopReason: "error"`, `errorMessage: "This operation was aborted"`.
4. `ctx.sessionManager.getSessionId()` / `getSessionFile()` are known at
   `session_start`.
5. `agent_start`, `agent_end`, `tool_execution_start` fire in real time.

## 5. Architecture

```text
terminal pi ── pi-mobile-bridge ──long-poll──▶ server.ts ◀── iPhone (unchanged)
                 │  POST /bridge/poll   (hold ≤25 s, returns commands)
                 └  POST /bridge/event  (state changes, command results)
```

### 5.1 The extension: `server/pi-mobile-bridge/`

Files: `extension.ts`, `package.json` (same layout as `pi-mobile-approval`).

Behavior:

- **Skip server-owned `pi`.** If `PI_MOBILE_RPC=1` is set, do nothing. The
  server sets this in `piEnv()` for every `pi` it starts. Without this, a phone
  turn's own `pi --mode rpc` registers as a bridge.
- **Skip non-interactive modes.** If `ctx.mode !== "tui"` (print, json, rpc
  modes), do nothing. Do not use `ctx.hasUI`: it is also true in rpc mode.
- **Start at `session_start`**, not in the factory (Pi docs rule). Keep the
  latest `ctx`. A new `session_start` (`/new`, `/resume`) replaces the session
  id. The next poll carries the new id.
- **Poll loop.** Read the token from `~/.pi-companion/token` on each attempt.
  `POST http://127.0.0.1:${PI_MOBILE_PORT ?? 8940}/bridge/poll` with
  `{pid, session_id, session_file, cwd, idle, activity}`. On a network error or
  a non-200, wait with backoff (1 s → 30 s max). Never log to the terminal UI on
  a failed connect. The server is often stopped (on-demand mode).
- **Run commands** from the poll response:
  - `send {id, text, images}` → if `ctx.isIdle()`, call
    `pi.sendUserMessage(content)`. Else report `{id, ok:false, error:"busy"}`.
    Never send without `deliverAs` while busy (spike fact 2).
  - `stop {id}` → `ctx.abort()`, report `{id, ok:true}`.
- **Report state** with `POST /bridge/event`:
  - `agent_start` → `{state:"running"}`
  - `tool_execution_start` → `{activity:"<tool> <short input>"}`
  - `agent_end` → `{state:"idle"}`
  - command results → `{result:{id, ok, error?}}`
- **Stop at `session_shutdown`.** End the loop and send `{gone:true}`.

### 5.2 The server: `server/server.ts`

New in-memory registry:

```ts
type Bridge = {
  pid: number; sessionId: string; sessionFile: string; cwd: string;
  running: boolean; activity: string; lastSeen: number;
  queue: Command[]; waiter: ((cmds: Command[]) => void) | null;
  results: Map<string, (r: Result) => void>;
};
const bridges = new Map<number, Bridge>(); // key: pid
```

- A bridge counts as **alive** if `lastSeen` is within 40 s. The poll holds for
  up to 25 s, so a live bridge refreshes `lastSeen` at least every 25 s.
- `bridgeFor(sessionId)` returns the alive bridge whose `sessionId` matches.

New routes. They need the bearer token **and** a loopback source address
(`server.requestIP(req)` is `127.0.0.1` or `::1`). Otherwise the server returns 403.

| Route | Does |
|---|---|
| `POST /bridge/poll` | Upsert the bridge by pid. Update its fields. If the queue has commands, return them now. Else hold up to 25 s, then return `{commands:[]}`. |
| `POST /bridge/event` | Update `running` / `activity`. Resolve a waiting result. On `gone`, delete the bridge. |

Changed routes (the app calls these today):

| Route | New behavior when `bridgeFor(id)` exists | Else |
|---|---|---|
| `GET /sessions/:id/status` | `{running: bridge.running, activity: bridge.activity, pending_ui: null}` | unchanged (rpc turn, then file + process check) |
| `POST /sessions/:id/send` | If running → 409 `agent is already working`. Else queue `send`, wait ≤5 s for the result. `ok` → `{ok:true}`. `busy` → 409. Timeout → 504 `terminal pi did not answer`. | unchanged (spawn `pi --mode rpc`) |
| `POST /sessions/:id/stop` | Queue `stop`, return `{ok:true}` | unchanged |
| workspace `status` | `in-progress` if a bridge in that cwd is running | unchanged |

Rules for a terminal session:

- The phone's `model`, `thinking` and `approvalMode` are **ignored**. The
  terminal owns them. The terminal's own approval flow (if any) runs on the Mac.
- Images from the phone pass through as Pi `ImageContent` blocks.
- `piEnv()` adds `PI_MOBILE_RPC=1`.
- `Bun.serve` gets `idleTimeout: 30`. Bun's default of 10 s closes a 25 s
  long-poll.
- A loopback-only `GET /bridge/list` returns `[{pid, session_id, cwd, running}]`
  so tests and a user can see which terminals are connected.

### 5.3 Install: `server/install.sh`

- Copy (checkout) or download (curl) `pi-mobile-bridge/` next to
  `pi-mobile-approval/`.
- Run `pi install ~/.pi-companion/pi-mobile-bridge` once. Print one line that
  says so. A failed `pi install` warns but does not stop the install.
- `--uninstall` runs `pi remove ~/.pi-companion/pi-mobile-bridge`.

Only terminal `pi` sessions **started after** the install load the bridge.
Running sessions need a restart, or `/reload`.

## 6. Error handling

| Case | Result |
|---|---|
| Server stopped | The bridge backs off quietly. The terminal is not affected. |
| Terminal `pi` quits or crashes | No poll for 40 s → the bridge expires. Before that, `gone` removes it at once on a clean quit. Status falls back to the file + process check. |
| Two terminal `pi` in the same session | Both register. `bridgeFor` picks the most recent `lastSeen`. This is rare, and the README caveat already covers it. |
| Send reaches a busy terminal (race) | The bridge reports `busy` → 409. Nothing is queued, and the terminal shows no error. |
| Old terminal `pi` with no bridge | Same behavior as `feat/terminal-mirror` (send starts a separate rpc `pi`). |
| Bridge code throws | Catch it inside the extension. Report `{ok:false, error}`. Never crash the terminal `pi`. |

## 7. Security

- The bridge endpoints accept loopback requests only, and they need the token.
  A LAN or Tailscale peer cannot register a fake bridge or read commands.
- The bridge reads the token from disk. It has mode 0600, as today.
- No new port. No new listener in the terminal `pi`.

## 8. Testing

One script, `server/test-bridge.sh`, in the style of `test-terminal-turn.sh`:

- A temp `HOME`, the server on port 18940, the fake OpenAI-compatible model from
  the spike (`fake-llm.ts`, moved to `server/test/`), and interactive `pi` in a
  pty through `expect`. It loads the bridge with `-e` and a test-only extension
  that registers the fake provider.
- Cases:
  1. Bridge registers → `/status` is `running:false` with a bridge.
  2. Phone send while idle → the terminal runs it → `ECHO:` reply in the session file.
  3. Send `SLEEP 20` → `/status` is `running:true` with a `bash` activity.
  4. Send while busy → 409.
  5. Stop while busy → the turn ends in ≤3 s.
  6. Server-started `pi` with `PI_MOBILE_RPC=1` does not register.
  7. `/bridge/poll` to the Mac's own LAN IP (`ipconfig getifaddr en0`), which is not loopback → 403. If the Mac has no LAN IP, the test prints `SKIP 7` and fails no other case.
  8. Quit the terminal `pi` → the bridge disappears → the status fallback is used.
- No API cost: every model call goes to the fake model.

## 9. Out of scope

- Steer and follow-up from the phone (the app cannot send them).
- Token-by-token streaming to the phone (the app refreshes whole messages).
- Model, thinking or approval changes from the phone for terminal sessions.
- Approval prompts of a terminal session on the phone.

## 10. Effort

About 1–1.5 days: extension 3 h, server 3 h, install 1 h, test script 3 h, README 30 min.
