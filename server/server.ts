// Pi companion server: JSON API over Pi's session files (~/.pi/agent/sessions)
// plus turn-running via `pi --mode rpc`. Everything it touches is documented
// Pi surface (session JSONL v3, RPC protocol) — no undocumented internals.
// Run: bun run server.ts   (prints the auth token to give the phone app)
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, realpathSync } from "fs";
import { resolve, basename, dirname } from "path";

const SESSIONS_ROOT = `${homedir()}/.pi/agent/sessions`;
const PORT = Number(process.env.PORT ?? 8940);
// LaunchAgents get a tiny PATH — resolve `pi` explicitly so model listing and
// RPC turns work even when ~/.local/bin isn't on it.
const PI = process.env.PI_PATH ?? [
  `${homedir()}/.local/bin/pi`,
  "/opt/homebrew/bin/pi",
  "/usr/local/bin/pi",
].find((p) => existsSync(p)) ?? "pi";

// Persistent bearer token — server can expose chat history, so auth is required.
const tokenDir = `${homedir()}/.pi-companion`;
const tokenPath = `${tokenDir}/token`;
if (!existsSync(tokenPath)) {
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(tokenPath, crypto.randomUUID(), { mode: 0o600 });
}
const TOKEN = readFileSync(tokenPath, "utf8").trim();

// Extra project cwds with no Pi sessions yet (e.g. fresh worktrees made from
// the phone). Pi discovers projects implicitly by running in a folder; this
// file covers the ones the phone created before their first session.
const projectsPath = `${tokenDir}/projects.json`;
// Entries are {path, added, name?} (older versions stored bare path strings).
// `name` is the phone-facing workspace label: "New Workspace" when a phone
// worktree is first created, replaced by a short task-derived name on the
// first user message.
type ProjectEntry = { path: string; added: number; name?: string };
const projectEntries = (): ProjectEntry[] => {
  try {
    return JSON.parse(readFileSync(projectsPath, "utf8")).map((e: any) =>
      typeof e === "string" ? { path: e, added: 0 } : e);
  } catch { return []; }
};
const extraCwds = () => projectEntries().map((e) => e.path);
const addedAt = (cwd: string) => projectEntries().find((e) => e.path === cwd)?.added ?? 0;
const storedName = (cwd: string) => projectEntries().find((e) => e.path === cwd)?.name;
const rememberCwd = (cwd: string, name?: string) => {
  const list = projectEntries();
  const i = list.findIndex((e) => e.path === cwd);
  if (i >= 0) {
    if (name && !list[i].name) list[i] = { ...list[i], name };
    else return;
  } else {
    list.push({ path: cwd, added: Date.now(), ...(name ? { name } : {}) });
  }
  writeFileSync(projectsPath, JSON.stringify(list, null, 2));
};
const forgetCwd = (cwd: string) => {
  writeFileSync(projectsPath, JSON.stringify(projectEntries().filter((e) => e.path !== cwd), null, 2));
};
// Force-overwrite a workspace's phone-facing label (temporary name → task name).
const setStoredName = (cwd: string, name: string) => {
  const list = projectEntries();
  const i = list.findIndex((e) => e.path === cwd);
  if (i >= 0) list[i] = { ...list[i], name };
  else list.push({ path: cwd, added: Date.now(), name });
  writeFileSync(projectsPath, JSON.stringify(list, null, 2));
};

const git = (cwd: string, ...a: string[]) => {
  const p = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
};

// ── Project/workspace scan ──────────────────────────────────────────────────
// Pi groups sessions by cwd: one directory per project path under
// SESSIONS_ROOT, named "--<cwd with / → ->--" (lossy — real cwd comes from the
// header line inside each session file). We map onto the phone's existing
// three-level navigation: repo = the git repo's main checkout, workspace = a
// cwd inside that repo (main checkout or any worktree), session = a jsonl file.
//
// Projects are opt-in: only folders the user added from the phone (plus
// worktrees created from the phone) appear — Pi's session dir also collects
// runs from other tools built on Pi (emdash etc.) and scratch folders, which
// would drown the list. Sessions for an added folder are picked up automatically.
const encodeCwd = (cwd: string) => `-${cwd.replaceAll("/", "-")}--`;

type Ws = { cwd: string; dir: string | null; mtime: number; sessionCount: number };
type Scan = { workspaces: Map<string, Ws>; repoOf: Map<string, string>; repoRoots: Map<string, string> };

function scan(): Scan {
  const workspaces = new Map<string, Ws>(); // workspace id (encoded cwd) → info
  const repoOf = new Map<string, string>(); // workspace id → repo id
  const repoRoots = new Map<string, string>(); // repo id → root path
  const cwds = new Map<string, { dir: string | null; mtime: number; sessionCount: number }>();

  const wanted = new Set(extraCwds().filter((c) => existsSync(c)));
  let dirs: string[] = [];
  try { dirs = readdirSync(SESSIONS_ROOT); } catch {}
  for (const dir of dirs) {
    const full = `${SESSIONS_ROOT}/${dir}`;
    let files: string[];
    try { files = readdirSync(full).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    if (!files.length) continue;
    files.sort();
    const newest = files[files.length - 1];
    let cwd: string;
    try {
      const header = JSON.parse(readFileSync(`${full}/${newest}`, "utf8").split("\n", 1)[0]);
      cwd = header.cwd;
    } catch { continue; }
    if (!wanted.has(cwd)) continue; // not a folder the user added
    cwds.set(cwd, { dir: full, mtime: statSync(`${full}/${newest}`).mtimeMs, sessionCount: files.length });
  }
  // No sessions yet → "last activity" is the moment the user added the folder.
  for (const cwd of wanted)
    if (!cwds.has(cwd)) cwds.set(cwd, { dir: null, mtime: addedAt(cwd) || Date.now(), sessionCount: 0 });

  for (const [cwd, info] of cwds) {
    // Group worktrees with their main checkout: --git-common-dir points at the
    // primary .git for every worktree of a repo. Non-git folders stand alone.
    const common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const root = common ? dirname(common) : cwd;
    const wsId = encodeCwd(cwd);
    const repoId = encodeCwd(root);
    workspaces.set(wsId, { cwd, ...info });
    repoOf.set(wsId, repoId);
    if (!repoRoots.has(repoId)) repoRoots.set(repoId, root);
  }
  return { workspaces, repoOf, repoRoots };
}

// Scan shells out to git per project, so cache briefly; phone navigation
// re-fetches often. ponytail: 15s TTL, event-driven invalidation if it lags.
let scanCache: { at: number; data: Scan } | null = null;
const scanned = () => {
  if (!scanCache || Date.now() - scanCache.at > 15_000) scanCache = { at: Date.now(), data: scan() };
  return scanCache.data;
};
const wsById = (id: string) => scanned().workspaces.get(id);

// ── Session files ───────────────────────────────────────────────────────────
type Entry = any; // Pi session JSONL v3 entries
const readEntries = (file: string): Entry[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

// Sessions form a tree via id/parentId; the live conversation is the path
// from the last-written entry back to the root.
function activeBranch(entries: Entry[]): Entry[] {
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const branch: Entry[] = [];
  let cur = entries[entries.length - 1];
  while (cur) {
    branch.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return branch.reverse();
}

const sessionFiles = (dir: string) =>
  readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse(); // newest first (timestamp prefix)

const sessionIdOf = (file: string) => basename(file).replace(".jsonl", "").split("_")[1] ?? basename(file);

// Find a session file by uuid across all project dirs.
function findSessionFile(sessionId: string): { file: string; cwd: string } | null {
  let dirs: string[] = [];
  try { dirs = readdirSync(SESSIONS_ROOT); } catch {}
  for (const dir of dirs) {
    const full = `${SESSIONS_ROOT}/${dir}`;
    let files: string[] = [];
    try { files = readdirSync(full); } catch { continue; }
    const hit = files.find((f) => f.endsWith(`_${sessionId}.jsonl`));
    if (hit) {
      try {
        const header = JSON.parse(readFileSync(`${full}/${hit}`, "utf8").split("\n", 1)[0]);
        return { file: `${full}/${hit}`, cwd: header.cwd };
      } catch {}
    }
  }
  return null;
}

const textOf = (msg: any) =>
  (msg?.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("")
    .trim();

const userImageBlocks = (msg: any) =>
  (msg?.content ?? []).filter((b: any) =>
    b?.type === "image" || b?.type === "image_url" || b?.type === "input_image"
    || (typeof b?.mimeType === "string" && String(b.mimeType).startsWith("image/")));

const userImageCount = (msg: any) => userImageBlocks(msg).length;
const userHasImages = (msg: any) => userImageCount(msg) > 0;

function sessionSummary(file: string, workspaceId: string) {
  const entries = readEntries(file);
  let title = "Untitled";
  let model: string | null = null;
  for (const e of entries) {
    if (title === "Untitled" && e.type === "message" && e.message?.role === "user") {
      const t = textOf(e.message);
      if (t) title = t.slice(0, 80);
    }
    if (e.type === "model_change") model = `${e.provider}/${e.modelId}`;
  }
  return {
    id: sessionIdOf(file),
    workspace_id: workspaceId,
    title,
    model,
    agent_type: "pi",
    updated_at: new Date(statSync(file).mtimeMs).toISOString(),
  };
}

// ── Display messages ────────────────────────────────────────────────────────
// Same row shapes the phone already renders: user / assistant / thinking /
// tool / duration rows in chronological order.
//
// Tool rows are multi-line: first line is `name short-label` (collapsed pill),
// remaining lines are expandable detail (args + a truncated result preview).
const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : v != null && v !== "" ? [String(v)] : [];
const toolText = (msg: any): string => {
  const c = msg?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => p?.text ?? "").filter(Boolean).join("\n");
  return "";
};

const summarizeInput = (input: any) => {
  if (!input || typeof input !== "object") return "";
  const queries = asList(input.queries ?? input.query);
  if (queries.length === 1) return truncate(queries[0], 80);
  if (queries.length > 1) return `${queries.length} queries`;
  const urls = asList(input.urls ?? input.url);
  if (urls.length === 1) return truncate(urls[0], 80);
  if (urls.length > 1) return `${urls.length} URLs`;
  if (input.urlIndex != null) return `urlIndex=${input.urlIndex}`;
  const v = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.description ?? "";
  return truncate(String(v), 80);
};

function formatToolCall(name: string, args: any): string {
  const header = `${name} ${summarizeInput(args)}`.trimEnd();
  const lines: string[] = [];
  const queries = asList(args?.queries ?? args?.query);
  if (queries.length) {
    for (const q of queries) lines.push(`"${q}"`);
  }
  const urls = asList(args?.urls ?? (args?.urlIndex == null ? args?.url : null));
  if (urls.length) {
    for (const u of urls) lines.push(u);
  }
  if (args?.urlIndex != null && args?.responseId) {
    lines.push(`responseId=${args.responseId}`);
  }
  // Long bash/read args: keep the full value available on expand.
  const primary = args?.file_path ?? args?.path ?? args?.command ?? args?.pattern ?? args?.description;
  if (!queries.length && !urls.length && typeof primary === "string" && primary.length > 80) {
    lines.push(primary);
  }
  return lines.length ? `${header}\n${lines.join("\n")}` : header;
}

function formatToolResult(msg: any): string {
  const d = msg?.details ?? {};
  const text = toolText(msg).trim();
  const lines: string[] = [];
  const name = msg?.toolName ?? "";

  if (name === "web_search" || d.queryCount != null) {
    const ok = d.successfulQueries ?? d.queryCount;
    const total = d.queryCount;
    const sources = d.totalResults;
    if (total != null) {
      let s = `${ok ?? total}/${total} queries`;
      if (sources != null) s += ` · ${sources} sources`;
      lines.push(s);
    }
  } else if (name === "fetch_content" || d.urlCount != null) {
    const ok = d.successful ?? d.urlCount;
    const total = d.urlCount;
    if (total != null) {
      let s = `${ok ?? total}/${total} URLs`;
      if (d.totalChars != null) s += ` · ${d.totalChars} chars`;
      lines.push(s);
    }
  } else if (name === "get_search_content" || d.title || d.contentLength != null) {
    const title = d.title || d.url;
    if (title) lines.push(String(title));
    if (d.url && d.title) lines.push(String(d.url));
    if (d.contentLength != null) lines.push(`${d.contentLength} chars`);
  }

  if (msg?.isError && !lines.length) lines.push("Error");

  // Preview of result body — enough to see what Pi got, not a full page dump.
  if (text) {
    const preview = truncate(text.replace(/\n{3,}/g, "\n\n"), 700);
    if (preview) lines.push(preview);
  }
  return lines.join("\n");
}

function displayMessages(sessionId: string) {
  const found = findSessionFile(sessionId);
  if (!found) return { error: "session not found", status: 404 };
  const out: { id: string; role: string; content: string; created_at: string }[] = [];
  const toolIndex = new Map<string, number>(); // toolCallId → out index
  let turnStart: number | null = null;
  for (const e of activeBranch(readEntries(found.file))) {
    if (e.type !== "message") continue;
    const msg = e.message;
    const createdAt = e.timestamp;
    if (msg.role === "user") {
      turnStart = new Date(e.timestamp).getTime();
      const t = textOf(msg);
      if (t) {
        out.push({ id: e.id, role: "user", content: t, created_at: createdAt });
      } else if (userHasImages(msg)) {
        // Image-only prompts have no text; still surface a row so the phone
        // can pin the turn and show something in history.
        const n = userImageCount(msg);
        out.push({
          id: e.id,
          role: "user",
          content: n === 1 ? "Photo" : `${n} Photos`,
          created_at: createdAt,
        });
      }
    } else if (msg.role === "assistant") {
      for (const [i, b] of (msg.content ?? []).entries()) {
        if (b.type === "text" && b.text?.trim())
          out.push({ id: `${e.id}-${i}`, role: "assistant", content: b.text, created_at: createdAt });
        else if (b.type === "thinking" && b.thinking?.trim())
          out.push({ id: `${e.id}-${i}`, role: "thinking", content: b.thinking, created_at: createdAt });
        else if (b.type === "toolCall") {
          out.push({
            id: `${e.id}-${i}`,
            role: "tool",
            content: formatToolCall(b.name, b.arguments),
            created_at: createdAt,
          });
          if (b.id) toolIndex.set(b.id, out.length - 1);
        }
      }
      if (msg.stopReason === "error" && msg.errorMessage)
        out.push({ id: `${e.id}-err`, role: "assistant", content: `⚠️ ${String(msg.errorMessage).slice(0, 300)}`, created_at: createdAt });
      if (msg.stopReason === "stop" && turnStart) {
        const s = Math.round((new Date(e.timestamp).getTime() - turnStart) / 1000);
        if (s >= 5) out.push({ id: `${e.id}-dur`, role: "duration", content: s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`, created_at: createdAt });
        turnStart = null;
      }
    } else if (msg.role === "toolResult" && msg.toolCallId) {
      const idx = toolIndex.get(msg.toolCallId);
      if (idx == null) continue;
      const detail = formatToolResult(msg);
      if (detail) {
        let content = out[idx].content;
        // Once we know the page title, prefer it over bare urlIndex=N in the pill.
        const title = msg.details?.title;
        if (title && /^get_search_content\b/.test(content.split("\n", 1)[0] ?? "")) {
          const nl = content.indexOf("\n");
          const rest = nl >= 0 ? content.slice(nl) : "";
          content = `get_search_content ${truncate(String(title), 80)}${rest}`;
        }
        out[idx].content = `${content}\n\n${detail}`;
      }
      toolIndex.delete(msg.toolCallId);
    }
  }
  return out;
}

// Bun LaunchAgent has a minimal env; give pi the same HOME/PATH a login shell would,
// so ~/.pi/agent/skills and package skills resolve the same as desktop pi.
function nodeBins(): string[] {
  const nvm = `${homedir()}/.nvm/versions/node`;
  try {
    return readdirSync(nvm)
      .filter((v) => existsSync(`${nvm}/${v}/bin/node`))
      .sort()
      .reverse()
      .map((v) => `${nvm}/${v}/bin`);
  } catch {
    return [];
  }
}
function piEnv(extra: Record<string, string> = {}): Record<string, string> {
  const pathParts = [
    `${homedir()}/.local/bin`,
    `${homedir()}/.bun/bin`,
    ...nodeBins(),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    process.env.PATH ?? "",
  ].filter(Boolean);
  return {
    ...process.env as Record<string, string>,
    HOME: process.env.HOME || homedir(),
    PATH: pathParts.join(":"),
    PI_MOBILE_RPC: "1", // pi-mobile-bridge stays off in server-started pi
    ...extra,
  };
}

// ── Models ──────────────────────────────────────────────────────────────────
// Prefer Pi RPC `get_available_models` so we can expose each model's real
// thinking-level set (same rules as Pi's getSupportedThinkingLevels). Falls
// back to `pi --list-models` if RPC isn't available.
type ModelInfo = { id: string; thinking: boolean; images: boolean; thinkingLevels: string[] };
let modelCache: { title: string; models: ModelInfo[] }[] = [];

const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
function supportedThinkingLevels(model: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }) {
  if (!model.reasoning) return [] as string[]; // no thinking control in the phone UI
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function refreshModelsFromList() {
  const p = Bun.spawnSync([PI, "--list-models"], { stdout: "pipe", stderr: "pipe", env: piEnv() });
  if (p.exitCode !== 0) return false;
  const groups = new Map<string, ModelInfo[]>();
  for (const line of p.stdout.toString().split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [provider, modelId] = parts;
    if (!provider || !modelId || provider === "provider") continue;
    const images = parts[parts.length - 1] === "yes";
    const reasoning = parts[parts.length - 2] === "yes";
    // Coarse yes/no only — without a level map don't invent controls.
    const thinkingLevels = reasoning ? ["off", "minimal", "low", "medium", "high"] : [];
    const list = groups.get(provider) ?? [];
    list.push({
      id: `${provider}/${modelId}`,
      thinking: thinkingLevels.length > 0,
      images,
      thinkingLevels,
    });
    groups.set(provider, list);
  }
  if (!groups.size) return false;
  modelCache = [...groups].map(([title, models]) => ({ title, models }));
  return true;
}

async function refreshModelsFromRpc() {
  // Keep stdin open until the response arrives (closing early makes pi exit
  // before answering). Ignore fire-and-forget extension_ui_request noise.
  const proc = Bun.spawn([PI, "--mode", "rpc", "--no-session"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: piEnv(),
  });
  proc.stdin.write(JSON.stringify({ id: "models", type: "get_available_models" }) + "\n");
  proc.stdin.flush();

  const dec = new TextDecoder();
  let buf = "";
  const apply = (models: any[]) => {
    const groups = new Map<string, ModelInfo[]>();
    for (const m of models) {
      const provider = m.provider ?? "unknown";
      const thinkingLevels = supportedThinkingLevels(m);
      const list = groups.get(provider) ?? [];
      list.push({
        id: `${provider}/${m.id}`,
        thinking: thinkingLevels.length > 0,
        images: Array.isArray(m.input) && m.input.includes("image"),
        thinkingLevels,
      });
      groups.set(provider, list);
    }
    if (!groups.size) return false;
    modelCache = [...groups].map(([title, ms]) => ({ title, models: ms }));
    return true;
  };

  try {
    const result = await Promise.race([
      (async () => {
        for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop()!;
          for (const line of lines) {
            if (!line.trim()) continue;
            let ev: any;
            try { ev = JSON.parse(line); } catch { continue; }
            if (ev.type === "response" && ev.command === "get_available_models" && ev.success) {
              return apply(ev.data?.models ?? []);
            }
          }
        }
        return false;
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
    ]);
    return result;
  } finally {
    try { proc.stdin.end(); } catch {}
    proc.kill();
  }
}

async function refreshModels() {
  try {
    if (await refreshModelsFromRpc()) return;
    refreshModelsFromList();
  } catch {
    try { refreshModelsFromList(); } catch {
      // pi missing from PATH — keep whatever cache we have; phone falls back to static list
    }
  }
}
await refreshModels();
setInterval(() => { void refreshModels(); }, 10 * 60_000);

// ── Skills (global + package; same discovery Pi uses in RPC) ────────────────
type SkillInfo = { name: string; description: string; command: string };
let skillCache: SkillInfo[] = [];

async function refreshSkills() {
  const proc = Bun.spawn([PI, "--mode", "rpc", "--no-session"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: piEnv(),
  });
  proc.stdin.write(JSON.stringify({ id: "skills", type: "get_commands" }) + "\n");
  proc.stdin.flush();

  const dec = new TextDecoder();
  let buf = "";
  try {
    await Promise.race([
      (async () => {
        for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop()!;
          for (const line of lines) {
            if (!line.trim()) continue;
            let ev: any;
            try { ev = JSON.parse(line); } catch { continue; }
            if (ev.type === "response" && ev.command === "get_commands" && ev.success) {
              const cmds = (ev.data?.commands ?? []) as any[];
              skillCache = cmds
                .filter((c) => c.source === "skill" || String(c.name ?? "").startsWith("skill:"))
                .map((c) => {
                  const command = String(c.name ?? "");
                  const name = command.startsWith("skill:") ? command.slice("skill:".length) : command;
                  return {
                    name,
                    command: `/skill:${name}`,
                    description: String(c.description ?? "").trim(),
                  };
                })
                .sort((a, b) => a.name.localeCompare(b.name));
              return true;
            }
          }
        }
        return false;
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
    ]);
  } catch {
    // keep last good list
  } finally {
    try { proc.stdin.end(); } catch {}
    proc.kill();
  }
}
await refreshSkills();
setInterval(() => { void refreshSkills(); }, 10 * 60_000);

// Bundled Ask-mode gate (also installable via POST /approval-extension/install).
const approvalExt = resolve(import.meta.dir, "pi-mobile-approval/extension.ts");
const approvalPkg = resolve(import.meta.dir, "pi-mobile-approval");
const approvalInstalled = () => {
  try {
    const settings = JSON.parse(readFileSync(`${homedir()}/.pi/agent/settings.json`, "utf8"));
    const pkgs: string[] = settings.packages ?? [];
    return pkgs.some((p) => p.includes("pi-mobile-approval") || resolve(p) === approvalExt || resolve(p) === approvalPkg);
  } catch { return false; }
};

// ── Pi version ──────────────────────────────────────────────────────────────
// Same contract Pi's own CLI uses (`pi.dev/api/latest-version`). Surfaces an
// "run pi update" hint to the phone when the Mac's install is behind.
type PiVersionInfo = {
  current: string | null;
  latest: string | null;
  update_available: boolean;
  update_command: string;
};
let piVersionCache: PiVersionInfo = {
  current: null, latest: null, update_available: false, update_command: "pi update",
};

function parseSemver(v: string): [number, number, number] | null {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isOlder(current: string, latest: string): boolean {
  const a = parseSemver(current);
  const b = parseSemver(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return true;
    if (a[i]! > b[i]!) return false;
  }
  return false;
}

async function refreshPiVersion() {
  const p = Bun.spawnSync([PI, "--version"], { stdout: "pipe", stderr: "pipe", env: piEnv() });
  const raw = p.exitCode === 0
    ? (p.stdout.toString().trim() || p.stderr.toString().trim())
    : "";
  const current = raw.match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? null;

  let latest: string | null = null;
  try {
    const res = await fetch("https://pi.dev/api/latest-version", {
      headers: { "User-Agent": `pi-companion/${current ?? "unknown"}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { version?: string };
      if (data.version) latest = data.version.replace(/^v/, "");
    }
  } catch { /* offline / API down — leave latest null */ }

  piVersionCache = {
    current,
    latest,
    update_available: !!(current && latest && isOlder(current, latest)),
    update_command: "pi update",
  };
}
refreshPiVersion();
setInterval(refreshPiVersion, 10 * 60_000);

// ── Creating workspaces & sessions ──────────────────────────────────────────
// A session id minted here materializes on disk on first send (pi --session-id
// creates it if missing). Until then remember which cwd it belongs to.
const pendingSessions = new Map<string, string>(); // session id → cwd  (ponytail: in-memory; re-create from the phone if the server restarts)

function createSession(workspaceId: string) {
  const ws = wsById(workspaceId);
  if (!ws) return { error: "workspace not found", status: 404 };
  const id = crypto.randomUUID();
  pendingSessions.set(id, ws.cwd);
  return { id, workspace_id: workspaceId, title: "Untitled", model: null, agent_type: "pi",
           updated_at: new Date().toISOString() };
}

// Phone-created worktrees get a random city folder + branch (Conductor-style —
// keeps worktree/branch names unique and stable), but the phone-facing `name`
// is a temporary "New Workspace" label, replaced by a task-derived name on the
// first user message.
const CITIES = [
  "lisbon","porto","quito","nairobi","hanoi","tbilisi","perth","leipzig","malmo","bergen",
  "cusco","davao","hobart","tampere","galway","split","ankara","doha","manila","seville",
  "maputo","bissau","montreal","stockholm","denver","victoria","baku","oslo","kyoto","riga",
];
const titleCase = (s: string) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const workspaceLabel = (cwd: string) => {
  const stored = storedName(cwd);
  if (stored) return stored;
  const base = basename(cwd);
  // Phone-created worktrees live under ~/pi-workspaces/<repo>/<city>
  if (cwd.startsWith(`${homedir()}/pi-workspaces/`)) return titleCase(base);
  return base; // main checkout / user-added folders keep their folder name
};

// Temporary label shown until the user's first message gives us a real task.
const NEW_WORKSPACE_LABEL = "New Workspace";

// Short task-based label from the first user message: first line, markdown
// stripped, capped on a word boundary. Empty → keep the temporary label
// (e.g. an image-only first message).
const taskNameFrom = (text: string): string => {
  // Drop fenced code blocks first, then take the first non-empty line.
  const firstLine = text.replace(/```[\s\S]*?```/g, " ").split("\n").find((l) => l.trim()) ?? "";
  const cleaned = firstLine
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links keep their visible text
    .replace(/[#>*_`~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const MAX = 50;
  if (cleaned.length <= MAX) return cleaned;
  const cut = cleaned.slice(0, MAX + 1);
  const space = cut.lastIndexOf(" ");
  return (space > MAX * 0.6 ? cut.slice(0, space) : cut.slice(0, MAX)).trimEnd() + "…";
};

function createWorkspace(repoId: string) {
  const root = scanned().repoRoots.get(repoId);
  if (!root || !existsSync(root)) return { error: "repo not found", status: 404 };
  if (!git(root, "rev-parse", "--git-dir")) return { error: "not a git repo", status: 400 };
  const repoName = basename(root);
  const base = `${homedir()}/pi-workspaces/${repoName}`;
  const unused = CITIES.filter((c) => !existsSync(`${base}/${c}`));
  const city = unused.length ? unused[Math.floor(Math.random() * unused.length)] : `mobile-${Date.now()}`;
  const path = `${base}/${city}`;
  const branch = `mobile/${city}`;
  mkdirSync(base, { recursive: true });
  const wt = Bun.spawnSync(["git", "worktree", "add", "-b", branch, path], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (wt.exitCode !== 0)
    return { error: `git worktree failed: ${wt.stderr.toString().trim()}`, status: 500 };
  // Temporary phone-facing label; the first user message replaces it with a
  // short task-derived name (folder + branch keep the city id).
  rememberCwd(path, NEW_WORKSPACE_LABEL);
  scanCache = null;
  const id = encodeCwd(path);
  return { id, repository_id: repoId, name: NEW_WORKSPACE_LABEL, branch, status: "not-started", unread: false,
           updated_at: new Date().toISOString(), last_message_snippet: null, session: createSession(id) };
}

// ── Running turns via Pi RPC ────────────────────────────────────────────────
type PendingUI = {
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
};
type PromptImage = { data: string; mimeType: string };
type Turn = {
  proc: ReturnType<typeof Bun.spawn> | null;
  running: boolean;
  activity: string;
  cwd: string;
  pendingUI: PendingUI | null;
};
const turns = new Map<string, Turn>();
let piUpdateInProgress = false;

type PiUpdateError = { error: string; status: number };

async function updatePiInstall(): Promise<PiVersionInfo | PiUpdateError> {
  if (piUpdateInProgress) return { error: "Pi is already updating", status: 409 };
  if ([...turns.values()].some((turn) => turn.running))
    return { error: "Wait for active Pi turns to finish before updating", status: 409 };

  piUpdateInProgress = true;
  try {
    const proc = Bun.spawn([PI, "update", "--self", "--no-approve"], {
      cwd: homedir(),
      stdout: "pipe",
      stderr: "pipe",
      env: piEnv(),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as any).text(),
      new Response(proc.stderr as any).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      const detail = (stderr.trim() || stdout.trim() || `pi update exited with status ${exitCode}`)
        .replace(/\x1b\[[0-9;]*m/g, "")
        .slice(0, 2000);
      return { error: detail, status: 500 };
    }

    await refreshPiVersion();
    if (!piVersionCache.current)
      return { error: "Pi updated, but its installed version could not be verified", status: 500 };
    if (piVersionCache.update_available)
      return {
        error: `Pi update finished, but ${piVersionCache.current} is still installed`,
        status: 500,
      };
    await Promise.all([refreshModels(), refreshSkills()]);
    return piVersionCache;
  } catch (error) {
    return { error: `Failed to update Pi: ${String(error)}`, status: 500 };
  } finally {
    piUpdateInProgress = false;
  }
}

function sendMessage(
  sessionId: string,
  text: string,
  opts: { model?: string; thinking?: string; approvalMode?: string; images?: PromptImage[] } = {},
) {
  if (piUpdateInProgress) return { error: "Pi is updating; try again when it finishes", status: 409 };
  const existing = turns.get(sessionId);
  if (existing?.running) return { error: "agent is already working", status: 409 };

  const found = findSessionFile(sessionId);
  const cwd = found?.cwd ?? pendingSessions.get(sessionId);
  if (!cwd) return { error: "session not found", status: 404 };
  if (!existsSync(cwd)) return { error: "workspace directory not found on this Mac", status: 400 };

  // First message in a brand-new workspace: swap the temporary "New Workspace"
  // label for a short name derived from the task itself.
  if (!found && (scanned().workspaces.get(encodeCwd(cwd))?.sessionCount ?? 0) === 0) {
    const name = taskNameFrom(text);
    if (name) setStoredName(cwd, name);
  }

  const approvalMode = (opts.approvalMode ?? "auto").toLowerCase() === "ask" ? "ask" : "auto";
  const args = [PI, "--mode", "rpc"];
  if (found) args.push("--session", found.file);
  else args.push("--session-id", sessionId);
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  // Ask must fail closed — never start a turn that looks like Ask without the gate.
  if (approvalMode === "ask") {
    if (!existsSync(approvalExt)) {
      return { error: "Ask mode requires the bundled approval extension (re-run server/install.sh)", status: 500 };
    }
    args.push("-e", approvalExt);
  }

  // Leave activity empty so the phone shows its "Working…" placeholder until
  // the first real Pi event (Thinking… / tool name) arrives.
  const turn: Turn = { proc: null, running: true, activity: "", cwd, pendingUI: null };
  turns.set(sessionId, turn);
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(args, {
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // HOME + richer PATH so installed skills/packages match desktop pi.
      env: piEnv({ PI_MOBILE_APPROVAL_MODE: approvalMode }),
    });
  } catch (e) {
    turns.delete(sessionId);
    return { error: `failed to start pi: ${String(e)}`, status: 500 };
  }
  turn.proc = proc;
  const images = (opts.images ?? [])
    .filter((img) => img?.data && img?.mimeType)
    .map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
  try {
    proc.stdin.write(JSON.stringify({
      id: "1",
      type: "prompt",
      message: text,
      ...(images.length ? { images } : {}),
    }) + "\n");
    proc.stdin.flush();
  } catch (e) {
    try { proc.kill(); } catch {}
    turns.delete(sessionId);
    return { error: `failed to send prompt: ${String(e)}`, status: 500 };
  }

  // Mark the turn done immediately — don't wait for stdout EOF, which never
  // comes if a tool left a background child holding the pipe open.
  const finish = () => {
    pendingSessions.delete(sessionId); // it's on disk now
    turn.running = false;
    turn.activity = "";
    turn.pendingUI = null;
  };

  // Drain stderr so pi can't block on a full pipe and never emit agent_end.
  (async () => { for await (const _ of proc.stderr as any) {} })();

  (async () => {
    let buf = "";
    for await (const chunk of proc.stdout as any) {
      buf += new TextDecoder().decode(chunk);
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "extension_ui_request" && (ev.method === "confirm" || ev.method === "select")) {
          turn.pendingUI = {
            id: ev.id,
            method: ev.method,
            title: ev.title,
            message: ev.message,
            options: ev.options,
          };
          turn.activity = ev.title ?? "Waiting for approval…";
        } else if (ev.type === "extension_ui_request" && ev.id) {
          // Unknown UI method the phone can't render — cancel it so pi doesn't
          // block forever waiting for a response that will never come.
          try {
            proc.stdin.write(JSON.stringify({ type: "extension_ui_response", id: ev.id, cancelled: true }) + "\n");
            proc.stdin.flush();
          } catch {}
        } else if (ev.type === "tool_execution_start") {
          turn.pendingUI = null;
          turn.activity = `${ev.toolName ?? "tool"} ${summarizeInput(ev.args)}`;
        } else if (ev.type === "message_start" && ev.message?.role === "assistant")
          turn.activity = "Thinking…";
        else if (ev.type === "response" && ev.success === false)
          turn.activity = `⚠️ ${ev.error ?? "command failed"}`;
        else if (ev.type === "agent_end") {
          finish();
          try { proc.stdin.end(); } catch {}
          proc.kill(); // pi stays resident waiting for more commands; the turn is done
        }
      }
    }
    await proc.exited;
    finish(); // safety net for abnormal exits (crash, kill) with no agent_end
  })();

  return { ok: true };
}

function respondUI(sessionId: string, body: any) {
  const turn = turns.get(sessionId);
  if (!turn?.running || !turn.proc?.stdin) return { error: "no active turn", status: 404 };
  if (!turn.pendingUI || (body.id && body.id !== turn.pendingUI.id))
    return { error: "no pending approval", status: 409 };
  const id = body.id ?? turn.pendingUI.id;
  let payload: Record<string, unknown> = { type: "extension_ui_response", id };
  if (body.cancelled) payload.cancelled = true;
  else if (turn.pendingUI.method === "confirm") payload.confirmed = !!body.confirmed;
  else if (body.value !== undefined) payload.value = body.value;
  else payload.cancelled = true;
  try {
    turn.proc.stdin.write(JSON.stringify(payload) + "\n");
    turn.proc.stdin.flush();
  } catch {
    return { error: "failed to write response", status: 500 };
  }
  turn.pendingUI = null;
  turn.activity = "Continuing…";
  return { ok: true };
}

// ── HTTP API (same shapes the phone already speaks) ─────────────────────────
const repos = () => {
  const { workspaces, repoOf, repoRoots } = scanned();
  return [...repoRoots]
    .map(([id, root]) => ({
      id,
      name: basename(root),
      default_branch: git(root, "symbolic-ref", "--short", "HEAD") ?? "main",
      active_workspace_count: [...repoOf.values()].filter((r) => r === id).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

// ── Terminal turns ──────────────────────────────────────────────────────────
// A turn run from a terminal `pi` is not in `turns`. Treat a session as live
// when its last message is an open turn (not a final assistant reply) AND a
// live `pi` process has that session's cwd as its working directory.
// ponytail: two terminal pis in one folder can mark a crashed older session
// live too; match the file each pi holds open if that matters.
const FINAL_STOPS = new Set(["stop", "error", "aborted"]);
function lastTurnOpen(jsonl: string): boolean {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"message"')) continue;
    let e: any;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.type !== "message") continue;
    return !(e.message?.role === "assistant" && FINAL_STOPS.has(e.message?.stopReason));
  }
  return false; // no messages yet
}

let piCwdCache: { at: number; cwds: Set<string> } = { at: 0, cwds: new Set() };
function piProcessCwds(): Set<string> {
  if (Date.now() - piCwdCache.at < 2_000) return piCwdCache.cwds;
  const cwds = new Set<string>();
  try {
    const ps = Bun.spawnSync(["ps", "-axo", "pid=,comm="], { stdout: "pipe" }).stdout.toString();
    const pids = ps.split("\n").map((l) => l.trim().split(/\s+/)).filter(([, c]) => c === "pi").map(([p]) => p);
    if (pids.length) {
      const out = Bun.spawnSync(["lsof", "-a", "-p", pids.join(","), "-d", "cwd", "-Fn"], { stdout: "pipe", stderr: "pipe" });
      for (const l of out.stdout.toString().split("\n")) if (l.startsWith("n")) cwds.add(l.slice(1));
    }
  } catch {} // ps/lsof missing → no terminal detection, same as before
  piCwdCache = { at: Date.now(), cwds };
  return cwds;
}

const terminalTurnActive = (file: string, cwd: string) => {
  try {
    // lsof reports resolved paths (/var → /private/var, symlinked repos).
    if (!piProcessCwds().has(realpathSync(cwd))) return false;
    return lastTurnOpen(readFileSync(file, "utf8")); } catch { return false; }
};

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

function workspaceStatus(ws: Ws): string {
  if ([...turns.values()].some((t) => t.running && t.cwd === ws.cwd)) return "in-progress";
  if (bridgeRunningIn(ws.cwd)) return "in-progress";
  const newest = ws.dir ? sessionFiles(ws.dir)[0] : null;
  if (newest && terminalTurnActive(`${ws.dir}/${newest}`, ws.cwd)) return "in-progress";
  // Fresh workspaces / no sessions on disk yet — not “done”, just waiting for first send.
  if (!ws.dir || ws.sessionCount === 0) return "not-started";
  return "done";
}

const workspaceJSON = (id: string, ws: Ws, repoId: string) => {
  const newest = ws.dir ? sessionFiles(ws.dir)[0] : null;
  return {
    id,
    repository_id: repoId,
    name: workspaceLabel(ws.cwd),
    branch: git(ws.cwd, "branch", "--show-current"),
    status: workspaceStatus(ws),
    unread: false,
    updated_at: new Date(ws.mtime).toISOString(),
    last_message_snippet: newest ? sessionSummary(`${ws.dir}/${newest}`, id).title : null,
  };
};

const workspacesOf = (repoId: string) => {
  const { workspaces, repoOf } = scanned();
  return [...workspaces]
    .filter(([id]) => repoOf.get(id) === repoId)
    .map(([id, ws]) => workspaceJSON(id, ws, repoId))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
};

const sessionsOf = (workspaceId: string) => {
  const ws = wsById(workspaceId);
  if (!ws?.dir) return [];
  return sessionFiles(ws.dir).map((f) => sessionSummary(`${ws.dir}/${f}`, workspaceId));
};

async function workspaceDiff(workspaceId: string) {
  const ws = wsById(workspaceId);
  if (!ws || !existsSync(ws.cwd)) return { error: "workspace not found", status: 404 };
  const g = (...a: string[]) =>
    new Response(Bun.spawn(["git", ...a], { cwd: ws.cwd, stdout: "pipe" }).stdout as any).text();
  const base = git(ws.cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")?.replace(/^origin\//, "") ?? "main";
  const mergeBase = (await g("merge-base", base, "HEAD").catch(() => "")).trim();
  const ref = mergeBase || base;
  const [stat, diff] = await Promise.all([g("diff", "--stat", ref), g("diff", ref)]);
  return { base, stat, diff };
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 30, // /bridge/poll holds up to 25 s; Bun's default is 10 s
  async fetch(req, server) {
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`)
      return Response.json({ error: "unauthorized" }, { status: 401 });

    const path = new URL(req.url).pathname;
    let m: RegExpMatchArray | null;
    try {
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
      if (req.method === "POST" && path === "/pi-update") {
        const result = await updatePiInstall();
        return "error" in result
          ? Response.json({ error: result.error }, { status: result.status })
          : Response.json(result);
      }
      if (req.method === "POST" && (m = path.match(/^\/sessions\/([^/]+)\/send$/))) {
        const { text, model, thinking, approvalMode, images } = await req.json();
        const hasImages = Array.isArray(images) && images.length > 0;
        if (!text?.trim() && !hasImages) return Response.json({ error: "empty message" }, { status: 400 });
        const bridge = bridgeFor(m[1]);
        // Terminal session: the terminal owns model, thinking and approval mode.
        const r = bridge
          ? await bridgeSend(bridge, (text ?? "").trim(), images)
          : sendMessage(m[1], (text ?? "").trim(), { model, thinking, approvalMode, images });
        return Response.json(r, { status: "status" in r ? (r.status as number) : 200 });
      }
      if (req.method === "POST" && (m = path.match(/^\/sessions\/([^/]+)\/ui-response$/))) {
        const r = respondUI(m[1], await req.json());
        return Response.json(r, { status: "status" in r ? (r.status as number) : 200 });
      }
      if (path === "/approval-extension") {
        return Response.json({ installed: approvalInstalled(), path: approvalPkg });
      }
      if (req.method === "POST" && path === "/approval-extension/install") {
        if (!existsSync(approvalPkg))
          return Response.json({ error: "bundled approval package missing" }, { status: 500 });
        const p = Bun.spawnSync([PI, "install", approvalPkg], { stdout: "pipe", stderr: "pipe" });
        if (p.exitCode !== 0)
          return Response.json({
            error: p.stderr.toString().trim() || p.stdout.toString().trim() || "install failed",
          }, { status: 500 });
        return Response.json({ ok: true, installed: true });
      }
      // Deleting a chat moves its session file to ~/.pi-companion/trash (recoverable).
      if (req.method === "DELETE" && (m = path.match(/^\/sessions\/([^/]+)$/))) {
        const found = findSessionFile(m[1]);
        if (!found) return Response.json({ error: "session not found" }, { status: 404 });
        const trash = `${tokenDir}/trash`;
        mkdirSync(trash, { recursive: true });
        renameSync(found.file, `${trash}/${basename(found.file)}`);
        scanCache = null;
        return Response.json({ ok: true });
      }
      // "Deleting" a workspace unregisters the folder from the app; nothing on
      // disk is touched (worktrees and session files stay).
      if (req.method === "DELETE" && (m = path.match(/^\/workspaces\/([^/]+)$/))) {
        const ws = wsById(m[1]);
        if (!ws) return Response.json({ error: "workspace not found" }, { status: 404 });
        forgetCwd(ws.cwd);
        scanCache = null;
        return Response.json({ ok: true });
      }
      // Single workspace — the chat header re-reads its name after a rename.
      if (req.method === "GET" && (m = path.match(/^\/workspaces\/([^/]+)$/))) {
        const { workspaces, repoOf } = scanned();
        const ws = workspaces.get(m[1]);
        if (!ws) return Response.json({ error: "workspace not found" }, { status: 404 });
        return Response.json(workspaceJSON(m[1], ws, repoOf.get(m[1]) ?? ""));
      }
      if (req.method === "POST" && (m = path.match(/^\/sessions\/([^/]+)\/stop$/))) {
        const bridge = bridgeFor(m[1]);
        if (bridge) {
          bridgeEnqueue(bridge, { id: crypto.randomUUID(), type: "stop" });
          return Response.json({ ok: true });
        }
        const t = turns.get(m[1]);
        try { t?.proc?.stdin?.write(JSON.stringify({ id: "stop", type: "abort" }) + "\n"); } catch (e) {
          console.warn(`stop: abort write failed, killing pi instead: ${e}`); // stdin already closed
        }
        t?.proc?.kill();
        return Response.json({ ok: true });
      }
      if ((m = path.match(/^\/sessions\/([^/]+)\/attachments$/))) {
        const rel = new URL(req.url).searchParams.get("path") ?? "";
        const found = findSessionFile(m[1]);
        if (!found) return Response.json({ error: "not found" }, { status: 404 });
        const full = resolve(found.cwd, decodeURIComponent(rel));
        if (!full.startsWith(resolve(found.cwd) + "/"))
          return Response.json({ error: "forbidden" }, { status: 403 });
        if (!existsSync(full)) return Response.json({ error: "not found" }, { status: 404 });
        return new Response(Bun.file(full));
      }
      // Browse folders on the Mac for the phone's project picker.
      if (path === "/browse") {
        const q = new URL(req.url).searchParams.get("path") || homedir();
        const dir = resolve(q.startsWith("~/") ? `${homedir()}/${q.slice(2)}` : q);
        if (!existsSync(dir) || !statSync(dir).isDirectory())
          return Response.json({ error: "not a folder" }, { status: 404 });
        const dirs = readdirSync(dir)
          .filter((n) => !n.startsWith(".") && n !== "node_modules")
          .filter((n) => { try { return statSync(`${dir}/${n}`).isDirectory(); } catch { return false; } })
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        return Response.json({ path: dir, parent: dir === "/" ? null : dirname(dir), dirs });
      }
      // Register a project folder that has no Pi sessions yet.
      if (req.method === "POST" && path === "/projects") {
        const { path: dir } = await req.json();
        const full = dir?.startsWith("~/") ? `${homedir()}/${dir.slice(2)}` : dir;
        if (!full || !existsSync(full) || !statSync(full).isDirectory())
          return Response.json({ error: "folder not found on this Mac" }, { status: 404 });
        rememberCwd(resolve(full));
        scanCache = null;
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && (m = path.match(/^\/repos\/([^/]+)\/workspaces$/))) {
        const r = createWorkspace(m[1]);
        return "error" in r ? Response.json({ error: r.error }, { status: r.status }) : Response.json(r);
      }
      if (req.method === "POST" && (m = path.match(/^\/workspaces\/([^/]+)\/sessions$/))) {
        const r = createSession(m[1]);
        return Response.json(r, { status: "status" in r ? (r.status as number) : 200 });
      }
      if ((m = path.match(/^\/workspaces\/([^/]+)\/diffstat$/))) {
        const ws = wsById(m[1]);
        if (!ws) return Response.json({ error: "not found" }, { status: 404 });
        const short = git(ws.cwd, "diff", "--shortstat", "HEAD") ?? "";
        return Response.json({
          insertions: Number(short.match(/(\d+) insertion/)?.[1] ?? 0),
          deletions: Number(short.match(/(\d+) deletion/)?.[1] ?? 0),
        });
      }
      if ((m = path.match(/^\/workspaces\/([^/]+)\/diff$/))) {
        const r = await workspaceDiff(m[1]);
        return Response.json(r, { status: "status" in r ? (r.status as number) : 200 });
      }
      if ((m = path.match(/^\/sessions\/([^/]+)\/status$/))) {
        const bridge = bridgeFor(m[1]);
        if (bridge) return Response.json({ running: bridge.running, activity: bridge.activity, pending_ui: null });
        const t = turns.get(m[1]);
        const f = t?.running ? null : findSessionFile(m[1]);
        return Response.json({
          running: !!t?.running || (!!f && terminalTurnActive(f.file, f.cwd)),
          activity: t?.activity ?? "",
          pending_ui: t?.pendingUI ?? null,
        });
      }
      if (path === "/models") return Response.json(modelCache);
      if (path === "/skills") return Response.json(skillCache);
      if (path === "/pi-version") return Response.json(piVersionCache);
      if (path === "/repos") return Response.json(repos());
      if ((m = path.match(/^\/repos\/([^/]+)\/workspaces$/))) return Response.json(workspacesOf(m[1]));
      if ((m = path.match(/^\/workspaces\/([^/]+)\/sessions$/))) return Response.json(sessionsOf(m[1]));
      if ((m = path.match(/^\/sessions\/([^/]+)\/messages$/))) {
        const r = displayMessages(m[1]);
        return Response.json(r, { status: "status" in r && !Array.isArray(r) ? (r as any).status : 200 });
      }
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});

console.log(`Pi companion listening on http://0.0.0.0:${PORT}`);
console.log(`Auth token: ${TOKEN}`);

// Pairing QR: scan with the iPhone Camera app to open the app with the
// address + token pre-filled.
import { hostname } from "os";
import qrcode from "qrcode-terminal"; // bun auto-installs on first run
const host = hostname().replace(/\.local$/, "");
const pairURL =
  `pi-companion://pair?name=${encodeURIComponent(host)}` +
  `&addr=${encodeURIComponent(`http://${host}.local:${PORT}`)}&token=${TOKEN}`;
qrcode.generate(pairURL, { small: true });
console.log(`Scan with the iPhone camera to pair (same network), or enter the token manually.`);
