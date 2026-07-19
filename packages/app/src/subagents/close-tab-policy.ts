import { getWorkflowRunIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { Agent } from "@/stores/session-store";

export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

export function resolveCloseAgentTabPolicy(
  agent: Pick<Agent, "parentAgentId" | "labels"> | null | undefined,
): CloseAgentTabPolicy {
  if (agent?.parentAgentId) {
    return { kind: "layout-only" };
  }
  // Workflow-run agents live under their run's synthetic tab; closing an
  // explicitly opened agent tab must not archive the agent mid-run.
  if (getWorkflowRunIdFromLabels(agent?.labels)) {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close" };
}
