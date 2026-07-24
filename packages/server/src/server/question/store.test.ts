import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { QuestionStore } from "./store.js";

describe("QuestionStore", () => {
  let tempDir: string;
  let store: QuestionStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "question-store-test-"));
    store = new QuestionStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("creates pending questions and reloads from disk", async () => {
    const created = await store.create({
      agentId: "agent-1",
      workspaceId: "wks_1",
      title: "Deploy",
      source: "mcp",
      mcpRequestId: "mcp-question-1",
      questions: [
        {
          question: "Where?",
          header: "Env",
          options: [{ label: "staging" }, { label: "production" }],
        },
      ],
    });

    expect(created.id).toMatch(/^qst_[0-9a-f]{8}$/);
    expect(created.status).toBe("pending");
    expect(created.source).toBe("mcp");
    expect(created.mcpRequestId).toBe("mcp-question-1");

    const reloaded = new QuestionStore(tempDir);
    expect(await reloaded.list()).toEqual([created]);
    expect(await reloaded.get(created.id)).toEqual(created);
  });

  test("filters by status and agentId", async () => {
    const first = await store.create({
      agentId: "agent-a",
      source: "mcp",
      questions: [{ question: "A?", header: "A" }],
    });
    const second = await store.create({
      agentId: "agent-b",
      source: "cli",
      questions: [{ question: "B?", header: "B" }],
    });
    await store.markAnswered(second.id, { B: "yes" });

    expect(await store.list({ status: "pending" })).toEqual([first]);
    expect(await store.list({ agentId: "agent-b" })).toEqual([
      expect.objectContaining({ id: second.id, status: "answered", answers: { B: "yes" } }),
    ]);
  });

  test("markDismissed clears answers", async () => {
    const created = await store.create({
      agentId: "agent-1",
      source: "mcp",
      questions: [{ question: "A?", header: "A" }],
    });
    await store.markAnswered(created.id, { A: "x" });
    const dismissed = await store.markDismissed(created.id);
    expect(dismissed?.status).toBe("dismissed");
    expect(dismissed?.answers).toBeUndefined();
  });
});
