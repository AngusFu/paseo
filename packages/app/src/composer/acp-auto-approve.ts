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

/** Distinguish Paseo-managed ACP auto_accept from OpenCode's homonymous toggle. */
export function isComposerAcpAutoAcceptFeature(
  feature: AgentFeature | null | undefined,
): feature is AgentFeature & { type: "toggle" } {
  if (!feature || feature.type !== "toggle" || feature.id !== ACP_AUTO_ACCEPT_FEATURE_ID) {
    return false;
  }
  const description = feature.description ?? "";
  if (description.includes("OpenCode")) {
    return false;
  }
  if (description.includes("ACP")) {
    return true;
  }
  return false;
}

export function shouldShowComposerAcpAutoAccept(input: {
  provider: AgentProvider | null | undefined;
  config: Pick<MutableDaemonConfig, "providers"> | null | undefined;
  feature: AgentFeature | null | undefined;
}): boolean {
  if (input.provider === "opencode") {
    return false;
  }
  if (isComposerAcpAutoAcceptFeature(input.feature)) {
    return true;
  }
  return isAcpProvider(input.provider, input.config);
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
