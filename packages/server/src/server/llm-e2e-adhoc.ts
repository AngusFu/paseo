// Ad-hoc manual e2e for the llm.local.* RPCs (docs/ad-hoc-daemon-testing.md).
// Not part of the automated suite (needs a real GGUF model + minutes of CPU
// inference). Run it by hand with:
//   npx tsx packages/server/src/server/llm-e2e-adhoc.ts /path/to/any-gemma.gguf (symlinked in as the default model)
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";

const modelSource = process.argv[2];
if (!modelSource) {
  console.error("usage: npx tsx llm-e2e-adhoc.ts <modelPath>");
  process.exit(1);
}

const daemon = await createTestPaseoDaemon();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${daemon.port}/ws`,
  appVersion: "0.1.110",
});
await client.connect();

try {
  const before = await client.llmLocalStatus();
  console.log("status before model install:", JSON.stringify(before.model));
  if (before.model.status !== "absent") {
    throw new Error(`expected absent, got ${before.model.status}`);
  }

  const modelsDir = path.join(daemon.paseoHome, "models");
  await mkdir(modelsDir, { recursive: true });
  await symlink(modelSource, path.join(modelsDir, "gemma4-v2-Q4_K_M.gguf"));

  const after = await client.llmLocalStatus();
  console.log("status after model install:", JSON.stringify(after.model));
  if (after.model.status !== "ready") {
    throw new Error(`expected ready, got ${after.model.status}`);
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
