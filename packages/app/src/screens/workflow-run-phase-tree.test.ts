import { describe, expect, test } from "vitest";
import { buildWorkflowPhaseTree } from "./workflow-run-phase-tree";

interface EntryInput {
  event: string;
  message?: string;
  data?: Record<string, unknown>;
}

function entries(list: EntryInput[]) {
  return list.map((input, index) => ({
    seq: index + 1,
    ts: "2026-07-19T00:00:00.000Z",
    level: "info" as const,
    event: input.event,
    message: input.message ?? "",
    ...(input.data ? { data: input.data } : {}),
  }));
}

describe("buildWorkflowPhaseTree", () => {
  test("groups agent calls under phases in first-seen order with live statuses", () => {
    const groups = buildWorkflowPhaseTree(
      entries([
        { event: "phase", message: "Find" },
        { event: "agent.start", data: { callId: 1, label: "review:bugs", phase: "Find" } },
        { event: "agent.start", data: { callId: 2, label: "review:perf", phase: "Find" } },
        { event: "agent.complete", data: { callId: 1, label: "review:bugs", phase: "Find" } },
        { event: "phase", message: "Verify" },
        { event: "agent.start", data: { callId: 3, label: "verify", phase: "Verify" } },
        { event: "agent.retry", data: { callId: 3, label: "verify", phase: "Verify", attempt: 1 } },
        { event: "agent.error", data: { callId: 3, label: "verify", phase: "Verify" } },
      ]),
    );

    expect(groups.map((group) => group.title)).toEqual(["Find", "Verify"]);
    expect(groups[0]?.agents.map((agent) => [agent.label, agent.status])).toEqual([
      ["review:bugs", "done"],
      ["review:perf", "running"],
    ]);
    expect(groups[1]?.agents.map((agent) => [agent.label, agent.status])).toEqual([
      ["verify", "error"],
    ]);
  });

  test("retry marks the agent retrying until a terminal event lands", () => {
    const groups = buildWorkflowPhaseTree(
      entries([
        { event: "agent.start", data: { callId: 1, label: "judge", phase: "Judge" } },
        { event: "agent.retry", data: { callId: 1, label: "judge", phase: "Judge", attempt: 1 } },
      ]),
    );
    expect(groups[0]?.agents[0]?.status).toBe("retrying");
  });

  test("keeps cache hits and phase-less calls, and shows an ungrouped bucket only when needed", () => {
    const groups = buildWorkflowPhaseTree(
      entries([
        { event: "agent.start", data: { callId: 1, label: "scout", cached: true } },
        { event: "agent.complete", data: { callId: 1, label: "scout", cached: true } },
        { event: "phase", message: "Empty" },
      ]),
    );

    expect(groups.map((group) => group.title)).toEqual([null, "Empty"]);
    expect(groups[0]?.agents[0]).toMatchObject({ label: "scout", cached: true, status: "done" });
    expect(groups[1]?.agents).toEqual([]);
  });

  test("returns empty for entries from an older daemon without callId data", () => {
    const groups = buildWorkflowPhaseTree(
      entries([
        { event: "agent.started", message: "spawn" },
        { event: "agent.done", message: "ok 12c" },
        { event: "phase", message: "Scan" },
      ]),
    );
    expect(groups).toEqual([]);
  });
});
