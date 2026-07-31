import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FileAgentTimelineStore } from "./durable-agent-timeline-store.js";

describe("FileAgentTimelineStore", () => {
  it("persists rows across store instances", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "paseo-timeline-"));
    const first = new FileAgentTimelineStore(rootDir);
    await first.appendCommitted("agent-1", { type: "user_message", text: "hello" });
    await first.appendCommitted("agent-1", { type: "assistant_message", text: "world" });

    const second = new FileAgentTimelineStore(rootDir);
    const rows = await second.getCommittedRows("agent-1");
    expect(rows.map((row) => row.item)).toEqual([
      { type: "user_message", text: "hello" },
      { type: "assistant_message", text: "world" },
    ]);
    expect(await second.getLatestCommittedSeq("agent-1")).toBe(2);
    expect(await second.getLastAssistantMessage("agent-1")).toBe("world");

    const raw = await readFile(join(rootDir, "agent-1.json"), "utf8");
    const parsed = JSON.parse(raw) as { nextSeq: number; rows: unknown[] };
    expect(parsed.nextSeq).toBe(3);
    expect(parsed.rows).toHaveLength(2);
  });

  it("bulkInsert merges by seq and deleteAgent removes the file", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "paseo-timeline-"));
    const store = new FileAgentTimelineStore(rootDir);
    await store.bulkInsert("agent-2", [
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "user_message", text: "one" },
      },
      {
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "two" },
      },
    ]);
    await store.bulkInsert("agent-2", [
      {
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "two-updated" },
      },
      {
        seq: 3,
        timestamp: "2026-01-01T00:00:02.000Z",
        item: {
          type: "tool_call",
          callId: "c1",
          name: "Shell",
          status: "completed",
          error: null,
          detail: { type: "unknown", input: { cmd: "ls" }, output: "ok" },
        },
      },
    ]);

    const rows = await store.getCommittedRows("agent-2");
    expect(rows).toHaveLength(3);
    expect(rows[1]?.item).toEqual({ type: "assistant_message", text: "two-updated" });
    expect(rows[2]?.item.type).toBe("tool_call");

    await store.deleteAgent("agent-2");
    expect(await store.getCommittedRows("agent-2")).toEqual([]);
    expect(await store.getLatestCommittedSeq("agent-2")).toBe(0);
  });
});
