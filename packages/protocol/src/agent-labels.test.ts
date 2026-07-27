import { describe, expect, test } from "vitest";
import {
  getParentAgentIdFromLabels,
  getWorkflowRunIdFromLabels,
  isDelegatedAgent,
  isOrchestratedBackgroundAgent,
  isWorkflowAgent,
  PARENT_AGENT_ID_LABEL,
  WORKFLOW_AGENT_LABEL,
  WORKFLOW_RUN_ID_LABEL,
} from "./agent-labels.js";

describe("agent label policy", () => {
  test("treats a non-empty parent agent label as delegation", () => {
    const labels = { [PARENT_AGENT_ID_LABEL]: " parent-agent \n" };

    expect(getParentAgentIdFromLabels(labels)).toBe("parent-agent");
    expect(isDelegatedAgent({ labels })).toBe(true);
    expect(isOrchestratedBackgroundAgent({ labels })).toBe(true);
  });

  test("ignores missing, empty, and non-string parent agent labels", () => {
    expect(isDelegatedAgent({ labels: {} })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } })).toBe(false);
  });

  test("treats workflow run id and workflow-agent marker as workflow agents", () => {
    expect(isWorkflowAgent({ labels: { [WORKFLOW_RUN_ID_LABEL]: "run-1" } })).toBe(true);
    expect(getWorkflowRunIdFromLabels({ [WORKFLOW_RUN_ID_LABEL]: " run-1 " })).toBe("run-1");
    expect(isWorkflowAgent({ labels: { [WORKFLOW_AGENT_LABEL]: "1" } })).toBe(true);
    expect(isOrchestratedBackgroundAgent({ labels: { [WORKFLOW_AGENT_LABEL]: "1" } })).toBe(true);
    expect(isWorkflowAgent({ labels: {} })).toBe(false);
  });
});
