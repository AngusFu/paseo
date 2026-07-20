import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { normalizeWorkspaceFileLocation, workspaceFileLocationsEqual } from "@/workspace/file-open";

type WorkspaceDraftTabSetup = NonNullable<Extract<WorkspaceTabTarget, { kind: "draft" }>["setup"]>;

export function normalizeWorkspaceTabTarget(
  value: WorkspaceTabTarget | null | undefined,
): WorkspaceTabTarget | null {
  if (!value || typeof value !== "object" || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "draft") {
    return normalizeDraftTarget(value);
  }
  if (value.kind === "agent") {
    const agentId = trimNonEmpty(value.agentId);
    return agentId ? { kind: "agent", agentId } : null;
  }
  if (value.kind === "provider_subagent") {
    const parentAgentId = trimNonEmpty(value.parentAgentId);
    const subagentId = trimNonEmpty(value.subagentId);
    return parentAgentId && subagentId
      ? { kind: "provider_subagent", parentAgentId, subagentId }
      : null;
  }
  if (value.kind === "file") {
    return normalizeFileTabTarget(value);
  }
  return normalizeSimpleWorkspaceTabTarget(value);
}

function normalizeSimpleWorkspaceTabTarget(value: WorkspaceTabTarget): WorkspaceTabTarget | null {
  switch (value.kind) {
    case "agent": {
      const agentId = trimNonEmpty(value.agentId);
      return agentId ? { kind: "agent", agentId } : null;
    }
    case "workflow_run": {
      const runId = trimNonEmpty(value.runId);
      return runId ? { kind: "workflow_run", runId } : null;
    }
    case "terminal": {
      const terminalId = trimNonEmpty(value.terminalId);
      return terminalId ? { kind: "terminal", terminalId } : null;
    }
    case "browser": {
      const browserId = trimNonEmpty(value.browserId);
      return browserId ? { kind: "browser", browserId } : null;
    }
    case "setup": {
      const workspaceId = trimNonEmpty(value.workspaceId);
      return workspaceId ? { kind: "setup", workspaceId } : null;
    }
    case "commit_diff": {
      const sha = trimNonEmpty(value.sha);
      return sha ? { kind: "commit_diff", sha } : null;
    }
    default:
      return null;
  }
}

function normalizeDraftTarget(
  value: Extract<WorkspaceTabTarget, { kind: "draft" }>,
): WorkspaceTabTarget | null {
  const draftId = trimNonEmpty(value.draftId);
  if (!draftId) {
    return null;
  }
  const setup = normalizeWorkspaceDraftTabSetup(value.setup);
  return setup ? { kind: "draft", draftId, setup } : { kind: "draft", draftId };
}

export function normalizeWorkspaceDraftTabSetup(
  value: unknown,
): WorkspaceDraftTabSetup | undefined {
  const record = isPlainRecord(value) ? value : null;
  if (!record) {
    return undefined;
  }
  const provider = trimNonEmpty(typeof record.provider === "string" ? record.provider : null);
  const cwd = trimNonEmpty(typeof record.cwd === "string" ? record.cwd : null);
  if (!provider || !cwd) {
    return undefined;
  }
  return {
    provider,
    cwd,
    modeId: trimOptionalString(typeof record.modeId === "string" ? record.modeId : null),
    model: trimOptionalString(typeof record.model === "string" ? record.model : null),
    thinkingOptionId: trimOptionalString(
      typeof record.thinkingOptionId === "string" ? record.thinkingOptionId : null,
    ),
    featureValues: isPlainRecord(record.featureValues) ? { ...record.featureValues } : {},
  };
}

export function workspaceTabTargetsEqual(
  left: WorkspaceTabTarget,
  right: WorkspaceTabTarget,
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  // The kinds are equal above, so `right` can be narrowed to `left`'s branch.
  type Same<K extends WorkspaceTabTarget["kind"]> = Extract<WorkspaceTabTarget, { kind: K }>;
  switch (left.kind) {
    case "draft": {
      const other = right as Same<"draft">;
      return (
        left.draftId === other.draftId && workspaceDraftTabSetupsEqual(left.setup, other.setup)
      );
    }
    case "agent":
      return left.agentId === (right as Same<"agent">).agentId;
    case "provider_subagent": {
      const other = right as Same<"provider_subagent">;
      return left.parentAgentId === other.parentAgentId && left.subagentId === other.subagentId;
    }
    case "workflow_run":
      return left.runId === (right as Same<"workflow_run">).runId;
    case "terminal":
      return left.terminalId === (right as Same<"terminal">).terminalId;
    case "browser":
      return left.browserId === (right as Same<"browser">).browserId;
    case "file":
      return workspaceFileLocationsEqual(left, right as Same<"file">);
    case "setup":
      return left.workspaceId === (right as Same<"setup">).workspaceId;
    case "commit_diff":
      return left.sha === (right as Same<"commit_diff">).sha;
    default:
      return false;
  }
}

function workspaceDraftTabSetupsEqual(
  left: WorkspaceDraftTabSetup | undefined,
  right: WorkspaceDraftTabSetup | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return (
    left.provider === right.provider &&
    left.cwd === right.cwd &&
    left.modeId === right.modeId &&
    left.model === right.model &&
    left.thinkingOptionId === right.thinkingOptionId &&
    recordsShallowEqual(left.featureValues, right.featureValues)
  );
}

function recordsShallowEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !Object.is(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

export function buildDeterministicWorkspaceTabId(target: WorkspaceTabTarget): string {
  if (target.kind === "draft") {
    return target.draftId;
  }
  if (target.kind === "agent") {
    return `agent_${target.agentId}`;
  }
  if (target.kind === "provider_subagent") {
    return `provider_subagent_${target.parentAgentId.length}_${target.parentAgentId}_${target.subagentId.length}_${target.subagentId}`;
  }
  if (target.kind === "workflow_run") {
    return `workflow_run_${target.runId}`;
  }
  if (target.kind === "terminal") {
    return `terminal_${target.terminalId}`;
  }
  if (target.kind === "browser") {
    return `browser_${target.browserId}`;
  }
  if (target.kind === "setup") {
    return `setup_${target.workspaceId}`;
  }
  if (target.kind === "commit_diff") {
    return `commit_diff_${target.sha}`;
  }
  return `file_${target.path}`;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeFileTabTarget(
  value: Extract<WorkspaceTabTarget, { kind: "file" }>,
): WorkspaceTabTarget | null {
  const location = normalizeWorkspaceFileLocation(value);
  return location ? { kind: "file", ...location } : null;
}

function trimOptionalString(value: string | null | undefined): string | null {
  return value == null ? null : trimNonEmpty(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
