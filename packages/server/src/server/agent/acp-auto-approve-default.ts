import { isWorkflowAgent } from "@getpaseo/protocol/agent-labels";
import type { AgentProvider } from "./agent-sdk-types.js";
import { mergeCreateAgentFeatureValues } from "./create-agent-features.js";
import { ACP_AUTO_ACCEPT_FEATURE_ID } from "./providers/acp-agent.js";

export interface DaemonProviderOverrideLike {
  extends?: string;
}

/** Whether the global desktop Auto Approve toggle applies to this provider. */
export function isDaemonManagedAcpAutoAcceptProvider(
  provider: AgentProvider | string,
  providerOverrides: Readonly<Record<string, DaemonProviderOverrideLike>> | undefined,
): boolean {
  if (provider === "opencode") {
    return false;
  }
  if (provider === "copilot") {
    return true;
  }
  return providerOverrides?.[provider]?.extends === "acp";
}

/** Stamp auto_accept from daemon config when create did not set it explicitly. */
export function applyDaemonAcpAutoAcceptDefault(
  provider: AgentProvider | string,
  featureValues: Record<string, unknown> | undefined,
  acpAutoApprove: boolean | undefined,
  providerOverrides: Readonly<Record<string, DaemonProviderOverrideLike>> | undefined,
): Record<string, unknown> | undefined {
  if (acpAutoApprove !== true) {
    return featureValues;
  }
  if (!isDaemonManagedAcpAutoAcceptProvider(provider, providerOverrides)) {
    return featureValues;
  }
  if (featureValues?.[ACP_AUTO_ACCEPT_FEATURE_ID] !== undefined) {
    return featureValues;
  }
  return mergeCreateAgentFeatureValues(featureValues, {
    [ACP_AUTO_ACCEPT_FEATURE_ID]: true,
  });
}

/** Force auto_accept for workflow agents only — unattended runs, not parent-delegated subagents. */
export function applyOrchestratedAcpAutoAccept(
  _provider: AgentProvider | string,
  featureValues: Record<string, unknown> | undefined,
  labels: Record<string, string> | undefined,
  _providerOverrides: Readonly<Record<string, DaemonProviderOverrideLike>> | undefined,
): Record<string, unknown> | undefined {
  if (!labels || !isWorkflowAgent({ labels })) {
    return featureValues;
  }
  return mergeCreateAgentFeatureValues(featureValues, {
    [ACP_AUTO_ACCEPT_FEATURE_ID]: true,
  });
}
