import { describe, expect, test } from "vitest";
import {
  buildWorkflowPhaseTree,
  formatWorkflowElapsed,
  resolveAgentElapsedMs,
  resolveCurrentPhaseIndex,
  resolveRunElapsedMs,
  summarizeWorkflowPhases,
} from "./workflow-run-phase-tree";

interface EntryInput {
  event: string;
  message?: string;
  ts?: string;
  data?: Record<string, unknown>;
}

function entries(list: EntryInput[]) {
  return list.map((input, index) => ({
    seq: index + 1,
    ts: input.ts ?? "2026-07-19T00:00:00.000Z",
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

  test("queued agents show up before their start event lands", () => {
    const groups = buildWorkflowPhaseTree(
      entries([
        { event: "agent.queued", data: { callId: 1, label: "waiting", phase: "Sweep" } },
        { event: "agent.queued", data: { callId: 2, label: "also-waiting", phase: "Sweep" } },
        { event: "agent.start", data: { callId: 1, label: "waiting", phase: "Sweep" } },
      ]),
    );
    expect(groups[0]?.agents.map((agent) => [agent.label, agent.status])).toEqual([
      ["waiting", "running"],
      ["also-waiting", "queued"],
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

  test("pairs a call with the agent its agent.done named", () => {
    const groups = buildWorkflowPhaseTree(
      entries([
        { event: "agent.start", data: { callId: 1, label: "implement", phase: "Build" } },
        { event: "agent.start", data: { callId: 2, label: "review", phase: "Build" } },
        { event: "agent.done", data: { callId: 1, agentId: "agent-a" } },
        { event: "agent.complete", data: { callId: 1, label: "implement", phase: "Build" } },
      ]),
    );

    expect(groups[0]?.agents.map((agent) => [agent.label, agent.agentId])).toEqual([
      ["implement", "agent-a"],
      ["review", null],
    ]);
  });

  test("a retried call ends up pointing at the newest agent", () => {
    const groups = buildWorkflowPhaseTree(
      entries([
        { event: "agent.start", data: { callId: 1, label: "flaky", phase: "Build" } },
        { event: "agent.failed", data: { callId: 1, agentId: "agent-first" } },
        { event: "agent.retry", data: { callId: 1, label: "flaky", phase: "Build", attempt: 1 } },
        { event: "agent.done", data: { callId: 1, agentId: "agent-second" } },
      ]),
    );

    expect(groups[0]?.agents[0]?.agentId).toBe("agent-second");
  });
});

describe("phase tree timestamps", () => {
  test("records start and end stamps from the agent events", () => {
    const groups = buildWorkflowPhaseTree(
      entries([
        {
          event: "agent.start",
          ts: "2026-07-19T00:00:00.000Z",
          data: { callId: 1, label: "explore", phase: "Find" },
        },
        {
          event: "agent.complete",
          ts: "2026-07-19T00:01:02.000Z",
          data: { callId: 1, label: "explore", phase: "Find" },
        },
        {
          event: "agent.start",
          ts: "2026-07-19T00:00:10.000Z",
          data: { callId: 2, label: "callers", phase: "Find" },
        },
      ]),
    );

    expect(groups[0]?.agents[0]).toMatchObject({
      startedAt: "2026-07-19T00:00:00.000Z",
      endedAt: "2026-07-19T00:01:02.000Z",
    });
    expect(groups[0]?.agents[1]).toMatchObject({
      startedAt: "2026-07-19T00:00:10.000Z",
      endedAt: null,
    });
  });

  test("leaves a queued call without a start stamp", () => {
    const groups = buildWorkflowPhaseTree(
      entries([{ event: "agent.queued", data: { callId: 1, label: "waiting", phase: "Sweep" } }]),
    );
    expect(groups[0]?.agents[0]).toMatchObject({ startedAt: null, endedAt: null });
  });

  test("a retry restarts the clock and clears the previous terminal stamp", () => {
    const groups = buildWorkflowPhaseTree(
      entries([
        { event: "agent.start", ts: "2026-07-19T00:00:00.000Z", data: { callId: 1, phase: "J" } },
        { event: "agent.error", ts: "2026-07-19T00:00:05.000Z", data: { callId: 1, phase: "J" } },
        { event: "agent.retry", ts: "2026-07-19T00:00:06.000Z", data: { callId: 1, phase: "J" } },
      ]),
    );
    expect(groups[0]?.agents[0]).toMatchObject({
      status: "retrying",
      startedAt: "2026-07-19T00:00:06.000Z",
      endedAt: null,
    });
  });

  test("records the terminal stamp for a failed call", () => {
    const groups = buildWorkflowPhaseTree(
      entries([
        { event: "agent.start", ts: "2026-07-19T00:00:00.000Z", data: { callId: 1, phase: "J" } },
        { event: "agent.error", ts: "2026-07-19T00:00:05.000Z", data: { callId: 1, phase: "J" } },
      ]),
    );
    expect(groups[0]?.agents[0]?.endedAt).toBe("2026-07-19T00:00:05.000Z");
  });
});

describe("summarizeWorkflowPhases", () => {
  const tree = () =>
    buildWorkflowPhaseTree(
      entries([
        { event: "phase", message: "triage" },
        { event: "agent.start", data: { callId: 1, phase: "triage" } },
        { event: "agent.complete", data: { callId: 1, phase: "triage" } },
        { event: "phase", message: "rca" },
        { event: "agent.start", data: { callId: 2, phase: "rca" } },
        { event: "agent.queued", data: { callId: 3, phase: "rca" } },
        { event: "agent.error", data: { callId: 4, phase: "rca" } },
        { event: "phase", message: "plan" },
      ]),
    );

  test("counts terminal calls as done and flags phases still working", () => {
    expect(summarizeWorkflowPhases(tree())).toEqual([
      { title: "triage", total: 1, done: 1, hasActive: false },
      { title: "rca", total: 3, done: 1, hasActive: true },
      { title: "plan", total: 0, done: 0, hasActive: false },
    ]);
  });

  test("counts an errored call as done, not as still running", () => {
    const groups = buildWorkflowPhaseTree(
      entries([{ event: "agent.error", data: { callId: 1, phase: "one" } }]),
    );
    expect(summarizeWorkflowPhases(groups)[0]).toMatchObject({ done: 1, hasActive: false });
  });

  test("current phase is the first one still working", () => {
    expect(resolveCurrentPhaseIndex(tree())).toBe(1);
  });

  test("a finished run rests on its last phase that ran anything", () => {
    const groups = buildWorkflowPhaseTree(
      entries([
        { event: "phase", message: "one" },
        { event: "agent.complete", data: { callId: 1, phase: "one" } },
        { event: "phase", message: "two" },
        { event: "agent.complete", data: { callId: 2, phase: "two" } },
        { event: "phase", message: "three" },
      ]),
    );
    expect(resolveCurrentPhaseIndex(groups)).toBe(1);
  });

  test("reports no current phase for an empty tree", () => {
    expect(resolveCurrentPhaseIndex([])).toBe(-1);
  });
});

describe("elapsed helpers", () => {
  const nowMs = Date.parse("2026-07-19T00:05:00.000Z");

  test("measures a finished call between its own stamps", () => {
    expect(
      resolveAgentElapsedMs(
        { startedAt: "2026-07-19T00:00:00.000Z", endedAt: "2026-07-19T00:01:02.000Z" },
        nowMs,
      ),
    ).toBe(62_000);
  });

  test("measures an in-flight call up to now", () => {
    expect(resolveAgentElapsedMs({ startedAt: "2026-07-19T00:04:12.000Z", endedAt: null }, nowMs)) //
      .toBe(48_000);
  });

  test("returns null for a call that never started or has an unusable stamp", () => {
    expect(resolveAgentElapsedMs({ startedAt: null, endedAt: null }, nowMs)).toBeNull();
    expect(resolveAgentElapsedMs({ startedAt: "not-a-date", endedAt: null }, nowMs)).toBeNull();
  });

  test("never reports negative elapsed when stamps arrive out of order", () => {
    expect(
      resolveAgentElapsedMs(
        { startedAt: "2026-07-19T00:01:00.000Z", endedAt: "2026-07-19T00:00:00.000Z" },
        nowMs,
      ),
    ).toBe(0);
  });

  test("times the run from startedAt, stopping at endedAt", () => {
    expect(
      resolveRunElapsedMs({ startedAt: "2026-07-19T00:00:00.000Z", endedAt: null }, nowMs),
    ).toBe(300_000);
    expect(
      resolveRunElapsedMs(
        { startedAt: "2026-07-19T00:00:00.000Z", endedAt: "2026-07-19T00:12:30.000Z" },
        nowMs,
      ),
    ).toBe(750_000);
  });

  test("a queued run that never started has no elapsed time", () => {
    expect(resolveRunElapsedMs({ startedAt: null, endedAt: null }, nowMs)).toBeNull();
  });
});

describe("formatWorkflowElapsed", () => {
  test("matches the wireframe timer shapes", () => {
    expect(formatWorkflowElapsed(48_000)).toBe("48s");
    expect(formatWorkflowElapsed(62_000)).toBe("1m 02s");
    expect(formatWorkflowElapsed(750_000)).toBe("12m 30s");
    expect(formatWorkflowElapsed(3_840_000)).toBe("1h 04m");
  });

  test("zero-pads seconds so the column stays aligned", () => {
    expect(formatWorkflowElapsed(120_000)).toBe("2m 00s");
  });

  test("renders a dash when there is nothing to time", () => {
    expect(formatWorkflowElapsed(null)).toBe("—");
    expect(formatWorkflowElapsed(Number.NaN)).toBe("—");
    expect(formatWorkflowElapsed(-1)).toBe("—");
  });
});
