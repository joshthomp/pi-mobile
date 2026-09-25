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
