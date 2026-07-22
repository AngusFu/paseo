import { describe, expect, test } from "vitest";
import type { WorkflowLogEntry } from "@getpaseo/protocol/workflow/types";
import {
  buildWorkflowLogCopyText,
  buildWorkflowLogEntryCopyText,
  formatWorkflowLogEntryId,
  formatWorkflowLogEntrySeq,
} from "./workflow-run-log-entry.js";

function entry(partial: Partial<WorkflowLogEntry>): WorkflowLogEntry {
  return {
    seq: 12,
    ts: "2026-07-16T09:14:38.000Z",
    level: "info",
    event: "run.start",
    message: "start p2-smoke via paseo-host",
    ...partial,
  };
}

describe("workflow run log entry identity", () => {
  test("id pairs the run with the daemon's own sequence number", () => {
    expect(formatWorkflowLogEntryId("wfr_abc", 12)).toBe("wfr_abc#12");
    expect(formatWorkflowLogEntrySeq(12)).toBe("#12");
  });

  test("copy text leads with the id and keeps the raw ISO timestamp", () => {
    expect(buildWorkflowLogEntryCopyText("wfr_abc", entry({}))).toBe(
      "[wfr_abc#12] 2026-07-16T09:14:38.000Z INFO run.start start p2-smoke via paseo-host",
    );
  });

  test("copy text appends the structured payload the UI never renders", () => {
    expect(
      buildWorkflowLogEntryCopyText(
        "wfr_abc",
        entry({ level: "error", event: "run.failed", data: { exitCode: 1 } }),
      ),
    ).toBe(
      "[wfr_abc#12] 2026-07-16T09:14:38.000Z ERROR run.failed start p2-smoke via paseo-host\n" +
        '  data: {"exitCode":1}',
    );
  });

  test("an empty data object does not add a trailing line", () => {
    expect(buildWorkflowLogEntryCopyText("wfr_abc", entry({ data: {} }))).toBe(
      "[wfr_abc#12] 2026-07-16T09:14:38.000Z INFO run.start start p2-smoke via paseo-host",
    );
  });

  test("copy-all keeps every line individually addressable", () => {
    expect(
      buildWorkflowLogCopyText("wfr_abc", [
        entry({ seq: 1, event: "run.queued", message: "queued p2-smoke" }),
        entry({ seq: 2 }),
      ]),
    ).toBe(
      "[wfr_abc#1] 2026-07-16T09:14:38.000Z INFO run.queued queued p2-smoke\n" +
        "[wfr_abc#2] 2026-07-16T09:14:38.000Z INFO run.start start p2-smoke via paseo-host",
    );
  });

  test("empty log copies to an empty string", () => {
    expect(buildWorkflowLogCopyText("wfr_abc", [])).toBe("");
  });
});
