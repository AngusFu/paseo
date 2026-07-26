import type { AgentFeature, AgentProvider } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

export const ACP_AUTO_ACCEPT_FEATURE_ID = "auto_accept";

/** Feature ids rendered by the composer floating toggle for ACP providers. */
export const COMPOSER_MANAGED_ACP_FEATURE_IDS = [ACP_AUTO_ACCEPT_FEATURE_ID] as const;

const BUILTIN_ACP_PROVIDER_IDS = new Set<AgentProvider>(["copilot"]);

export function isAcpProvider(
  provider: AgentProvider | null | undefined,
  config: Pick<MutableDaemonConfig, "providers"> | null | undefined,
): boolean {
  if (!provider) {
    return false;
  }
  if (BUILTIN_ACP_PROVIDER_IDS.has(provider)) {
    return true;
  }
  return config?.providers?.[provider]?.extends === "acp";
}

export function excludeComposerManagedAcpFeatures(
  features: AgentFeature[] | undefined,
): AgentFeature[] | undefined {
  if (!features) {
    return features;
  }
  const hidden = new Set<string>(COMPOSER_MANAGED_ACP_FEATURE_IDS);
  const filtered = features.filter((feature) => !hidden.has(feature.id));
  return filtered.length === features.length ? features : filtered;
}
