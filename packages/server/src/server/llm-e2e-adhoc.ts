// Ad-hoc manual e2e for the llm.local.* RPCs (docs/ad-hoc-daemon-testing.md).
// Not part of the automated suite — needs a reachable OpenAI-compatible backend.
// Run by hand with:
//   LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1 LOCAL_LLM_MODEL=qwen3.5:0.8b \
//     npx tsx packages/server/src/server/llm-e2e-adhoc.ts
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const baseUrl = process.env.LOCAL_LLM_BASE_URL?.trim();
const model = process.env.LOCAL_LLM_MODEL?.trim();
if (!baseUrl || !model) {
  console.error(
    "usage: LOCAL_LLM_BASE_URL=http://127.0.0.1:11434/v1 LOCAL_LLM_MODEL=<model> npx tsx llm-e2e-adhoc.ts",
  );
  process.exit(1);
}

const daemon = await createTestPaseoDaemon();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${daemon.port}/ws`,
  appVersion: "0.1.110",
});
await client.connect();

try {
  await client.patchDaemonConfig({
    localLlm: {
      baseUrl,
      model,
      apiKey: process.env.LOCAL_LLM_API_KEY?.trim() || undefined,
    },
  });

  const before = await client.llmLocalStatus();
  console.log("status after config:", JSON.stringify(before.model));
  if (before.model.status !== "ready") {
    throw new Error(`expected ready, got ${before.model.status}`);
  }

  const cronSchema = {
    type: "object",
    properties: { expression: { type: "string" } },
    required: ["expression"],
  };
  const systemPrompt =
    "You convert natural-language scheduling requests into standard 5-field cron " +
    "expressions (minute hour day-of-month month day-of-week). Respond with JSON only.";

  for (const prompt of [
    "每个工作日早上九点半",
    "every 15 minutes between 9am and 6pm on weekdays",
  ]) {
    const t0 = Date.now();
    const result = await client.llmLocalGenerate({
      prompt,
      systemPrompt,
      jsonSchema: cronSchema,
      maxTokens: 128,
      timeoutMs: 300_000,
    });
    if (result.error || !result.text) {
      throw new Error(`generate failed: ${result.error}`);
    }
    const parsed = JSON.parse(result.text) as { expression: string };
    console.log(`"${prompt}" -> ${parsed.expression}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  console.log("E2E OK");
} finally {
  await client.close();
  await daemon.close();
}
