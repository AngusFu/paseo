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
