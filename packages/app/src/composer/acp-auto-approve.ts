import type { AgentFeature, AgentProvider } from "@getpaseo/protocol/agent-types";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import type { FormPreferences } from "@/create-agent-preferences/preferences";
import { ACP_CATALOG_PROVIDER_IDS } from "@/data/acp-provider-catalog";

export const ACP_AUTO_ACCEPT_FEATURE_ID = "auto_accept";

/** Feature ids rendered by the composer floating toggle for ACP providers. */
export const COMPOSER_MANAGED_ACP_FEATURE_IDS = [ACP_AUTO_ACCEPT_FEATURE_ID] as const;

/** Daemon-manifest ACP built-in not installed through the ACP catalog (`extends: "acp"`). */
const MANIFEST_NATIVE_ACP_PROVIDER_IDS = new Set<AgentProvider>(["copilot"]);

export function isAcpProvider(
  provider: AgentProvider | null | undefined,
  config: Pick<MutableDaemonConfig, "providers"> | null | undefined,
): boolean {
  if (!provider || provider === "opencode") {
    return false;
  }
  if (MANIFEST_NATIVE_ACP_PROVIDER_IDS.has(provider)) {
    return true;
  }
  if (ACP_CATALOG_PROVIDER_IDS.has(provider)) {
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

/** Read the global ACP auto-approve preference, migrating legacy per-provider values. */
export function readGlobalAcpAutoApprove(
  preferences: Pick<FormPreferences, "acpAutoApprove" | "providerPreferences">,
): boolean | undefined {
  if (typeof preferences.acpAutoApprove === "boolean") {
    return preferences.acpAutoApprove;
  }

  let sawTrue = false;
  for (const providerPrefs of Object.values(preferences.providerPreferences ?? {})) {
    if (providerPrefs.featureValues?.[ACP_AUTO_ACCEPT_FEATURE_ID] === true) {
      sawTrue = true;
      break;
    }
  }
  if (sawTrue) {
    return true;
  }
  // Ambiguous legacy state: per-provider false does not imply a global off.
  return undefined;
}

export function resolveGlobalAcpAutoAcceptFeatureValues(
  preferences: Pick<FormPreferences, "acpAutoApprove" | "providerPreferences">,
  provider: AgentProvider | null | undefined,
  config: Pick<MutableDaemonConfig, "providers"> | null | undefined,
): Record<string, unknown> {
  if (!isAcpProvider(provider, config)) {
    return {};
  }
  const value = readGlobalAcpAutoApprove(preferences);
  return value === undefined ? {} : { [ACP_AUTO_ACCEPT_FEATURE_ID]: value };
}

function findComposerAutoAcceptFeature(
  features: AgentFeature[] | undefined,
): (AgentFeature & { type: "toggle" }) | null {
  if (!features) {
    return null;
  }
  const acpMatch = features.find((feature) => isComposerAcpAutoAcceptFeature(feature));
  if (acpMatch) {
    return acpMatch;
  }
  const generic = features.find(
    (feature) => feature.id === ACP_AUTO_ACCEPT_FEATURE_ID && feature.type === "toggle",
  );
  if (!generic || generic.type !== "toggle") {
    return null;
  }
  if ((generic.description ?? "").includes("OpenCode")) {
    return null;
  }
  return generic;
}

export function resolveComposerAutoAcceptFeature(
  draftFeatures: AgentFeature[] | undefined,
  liveFeatures: AgentFeature[] | undefined,
): (AgentFeature & { type: "toggle" }) | null {
  const fromDraft = findComposerAutoAcceptFeature(draftFeatures);
  if (fromDraft) {
    return fromDraft;
  }
  return findComposerAutoAcceptFeature(liveFeatures);
}

export function resolveComposerAutoAcceptSettledValue(input: {
  optimisticValue: boolean | null;
  draftMode: boolean;
  globalAutoApprove: boolean | undefined;
  resolvedFeatureValue: boolean;
}): boolean {
  if (input.optimisticValue !== null) {
    return input.optimisticValue;
  }
  if (input.draftMode) {
    return input.resolvedFeatureValue;
  }
  return input.globalAutoApprove ?? input.resolvedFeatureValue;
}

// COMPAT(globalAcpAutoApprove): added in v0.1.105, drop when client floor >= v0.1.105 + 6mo
export function migrateGlobalAcpAutoApprovePreferences(preferences: FormPreferences): {
  preferences: FormPreferences;
  changed: boolean;
} {
  let acpAutoApprove = preferences.acpAutoApprove;
  if (typeof acpAutoApprove !== "boolean") {
    const migrated = readGlobalAcpAutoApprove(preferences);
    if (typeof migrated === "boolean") {
      acpAutoApprove = migrated;
    }
  }

  const providerPreferences = preferences.providerPreferences;
  if (!providerPreferences) {
    if (typeof acpAutoApprove === "boolean" && preferences.acpAutoApprove !== acpAutoApprove) {
      return {
        preferences: { ...preferences, acpAutoApprove },
        changed: true,
      };
    }
    return { preferences, changed: false };
  }

  let strippedLegacy = false;
  const nextProviderPreferences = { ...providerPreferences };
  for (const [provider, providerPrefs] of Object.entries(nextProviderPreferences)) {
    const featureValues = providerPrefs.featureValues;
    if (featureValues?.[ACP_AUTO_ACCEPT_FEATURE_ID] === undefined) {
      continue;
    }
    strippedLegacy = true;
    const { [ACP_AUTO_ACCEPT_FEATURE_ID]: _removed, ...restFeatureValues } = featureValues;
    const nextProviderPrefs = { ...providerPrefs };
    if (Object.keys(restFeatureValues).length > 0) {
      nextProviderPrefs.featureValues = restFeatureValues;
    } else {
      delete nextProviderPrefs.featureValues;
    }
    nextProviderPreferences[provider] = nextProviderPrefs;
  }

  const needsGlobalField =
    typeof acpAutoApprove === "boolean" && preferences.acpAutoApprove !== acpAutoApprove;
  if (!strippedLegacy && !needsGlobalField) {
    return { preferences, changed: false };
  }

  return {
    preferences: {
      ...preferences,
      ...(typeof acpAutoApprove === "boolean" ? { acpAutoApprove } : {}),
      ...(strippedLegacy ? { providerPreferences: nextProviderPreferences } : {}),
    },
    changed: true,
  };
}

export function mergeGlobalAcpAutoApprove(
  preferences: FormPreferences,
  acpAutoApprove: boolean,
): FormPreferences {
  return migrateGlobalAcpAutoApprovePreferences({
    ...preferences,
    acpAutoApprove,
  }).preferences;
}
