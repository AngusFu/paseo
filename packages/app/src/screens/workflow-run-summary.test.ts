import { describe, expect, test } from "vitest";
import type { WorkflowRun } from "@getpaseo/protocol/workflow/types";
import { summarizeWorkflowRun } from "./workflow-run-summary.js";

function run(partial: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: "wfr_1",
    definitionId: "wfd_1",
    status: "succeeded",
    args: {},
    cwd: "/tmp",
    workspaceId: null,
    workspacePath: "/tmp",
    queuedAt: "2026-07-16T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    result: null,
    error: null,
    ...partial,
  };
}

describe("summarizeWorkflowRun", () => {
  test("surfaces nested engine errors and remaps succeeded → failed", () => {
    expect(
      summarizeWorkflowRun(
        run({
          args: { task: "fix the login bug" },
          result: {
            result: { error: "No task provided" },
            stats: { agentCalls: 0 },
          },
        }),
      ),
    ).toEqual({
      task: "fix the login bug",
      outcome: "No task provided",
      displayStatus: "failed",
      agentCalls: 0,
      argsPreview: '{"task":"fix the login bug"}',
    });
  });

  test("keeps succeeded when result has no error", () => {
    expect(
      summarizeWorkflowRun(
        run({
          args: { task: "ship it" },
          result: { result: { ok: true }, stats: { agentCalls: 2 } },
        }),
      ),
    ).toMatchObject({
      task: "ship it",
      outcome: null,
      displayStatus: "succeeded",
      agentCalls: 2,
    });
  });
});
