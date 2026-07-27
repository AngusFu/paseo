import type { AgentFeature } from "./agent-sdk-types.js";
import type { ManagedAgent } from "./agent-manager.js";

export function collectManagedAgentFeatureValues(
  agent: Pick<ManagedAgent, "config" | "features">,
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {
    ...agent.config.featureValues,
  };
  for (const feature of agent.features ?? []) {
    appendLiveAgentFeatureValue(merged, feature);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function appendLiveAgentFeatureValue(merged: Record<string, unknown>, feature: AgentFeature): void {
  if (feature.type === "toggle") {
    merged[feature.id] = feature.value;
    return;
  }
  if (feature.type === "select" && feature.value !== null) {
    merged[feature.id] = feature.value;
  }
}

export function mergeCreateAgentFeatureValues(
  inherited: Record<string, unknown> | undefined,
  requested: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!inherited && !requested) {
    return undefined;
  }
  return {
    ...inherited,
    ...requested,
  };
}
