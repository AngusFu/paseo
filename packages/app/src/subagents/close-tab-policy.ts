import {
  getWorkflowRunIdFromLabels,
  getWorkflowRunWorkspaceFromLabels,
} from "@getpaseo/protocol/agent-labels";
import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

export function resolveCloseAgentTabPolicy(
  agent: Pick<Agent, "parentAgentId" | "labels" | "workspaceId"> | null | undefined,
): CloseAgentTabPolicy {
  if (agent?.parentAgentId) {
    return { kind: "layout-only" };
  }
  // A workflow-run agent folded under its run's synthetic tab: closing an
  // explicitly opened agent tab must not archive the agent mid-run. A
  // worktree-isolated run agent (its own workspace differs from the run's
  // home workspace) surfaces as a normal tab and keeps archive-on-close —
  // layout-only would bounce straight back via auto-open.
  if (getWorkflowRunIdFromLabels(agent?.labels)) {
    const runWorkspaceId = normalizeWorkspaceOpaqueId(
      getWorkflowRunWorkspaceFromLabels(agent?.labels),
    );
    const agentWorkspaceId = normalizeWorkspaceOpaqueId(agent?.workspaceId);
    if (!runWorkspaceId || runWorkspaceId === agentWorkspaceId) {
      return { kind: "layout-only" };
    }
  }

  return { kind: "archive-on-close" };
}
