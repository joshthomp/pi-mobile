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
