# Terminal Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the unchanged iPhone app see, stop, and send messages into a `pi` that runs in a Mac terminal.

**Architecture:** A Pi extension (`server/pi-mobile-bridge/`) runs inside each interactive terminal `pi`. It long-polls the companion server on loopback for commands (`send`, `stop`) and reports state changes. The server keeps an in-memory registry of bridges by pid. It routes the phone's existing `/status`, `/send`, `/stop` calls to a live bridge. With no bridge, the server behaves as before.

**Tech Stack:** Bun 1.4.2 (server), Pi 0.87.1 extension API (TypeScript, runs in Node 24), bash + curl + expect (tests).

**Spec:** `docs/superpowers/specs/2026-09-25-terminal-bridge-design.md`

## Global Constraints

- No iOS change. Only `server/`, `README.md` and docs change.
- Use only the documented Pi extension API: `pi.on`, `pi.sendUserMessage`, `ctx.abort`, `ctx.isIdle`, `ctx.mode`, `ctx.cwd`, `ctx.sessionManager.getSessionId/getSessionFile`, `pi.registerProvider` (tests only).
- Bridge routes: bearer token **and** loopback source (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`). Else 403.
- Poll hold 25 s (`BRIDGE_HOLD_MS`), bridge TTL 40 s (`BRIDGE_TTL_MS`), send ack wait 5 s. The two env vars exist only so tests run fast.
- `Bun.serve` needs `idleTimeout: 30`.
- The bridge does nothing when `PI_MOBILE_RPC=1` or `ctx.mode !== "tui"`.
- For terminal sessions the server ignores the phone's `model`, `thinking`, `approvalMode`.
- Tests make no model API calls. They use the fake OpenAI-compatible model.
- Error strings the app shows: `agent is already working` (409), `terminal pi did not answer` (504).
- Branch: `feat/terminal-bridge`, stacked on `feat/terminal-mirror`.

## Review Focus

1. **Send right after send-ack, before `agent_start` arrives.** The app polls `/status` 1.5 s after send. It must see `running:true`, or it stops polling. Task 1 sets `running = true` on a successful ack and tests it (case C).
2. **A poll that is replaced or dropped.** A second poll from the same pid must release the first one with `[]`, not leave it hanging. Task 1 case F2 tests it.
3. **A command that nobody collects.** A send with no poll waiting must time out with 504 and must **not** be delivered later. Task 1 case G tests it.
4. **The server is stopped while a terminal `pi` runs.** The bridge must back off quietly and never print to the terminal. Task 2 case 9 starts `pi` before the server and checks that it registers later and that the TUI shows no bridge error.
5. **A terminal `pi` exits.** The bridge must disappear (`gone` or TTL), and status must fall back to the mirror. Task 2 case 8 tests it.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/server.ts` (modify) | Bridge registry, `/bridge/*` routes, routing of `/status`, `/send`, `/stop`, workspace badge, `PI_MOBILE_RPC` in `piEnv()`, `idleTimeout`. |
| `server/test-bridge-server.sh` (create) | Server-only check: curl plays the bridge. Fast, no `pi`. |
| `server/pi-mobile-bridge/extension.ts` (create) | The extension that runs in terminal `pi`. |
| `server/pi-mobile-bridge/package.json` (create) | Pi package manifest (same shape as `pi-mobile-approval`). |
| `server/test/fake-llm.ts` (create) | Fake OpenAI Chat Completions server with scripted replies. |
| `server/test/fake-provider.ts` (create) | Test-only extension that registers the `fake/fake` model. |
| `server/test-bridge.sh` (create) | End-to-end check: real interactive `pi` in a pty + bridge + server. |
| `server/install.sh` (modify) | Copy/download the bridge, `pi install` it, `pi remove` on uninstall. |
| `README.md` (modify) | Explain the bridge. |

---

### Task 1: Server bridge registry and routing

**Files:**
- Modify: `server/server.ts` — `piEnv()` (~line 398), `workspaceStatus()` (~line 1011), `Bun.serve({` (~line 1057), `/send` route (~line 1073), `/stop` route (~line 1123), `/status` route (~line 1182)
- Create: `server/test-bridge-server.sh`

**Interfaces:**
- Consumes: nothing new.
- Produces (HTTP contract Task 2 relies on):
  - `POST /bridge/poll` body `{pid: number, session_id: string, session_file?: string, cwd?: string, idle?: boolean}` → `200 {commands: BridgeCommand[]}` (held up to `BRIDGE_HOLD_MS`). `400` on a bad body.
  - `POST /bridge/event` body `{pid: number, session_id?: string, state?: "running"|"idle", activity?: string, result?: {id: string, ok: boolean, error?: string}, gone?: boolean}` → `200 {ok:true}`, or `404 {error:"unknown bridge"}`.
  - `GET /bridge/list` → `200 [{pid, session_id, cwd, running, activity}]`.
  - `BridgeCommand = {id: string, type: "send", text: string, images?: {type:"image", data: string, mimeType: string}[]} | {id: string, type: "stop"}`.
  - Bridge `result.error` values the server understands: `"busy"`; anything else is passed through.

- [ ] **Step 1: Write the failing test**

Create `server/test-bridge-server.sh`:

```bash
#!/bin/bash
# Check: server bridge routes and routing. curl plays the terminal bridge.
# Runs server.ts with a temp HOME on port 18940. No pi, no model calls.
# Usage: ./server/test-bridge-server.sh
set -euo pipefail
cd "$(dirname "$0")"
T="$(mktemp -d)"; PORT=18940; B="http://127.0.0.1:$PORT"
cleanup() { kill ${SRV:-} $(jobs -p) 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
mkdir -p "$T/.pi-companion"; echo "[]" > "$T/.pi-companion/projects.json"

HOME="$T" PORT=$PORT PI_PATH=/usr/bin/true BRIDGE_HOLD_MS=2000 BRIDGE_TTL_MS=4000 \
  bun run server.ts >"$T/log" 2>&1 & SRV=$!
for _ in $(seq 1 40); do grep -q "Auth token:" "$T/log" 2>/dev/null && break; sleep 0.25; done
TOKEN="$(cat "$T/.pi-companion/token")"; AUTH="Authorization: Bearer $TOKEN"

fail() { echo "FAIL: $1"; tail -20 "$T/log"; exit 1; }
# req METHOD PATH [BODY] → prints "<code> <body>"
req() {
  local f; f="$(mktemp "$T/body.XXXXXX")" # one file per call: background calls run at the same time
  local a=(-s -o "$f" -w '%{http_code}' -X "$1" -H "$AUTH" -H 'content-type: application/json')
  [[ $# -ge 3 ]] && a+=(-d "$3")
  curl "${a[@]}" "$B$2"; echo " $(cat "$f")"
}
poll() { curl -s -X POST -H "$AUTH" -H 'content-type: application/json' -d "$1" "$B/bridge/poll"; }
id_of() { grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4; }
REG='{"pid":4242,"session_id":"s1","session_file":"/x.jsonl","cwd":"/tmp/p","idle":true}'

# A. auth and bad body
[[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/bridge/poll" -d "$REG")" == 401 ]] || fail "A1 no token → 401"
[[ "$(req POST /bridge/poll '{"pid":"x"}' | cut -c1-3)" == 400 ]] || fail "A2 bad body → 400"
[[ "$(req POST /bridge/event '{"pid":999}' | cut -c1-3)" == 404 ]] || fail "A3 unknown bridge → 404"

# B. register; hold returns [] after BRIDGE_HOLD_MS
[[ "$(poll "$REG")" == '{"commands":[]}' ]] || fail "B1 empty hold"
req GET /sessions/s1/status | grep -q '"running":false' || fail "B2 idle bridge status"
req GET /bridge/list | grep -q '"pid":4242' || fail "B3 list shows bridge"

# C. send while idle → command delivered → ack → 200 → status running (Review Focus 1)
poll "$REG" > "$T/p1" & P=$!; sleep 0.3
req POST /sessions/s1/send '{"text":"hi","model":"x/y"}' > "$T/send" & S=$!
wait $P; grep -q '"type":"send","text":"hi"' "$T/p1" || fail "C1 send command, got $(cat "$T/p1")"
CID="$(id_of < "$T/p1")"
req POST /bridge/event "{\"pid\":4242,\"result\":{\"id\":\"$CID\",\"ok\":true}}" >/dev/null
wait $S; grep -q '^200 {"ok":true}' "$T/send" || fail "C2 send 200, got $(cat "$T/send")"
req GET /sessions/s1/status | grep -q '"running":true' || fail "C3 running right after ack"

# D. events drive state
req POST /bridge/event '{"pid":4242,"state":"idle"}' >/dev/null
req GET /sessions/s1/status | grep -q '"running":false' || fail "D1 idle event"
req POST /bridge/event '{"pid":4242,"state":"running"}' >/dev/null
req POST /bridge/event '{"pid":4242,"activity":"bash sleep 5"}' >/dev/null
req GET /sessions/s1/status | grep -q '"running":true,"activity":"bash sleep 5"' || fail "D2 running + activity"

# E. send while running → 409
[[ "$(req POST /sessions/s1/send '{"text":"x"}')" == '409 {"error":"agent is already working"}' ]] || fail "E1 busy 409"

# F. stop → stop command delivered
poll "$REG" > "$T/p2" & P=$!; sleep 0.3
[[ "$(req POST /sessions/s1/stop | cut -c1-3)" == 200 ]] || fail "F1 stop 200"
wait $P; grep -q '"type":"stop"' "$T/p2" || fail "F1 stop command, got $(cat "$T/p2")"
# F2. a second poll from the same pid releases the first with [] (Review Focus 2)
poll "$REG" > "$T/p3" & P=$!; sleep 0.3
poll "$REG" > "$T/p4" & P2=$!
wait $P; [[ "$(cat "$T/p3")" == '{"commands":[]}' ]] || fail "F2 replaced poll released"
wait $P2
req POST /bridge/event '{"pid":4242,"state":"idle"}' >/dev/null

# G. no poll waiting → 504 after 5 s → command dropped (Review Focus 3)
[[ "$(req POST /sessions/s1/send '{"text":"lost"}')" == '504 {"error":"terminal pi did not answer"}' ]] || fail "G1 504"
[[ "$(poll "$REG")" == '{"commands":[]}' ]] || fail "G2 timed-out command not delivered later"

# H. bridge reports busy → 409
poll "$REG" > "$T/p5" & P=$!; sleep 0.3
req POST /sessions/s1/send '{"text":"b"}' > "$T/send" & S=$!
wait $P; CID="$(id_of < "$T/p5")"
req POST /bridge/event "{\"pid\":4242,\"result\":{\"id\":\"$CID\",\"ok\":false,\"error\":\"busy\"}}" >/dev/null
wait $S; grep -q '^409' "$T/send" || fail "H1 busy → 409, got $(cat "$T/send")"

# I. gone → bridge removed → send falls back to the rpc path (no session file → 404)
req POST /bridge/event '{"pid":4242,"gone":true}' >/dev/null
req GET /bridge/list | grep -q 4242 && fail "I1 gone removes bridge"
[[ "$(req POST /sessions/s1/send '{"text":"x"}' | cut -c1-3)" == 404 ]] || fail "I2 fallback path"

# J. TTL expiry
poll '{"pid":5555,"session_id":"s2","cwd":"/tmp/p","idle":true}' >/dev/null
sleep 4.5
[[ "$(req POST /sessions/s2/send '{"text":"x"}' | cut -c1-3)" == 404 ]] || fail "J1 expired bridge ignored"

# K. non-loopback source → 403
LAN="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
if [[ -n "$LAN" ]]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "$AUTH" -d "$REG" "http://$LAN:$PORT/bridge/poll")"
  [[ "$code" == 403 ]] || fail "K1 LAN → 403, got $code"
else echo "SKIP K (no LAN IP)"; fi

echo "PASS"
```

- [ ] **Step 2: Run the test and make sure it fails**

Run: `chmod +x server/test-bridge-server.sh && ./server/test-bridge-server.sh 2>&1 | grep -E "FAIL|PASS|SKIP"`
Expected: `FAIL: A2 bad body → 400` (the route does not exist, so the server returns 404).

- [ ] **Step 3: Add `PI_MOBILE_RPC` and `idleTimeout`**

In `piEnv()`, add the key before `...extra`:

```ts
    PATH: pathParts.join(":"),
    PI_MOBILE_RPC: "1", // pi-mobile-bridge stays off in server-started pi
    ...extra,
```

Change the server header:

```ts
Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 30, // /bridge/poll holds up to 25 s; Bun's default is 10 s
  async fetch(req, server) {
```

- [ ] **Step 4: Add the bridge registry**

Insert this block right above `function workspaceStatus(ws: Ws): string {`:

```ts
// ── Terminal bridges ────────────────────────────────────────────────────────
// A terminal `pi` with the pi-mobile-bridge extension long-polls /bridge/poll
// for commands and reports state with /bridge/event. In memory only: after a
// server restart each bridge registers again on its next poll.
type BridgeImage = { type: "image"; data: string; mimeType: string };
type BridgeCommand =
  | { id: string; type: "send"; text: string; images?: BridgeImage[] }
  | { id: string; type: "stop" };
type BridgeResult = { id: string; ok: boolean; error?: string };
type Bridge = {
  pid: number; sessionId: string; sessionFile: string; cwd: string;
  running: boolean; activity: string; lastSeen: number;
  queue: BridgeCommand[];
  waiter: ((cmds: BridgeCommand[]) => void) | null;
  results: Map<string, (r: BridgeResult) => void>;
};
const BRIDGE_HOLD_MS = Number(process.env.BRIDGE_HOLD_MS ?? 25_000);
const BRIDGE_TTL_MS = Number(process.env.BRIDGE_TTL_MS ?? 40_000);
const bridges = new Map<number, Bridge>(); // key: terminal pi pid

const isLoopback = (ip?: string) => ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
const bridgeAlive = (b: Bridge) => Date.now() - b.lastSeen < BRIDGE_TTL_MS;

function bridgeFor(sessionId: string): Bridge | null {
  let best: Bridge | null = null;
  for (const b of bridges.values())
    if (b.sessionId === sessionId && bridgeAlive(b) && (!best || b.lastSeen > best.lastSeen)) best = b;
  return best;
}
const bridgeRunningIn = (cwd: string) =>
  [...bridges.values()].some((b) => b.cwd === cwd && b.running && bridgeAlive(b));

// Register or refresh a bridge from a poll body. null → bad body.
function bridgeUpsert(body: any): Bridge | null {
  const pid = Number(body?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || typeof body?.session_id !== "string" || !body.session_id) return null;
  let b = bridges.get(pid);
  if (!b) {
    b = { pid, sessionId: "", sessionFile: "", cwd: "", running: body.idle === false, activity: "",
          lastSeen: 0, queue: [], waiter: null, results: new Map() };
    bridges.set(pid, b);
  }
  // After registration, only events change `running` (a poll's idle flag can lag a send).
  b.sessionId = body.session_id;
  if (typeof body.session_file === "string") b.sessionFile = body.session_file;
  if (typeof body.cwd === "string") b.cwd = body.cwd;
  b.lastSeen = Date.now();
  return b;
}

function bridgePoll(b: Bridge): Promise<BridgeCommand[]> {
  b.waiter?.([]); // a newer poll replaces an older one
  b.waiter = null;
  if (b.queue.length) return Promise.resolve(b.queue.splice(0));
  return new Promise((resolve) => {
    const done = (cmds: BridgeCommand[]) => { clearTimeout(timer); resolve(cmds); };
    const timer = setTimeout(() => { if (b.waiter === done) b.waiter = null; resolve([]); }, BRIDGE_HOLD_MS);
    b.waiter = done;
  });
}

function bridgeEnqueue(b: Bridge, cmd: BridgeCommand) {
  b.queue.push(cmd);
  const w = b.waiter;
  if (w) { b.waiter = null; w(b.queue.splice(0)); }
}

// Queue a command and wait for the bridge's result. On timeout the command is
// dropped, so it never runs late.
function bridgeCommand(b: Bridge, cmd: BridgeCommand, timeoutMs = 5_000): Promise<BridgeResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      b.results.delete(cmd.id);
      b.queue = b.queue.filter((c) => c.id !== cmd.id);
      resolve({ id: cmd.id, ok: false, error: "timeout" });
    }, timeoutMs);
    b.results.set(cmd.id, (r) => { clearTimeout(timer); b.results.delete(cmd.id); resolve(r); });
    bridgeEnqueue(b, cmd);
  });
}

function bridgeEvent(body: any): boolean {
  const b = bridges.get(Number(body?.pid));
  if (!b) return false;
  b.lastSeen = Date.now();
  if (typeof body.session_id === "string" && body.session_id) b.sessionId = body.session_id;
  if (body.state === "running") { b.running = true; b.activity = "Thinking…"; }
  if (body.state === "idle") { b.running = false; b.activity = ""; }
  if (typeof body.activity === "string" && b.running) b.activity = body.activity.slice(0, 200);
  const r = body.result;
  if (r && typeof r.id === "string")
    b.results.get(r.id)?.({ id: r.id, ok: r.ok === true, error: typeof r.error === "string" ? r.error : undefined });
  if (body.gone === true) { b.waiter?.([]); bridges.delete(b.pid); }
  return true;
}

// Phone send into a terminal pi. Returns the same shapes as sendMessage().
async function bridgeSend(b: Bridge, text: string, images: unknown): Promise<{ ok: true } | { error: string; status: number }> {
  if (b.running) return { error: "agent is already working", status: 409 };
  const imgs: BridgeImage[] = (Array.isArray(images) ? images : [])
    .filter((i: any) => typeof i?.data === "string" && typeof i?.mimeType === "string")
    .map((i: any) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
  const r = await bridgeCommand(b, { id: crypto.randomUUID(), type: "send", text, ...(imgs.length ? { images: imgs } : {}) });
  if (r.ok) { b.running = true; b.activity = "Thinking…"; return { ok: true }; } // the app polls before agent_start lands
  if (r.error === "busy") return { error: "agent is already working", status: 409 };
  if (r.error === "timeout") return { error: "terminal pi did not answer", status: 504 };
  return { error: `terminal pi: ${r.error ?? "unknown error"}`, status: 502 };
}
```

- [ ] **Step 5: Use the bridge in the workspace badge**

In `workspaceStatus()`, add one line after the `turns` check:

```ts
  if ([...turns.values()].some((t) => t.running && t.cwd === ws.cwd)) return "in-progress";
  if (bridgeRunningIn(ws.cwd)) return "in-progress";
```

- [ ] **Step 6: Add the `/bridge/*` routes**

In `fetch`, right after `let m: RegExpMatchArray | null;` and `try {`, add:

```ts
      if (path.startsWith("/bridge/")) {
        if (!isLoopback(server.requestIP(req)?.address))
          return Response.json({ error: "bridge routes are local only" }, { status: 403 });
        if (req.method === "GET" && path === "/bridge/list")
          return Response.json([...bridges.values()].filter(bridgeAlive).map((b) =>
            ({ pid: b.pid, session_id: b.sessionId, cwd: b.cwd, running: b.running, activity: b.activity })));
        const body = await req.json().catch(() => null);
        if (req.method === "POST" && path === "/bridge/poll") {
          const b = bridgeUpsert(body);
          if (!b) return Response.json({ error: "bad poll body" }, { status: 400 });
          return Response.json({ commands: await bridgePoll(b) });
        }
        if (req.method === "POST" && path === "/bridge/event")
          return bridgeEvent(body) ? Response.json({ ok: true }) : Response.json({ error: "unknown bridge" }, { status: 404 });
        return Response.json({ error: "not found" }, { status: 404 });
      }
```

- [ ] **Step 7: Route `/send`, `/stop`, `/status` to a live bridge**

`/send` — add the bridge branch before `sendMessage(...)`:

```ts
        if (!text?.trim() && !hasImages) return Response.json({ error: "empty message" }, { status: 400 });
        const bridge = bridgeFor(m[1]);
        // Terminal session: the terminal owns model, thinking and approval mode.
        const r = bridge
          ? await bridgeSend(bridge, (text ?? "").trim(), images)
          : sendMessage(m[1], (text ?? "").trim(), { model, thinking, approvalMode, images });
        return Response.json(r, { status: "status" in r ? (r.status as number) : 200 });
```

`/stop` — add at the top of the route:

```ts
      if (req.method === "POST" && (m = path.match(/^\/sessions\/([^/]+)\/stop$/))) {
        const bridge = bridgeFor(m[1]);
        if (bridge) {
          bridgeEnqueue(bridge, { id: crypto.randomUUID(), type: "stop" });
          return Response.json({ ok: true });
        }
        const t = turns.get(m[1]);
```

`/status` — use the bridge first:

```ts
      if ((m = path.match(/^\/sessions\/([^/]+)\/status$/))) {
        const bridge = bridgeFor(m[1]);
        if (bridge) return Response.json({ running: bridge.running, activity: bridge.activity, pending_ui: null });
        const t = turns.get(m[1]);
```

- [ ] **Step 8: Run the tests and make sure they pass**

Run: `./server/test-bridge-server.sh 2>&1 | grep -E "FAIL|PASS|SKIP"`
Expected: `PASS` (maybe `SKIP K` first on a Mac with no LAN IP).

Run: `./server/test-terminal-turn.sh 2>&1 | grep -E "FAIL|PASS"`
Expected: `PASS` (the mirror still works).

Run: `bun build server/server.ts --target=bun --outdir=/tmp/pmb-build >/dev/null && echo BUILD_OK`
Expected: `BUILD_OK`

- [ ] **Step 9: Commit**

```bash
git add server/server.ts server/test-bridge-server.sh
git commit -m "feat(server): terminal bridge registry and routing

Adds loopback-only /bridge/poll, /bridge/event and /bridge/list. The
phone's /status, /send and /stop use a live bridge for its session.
Server-started pi gets PI_MOBILE_RPC=1. idleTimeout 30 s for long-poll."
```

---

### Task 2: The bridge extension and the end-to-end check

**Files:**
- Create: `server/pi-mobile-bridge/extension.ts`
- Create: `server/pi-mobile-bridge/package.json`
- Create: `server/test/fake-llm.ts`
- Create: `server/test/fake-provider.ts`
- Create: `server/test-bridge.sh`

**Interfaces:**
- Consumes (from Task 1): `POST /bridge/poll`, `POST /bridge/event`, `GET /bridge/list`, `BridgeCommand` shapes, `result.error = "busy"`.
- Produces: env var `PI_MOBILE_PORT` (default `8940`) read by the extension. The token path is `~/.pi-companion/token` (via `os.homedir()`, so `HOME` moves it in tests).

- [ ] **Step 1: Write the test fixtures**

Create `server/test/fake-llm.ts`:

```ts
// Test fixture: fake OpenAI Chat Completions server with scripted replies.
//   last message is a tool result → text "DONE"
//   last user text has "SLEEP <n>" → bash tool call `sleep <n>`
//   anything else                  → text "ECHO: <last user text>"
const PORT = Number(process.env.FAKE_LLM_PORT ?? 18951);
const text = (c: any) => typeof c === "string" ? c : (c ?? []).map((p: any) => p.text ?? "").join("");
const chunk = (delta: any, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "fake",
    choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usage = `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "fake", choices: [],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`;

Bun.serve({
  port: PORT,
  async fetch(req) {
    const msgs = ((await req.json()) as any).messages ?? [];
    const last = msgs[msgs.length - 1];
    const lastUser = [...msgs].reverse().find((m: any) => m.role === "user");
    const sleep = last?.role === "user" && text(last.content).match(/SLEEP (\d+)/);
    let out: string;
    if (last?.role === "tool") out = chunk({ role: "assistant", content: "DONE" }) + chunk({}, "stop");
    else if (sleep) out = chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: `sleep ${sleep[1]}` }) } }] }) + chunk({}, "tool_calls");
    else out = chunk({ role: "assistant", content: `ECHO: ${text(lastUser?.content)}` }) + chunk({}, "stop");
    return new Response(out + usage + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  },
});
console.log(`fake llm on ${PORT}`);
```

Create `server/test/fake-provider.ts`:

```ts
// Test fixture: registers the model `fake/fake`, served by test/fake-llm.ts.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("fake", {
    baseUrl: `http://127.0.0.1:${process.env.FAKE_LLM_PORT ?? 18951}/v1`,
    apiKey: "x",
    api: "openai-completions",
    models: [{ id: "fake", name: "Fake", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  });
}
```

- [ ] **Step 2: Write the failing end-to-end test**

Create `server/test-bridge.sh`:

```bash
#!/bin/bash
# Check: phone API → server → pi-mobile-bridge → interactive terminal pi, and back.
# Temp HOME, server on 18940, fake model on 18951, pi in a pty via expect. No API cost.
# Usage: ./server/test-bridge.sh
set -euo pipefail
cd "$(dirname "$0")"; HERE="$(pwd)"
T="$(cd "$(mktemp -d)" && pwd -P)"; PORT=18940; B="http://127.0.0.1:$PORT"
PIDS=()
# Every test pi has this path on its command line, so pkill finds only test pis.
kill_test_pis() { pkill -f "$HERE/pi-mobile-bridge/extension.ts" 2>/dev/null || true; }
cleanup() { kill ${PIDS[@]+"${PIDS[@]}"} 2>/dev/null || true; kill_test_pis; wait 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
PROJ="$T/proj"; mkdir -p "$PROJ" "$T/.pi-companion"
echo "[{\"path\":\"$PROJ\",\"added\":1}]" > "$T/.pi-companion/projects.json"

fail() { echo "FAIL: $1"; echo "--- server log"; tail -20 "$T/log" 2>/dev/null; exit 1; }
start_server() {
  HOME="$T" PORT=$PORT PI_PATH=/usr/bin/true BRIDGE_HOLD_MS=3000 BRIDGE_TTL_MS=5000 \
    bun run server.ts >"$T/log" 2>&1 & PIDS+=($!); SRV=$!
  for _ in $(seq 1 40); do grep -q "Auth token:" "$T/log" 2>/dev/null && break; sleep 0.25; done
  AUTH="Authorization: Bearer $(cat "$T/.pi-companion/token")"
}
# start_pi NAME [ENV...] — interactive pi in a pty, cwd = $PROJ, TUI log in $T/NAME.tty
start_pi() {
  local name="$1"; shift
  (cd "$PROJ" && expect -c "
    set timeout 600
    spawn -noecho env HOME=$T PI_MOBILE_PORT=$PORT FAKE_LLM_PORT=18951 TERM=xterm-256color COLUMNS=120 LINES=40 $* \
      pi -ne -e $HERE/test/fake-provider.ts -e $HERE/pi-mobile-bridge/extension.ts --model fake/fake
    log_file -noappend $T/$name.tty
    expect eof
  " >/dev/null 2>&1) & PIDS+=($!); LAST_PI=$!
}
req() {
  local f; f="$(mktemp "$T/body.XXXXXX")" # one file per call: background calls run at the same time
  local a=(-s -o "$f" -w '%{http_code}' -X "$1" -H "$AUTH" -H 'content-type: application/json')
  [[ $# -ge 3 ]] && a+=(-d "$3")
  curl "${a[@]}" "$B$2"; echo " $(cat "$f")"
}
wait_for() { for _ in $(seq 1 "${3:-60}"); do eval "$2" >/dev/null 2>&1 && return 0; sleep 0.5; done; fail "$1"; }
sid() { req GET /bridge/list | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4; }
session_has() { grep -q "$1" "$T"/.pi/agent/sessions/*/*.jsonl; }
tui_clean() { perl -pe 's/\e\[[0-9;?]*[ -\/]*[@-~]//g; s/\e\][^\a]*\a//g; s/\r/\n/g' "$T/$1.tty"; }

bun run test/fake-llm.ts >"$T/llm.log" 2>&1 & PIDS+=($!)

# 9. pi starts BEFORE the server: the bridge backs off quietly, then registers (Review Focus 4)
start_pi main; PI_MAIN=$LAST_PI
sleep 4
start_server
wait_for "9 bridge registers after server start" '[[ -n "$(sid)" ]]' 80
# The TUI lists extension paths (they contain "bridge"), so match only error text.
tui_clean main | grep -qiE "ECONNREFUSED|fetch failed|Extension .*error" && fail "9 TUI shows a bridge error"
S="$(sid)"

# 1. registered bridge → status idle
req GET "/sessions/$S/status" | grep -q '"running":false' || fail "1 idle status"

# 2. phone send while idle → terminal runs it
[[ "$(req POST "/sessions/$S/send" '{"text":"PING1","model":"anthropic/x"}')" == '200 {"ok":true}' ]] || fail "2 send 200"
wait_for "2 ECHO: PING1 in session file" 'session_has "ECHO: PING1"'
tui_clean main | grep -q "PING1" || fail "2 terminal shows PING1"

# 3. long turn → status running with a bash activity
wait_for "3 idle before SLEEP" 'req GET "/sessions/$S/status" | grep -q "\"running\":false"'
req POST "/sessions/$S/send" '{"text":"SLEEP 20"}' | grep -q '^200' || fail "3 send SLEEP"
wait_for "3 bash activity" 'req GET "/sessions/$S/status" | grep -q "\"running\":true,\"activity\":\"bash"'

# 4. send while busy → 409
[[ "$(req POST "/sessions/$S/send" '{"text":"x"}' | cut -c1-3)" == 409 ]] || fail "4 busy 409"

# 5. stop while busy → turn ends in ≤3 s
T0=$(date +%s)
req POST "/sessions/$S/stop" | grep -q '^200' || fail "5 stop 200"
wait_for "5 idle after stop" 'req GET "/sessions/$S/status" | grep -q "\"running\":false"' 6
(( $(date +%s) - T0 <= 3 )) || fail "5 stop took more than 3 s"

# 6. PI_MOBILE_RPC=1 → no registration
start_pi rpc PI_MOBILE_RPC=1; sleep 5
[[ "$(req GET /bridge/list | grep -o '"pid"' | wc -l | tr -d ' ')" == 1 ]] || fail "6 PI_MOBILE_RPC pi registered"
kill $LAST_PI 2>/dev/null || true

# 8. terminal pi exits → bridge gone → status falls back (Review Focus 5)
kill $PI_MAIN 2>/dev/null || true; kill_test_pis
wait_for "8 bridge gone" '[[ "$(req GET /bridge/list)" == "200 []" ]]' 20
req GET "/sessions/$S/status" | grep -q '"running":false' || fail "8 fallback status"

echo "PASS"
```

- [ ] **Step 3: Run it and make sure it fails**

Run: `chmod +x server/test-bridge.sh && ./server/test-bridge.sh 2>&1 | grep -E "FAIL|PASS"`
Expected: `FAIL: 9 bridge registers after server start` (the extension file does not exist; pi fails to load it).

- [ ] **Step 4: Write the package manifest**

Create `server/pi-mobile-bridge/package.json`:

```json
{
  "name": "pi-mobile-bridge",
  "version": "1.0.0",
  "private": true,
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extension.ts"]
  }
}
```

- [ ] **Step 5: Write the extension**

Create `server/pi-mobile-bridge/extension.ts`:

```ts
/**
 * Pi Mobile terminal bridge — lets the Pi Mobile phone app see, stop, and send
 * messages into this interactive terminal pi. It long-polls the local
 * companion server (127.0.0.1) and does nothing when the server is stopped.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const BASE = `http://127.0.0.1:${process.env.PI_MOBILE_PORT ?? "8940"}`;
const TOKEN_PATH = `${homedir()}/.pi-companion/token`;

type Command =
  | { id: string; type: "send"; text: string; images?: { type: "image"; data: string; mimeType: string }[] }
  | { id: string; type: "stop" };

export default function (pi: ExtensionAPI) {
  if (process.env.PI_MOBILE_RPC === "1") return; // a pi the companion server started itself

  let ctx: any = null;
  let active = false;
  let pollAbort: AbortController | null = null;

  const token = () => { try { return readFileSync(TOKEN_PATH, "utf8").trim(); } catch { return null; } };

  async function post(path: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const t = token();
    if (!t) throw new Error("no token");
    const r = await fetch(BASE + path, {
      method: "POST",
      headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
      body: JSON.stringify({ pid: process.pid, ...body }),
      signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // Fire-and-forget; the server may be stopped. Never print to the terminal.
  const event = (body: Record<string, unknown>) =>
    post("/bridge/event", { session_id: ctx?.sessionManager.getSessionId(), ...body }).catch(() => {});

  function run(c: Command) {
    try {
      if (c.type === "send") {
        // Pi rejects a send without deliverAs while busy, and only the terminal sees that error.
        if (!ctx.isIdle()) return void event({ result: { id: c.id, ok: false, error: "busy" } });
        pi.sendUserMessage(c.images?.length ? [{ type: "text", text: c.text }, ...c.images] : c.text);
        event({ result: { id: c.id, ok: true } });
      } else if (c.type === "stop") {
        ctx.abort();
        event({ result: { id: c.id, ok: true } });
      } else {
        event({ result: { id: (c as any).id, ok: false, error: `unknown command ${(c as any).type}` } });
      }
    } catch (e) {
      event({ result: { id: c.id, ok: false, error: String(e) } });
    }
  }

  async function loop() {
    let delay = 1_000;
    while (active) {
      try {
        pollAbort = new AbortController();
        const { commands } = await post("/bridge/poll", {
          session_id: ctx.sessionManager.getSessionId(),
          session_file: ctx.sessionManager.getSessionFile() ?? "",
          cwd: ctx.cwd,
          idle: ctx.isIdle(),
        }, pollAbort.signal);
        delay = 1_000;
        for (const c of (commands ?? []) as Command[]) run(c);
      } catch {
        if (!active) return;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    }
  }

  // Start from session_start, not the factory (Pi extension lifecycle rule).
  pi.on("session_start", async (_e, c) => {
    if (c.mode !== "tui") return; // hasUI is also true in rpc mode
    ctx = c; // /new and /resume fire session_start again; the next poll carries the new id
    if (!active) { active = true; void loop(); }
  });
  pi.on("agent_start", () => { if (active) event({ state: "running" }); });
  pi.on("tool_execution_start", (e) => {
    if (!active) return;
    const a = e.args ?? {};
    const detail = String(a.command ?? a.path ?? a.file_path ?? a.pattern ?? "").slice(0, 80);
    event({ activity: `${e.toolName} ${detail}`.trim() });
  });
  pi.on("agent_end", () => { if (active) event({ state: "idle" }); });
  pi.on("session_shutdown", async () => {
    if (!active) return;
    active = false;
    pollAbort?.abort();
    await event({ gone: true });
  });
}
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `./server/test-bridge.sh 2>&1 | grep -E "FAIL|PASS"`
Expected: `PASS`

Run it 3 times in a row to catch timing flakes: `for i in 1 2 3; do ./server/test-bridge.sh 2>&1 | grep -E "FAIL|PASS"; done`
Expected: `PASS` three times.

Run: `./server/test-bridge-server.sh 2>&1 | grep -E "FAIL|PASS"`
Expected: `PASS`

- [ ] **Step 7: Commit**

```bash
git add server/pi-mobile-bridge server/test server/test-bridge.sh
git commit -m "feat(server): pi-mobile-bridge extension for terminal pi

The extension long-polls the local companion server, runs phone sends
with sendUserMessage (only when idle) and stops with ctx.abort(). Adds
an end-to-end check with a fake model (no API cost)."
```

---

### Task 3: Install, uninstall and README

**Files:**
- Modify: `server/install.sh:40-61` (copy/download block and package check), `server/install.sh:27-32` (`--uninstall`)
- Modify: `README.md` (Caveats section)

**Interfaces:**
- Consumes: `server/pi-mobile-bridge/{extension.ts,package.json}` from Task 2.
- Produces: `~/.pi-companion/pi-mobile-bridge/` installed and registered with `pi install`.

Note: this branch has the **old** `install.sh` (from `main`). `feat/server-start-stop` rewrites that file. Keep this edit small, so the rebase after that PR merges is easy.

- [ ] **Step 1: Write the failing check**

Run: `bash -n server/install.sh && grep -c "pi-mobile-bridge" server/install.sh`
Expected: `0` (the installer does not know the bridge yet).

- [ ] **Step 2: Copy or download the bridge**

In the checkout branch (after the `pi-mobile-approval` copy):

```bash
  if [[ -d "$DIR/pi-mobile-bridge" ]]; then
    rm -rf "$LOG_DIR/pi-mobile-bridge"
    cp -R "$DIR/pi-mobile-bridge" "$LOG_DIR/pi-mobile-bridge"
  fi
```

In the download branch (after the `pi-mobile-approval` downloads):

```bash
  echo "Downloading pi-mobile-bridge…"
  mkdir -p "$LOG_DIR/pi-mobile-bridge"
  curl -fsSL "$REPO_RAW/pi-mobile-bridge/extension.ts" -o "$LOG_DIR/pi-mobile-bridge/extension.ts"
  curl -fsSL "$REPO_RAW/pi-mobile-bridge/package.json" -o "$LOG_DIR/pi-mobile-bridge/package.json"
```

- [ ] **Step 3: Register the bridge with Pi**

After the `pi-mobile-approval` package check (the `exit 1` block), add:

```bash
# Terminal bridge: lets the phone see, stop and message terminal pi sessions.
# Optional — a failed install only loses that feature.
if [[ -f "$DIR/pi-mobile-bridge/extension.ts" ]]; then
  if PATH="$AGENT_PATH:$PATH" pi install "$DIR/pi-mobile-bridge" >/dev/null 2>&1; then
    echo "Installed the pi-mobile-bridge Pi extension (terminal pi sessions started from now on connect to the phone)."
  else
    echo "warning: 'pi install $DIR/pi-mobile-bridge' failed — the phone cannot drive terminal pi sessions." >&2
  fi
fi
```

In the `--uninstall` branch, before `echo "Uninstalled."`:

```bash
  PATH="$AGENT_PATH:$PATH" pi remove "$LOG_DIR/pi-mobile-bridge" >/dev/null 2>&1 || true
```

- [ ] **Step 4: Update the README**

In the Caveats section, after the terminal-turn line, add:

```markdown
- The installer also adds the `pi-mobile-bridge` Pi extension. Terminal `pi` sessions started after the install connect to the companion server on this Mac. From the phone you can then stop a running terminal turn, and send the next message into that same terminal. The phone's model and Ask/Auto choice do not apply to terminal sessions. The terminal keeps its own. Sessions that were already open need a restart or `/reload`.
```

- [ ] **Step 5: Run the checks**

Run: `bash -n server/install.sh && grep -c "pi-mobile-bridge" server/install.sh`
Expected: a count of `7` or more.

Before the real install: this branch has the old `install.sh`, so it installs in always-on mode. It also swaps the live server for this branch's `server.ts`. That is the current mode on this Mac, and it is safe. First make sure that the server runs no phone turn: `pgrep -P "$(launchctl print gui/$(id -u)/co.bungy.pi-companion | awk '/pid =/{print $3; exit}')" -l` shows only `caffeinate`.

Run the real install on this Mac: `./server/install.sh 2>&1 | grep -E "bridge|Installed|error"`
Expected: `Installed the pi-mobile-bridge Pi extension …` and `Installed and running.`

Run: `pi list 2>/dev/null | grep -c pi-mobile-bridge`
Expected: `1`

Check with a real terminal `pi` and the real server (no model call):

```bash
cd /tmp && expect -c 'set timeout 8; spawn -noecho env TERM=xterm-256color pi; expect timeout' >/dev/null 2>&1 &
sleep 5; curl -s -H "Authorization: Bearer $(cat ~/.pi-companion/token)" localhost:8940/bridge/list; echo
```
Expected: a JSON list with one entry whose `cwd` is `/private/tmp` (or `/tmp`).

- [ ] **Step 6: Commit**

```bash
git add server/install.sh README.md
git commit -m "feat(install): install the pi-mobile-bridge Pi extension"
```
