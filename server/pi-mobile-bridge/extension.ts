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
