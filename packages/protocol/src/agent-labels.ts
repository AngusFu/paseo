export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

// Stamped by the daemon's workflow service on every agent a workflow run
// spawns. Lets clients group a run's agents under one entry instead of a
// tab per agent.
export const WORKFLOW_RUN_ID_LABEL = "paseo.workflow-run-id";

export function getWorkflowRunIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const runId = labels?.[WORKFLOW_RUN_ID_LABEL];
  return typeof runId === "string" && runId.trim().length > 0 ? runId.trim() : null;
}

// The run's home workspace (run.workspaceId). Lets clients fold an agent
// into the run's synthetic tab only inside that workspace — worktree-isolated
// agents live in their own workspace and surface as normal tabs there.
export const WORKFLOW_RUN_WORKSPACE_LABEL = "paseo.workflow-run-workspace";

export function getWorkflowRunWorkspaceFromLabels(
  labels: Record<string, unknown> | null | undefined,
) {
  const workspaceId = labels?.[WORKFLOW_RUN_WORKSPACE_LABEL];
  return typeof workspaceId === "string" && workspaceId.trim().length > 0
    ? workspaceId.trim()
    : null;
}
