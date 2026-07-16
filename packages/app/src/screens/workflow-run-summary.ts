import type { WorkflowRun, WorkflowRunStatus } from "@getpaseo/protocol/workflow/types";

export interface WorkflowRunSummary {
  task: string | null;
  /** Nested / top-level failure message, if any. */
  outcome: string | null;
  /** Status to show in UI — remaps stored `succeeded` when the result carries an error. */
  displayStatus: WorkflowRunStatus;
  agentCalls: number | null;
  argsPreview: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractNestedError(run: WorkflowRun): string | null {
  const fromField = readString(run.error);
  if (fromField) {
    return fromField;
  }
  const result = asRecord(run.result);
  if (!result) {
    return null;
  }
  const inner = asRecord(result.result);
  return readString(inner?.error) ?? readString(result.error);
}

export function summarizeWorkflowRun(run: WorkflowRun): WorkflowRunSummary {
  const args = asRecord(run.args) ?? {};
  const task = readString(args.task) ?? readString(args.prompt) ?? readString(args.title);
  const outcome = extractNestedError(run);
  const displayStatus: WorkflowRunStatus =
    run.status === "succeeded" && outcome ? "failed" : run.status;

  const result = asRecord(run.result);
  const stats = asRecord(result?.stats);
  let agentCalls: number | null = null;
  if (typeof stats?.agentCalls === "number") {
    agentCalls = stats.agentCalls;
  } else if (typeof stats?.agentCalls === "string" && Number.isFinite(Number(stats.agentCalls))) {
    agentCalls = Number(stats.agentCalls);
  }

  const meaningfulArgs = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== "runtimeDir" && key !== "key"),
  );
  const argsPreview = Object.keys(meaningfulArgs).length > 0 ? compactJson(meaningfulArgs) : null;

  return {
    task,
    outcome,
    displayStatus,
    agentCalls,
    argsPreview,
  };
}

function compactJson(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (!text) {
      return String(value);
    }
    return text.length > 180 ? `${text.slice(0, 179)}…` : text;
  } catch {
    return String(value);
  }
}
