import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import type { ProviderProfileModel } from "@getpaseo/protocol/provider-config";
import { readLlmPiAiProviders } from "./dsh-profile.js";

export const DSH_PROVIDER_ID = "dsh";
export const DSH_LLM_PROVIDER = "deepseek-official";
export const DSH_DEFAULT_MODEL_ID = "deepseek-v4-flash";

export const DSH_MODELS: AgentModelDefinition[] = [
  {
    provider: DSH_PROVIDER_ID,
    id: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    description: "Fast DeepSeek V4 model (default)",
    isDefault: true,
  },
  {
    provider: DSH_PROVIDER_ID,
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "Higher-capability DeepSeek V4 model",
  },
];

export interface DshModelRoute {
  provider: string;
  model: string;
  catalogId: string;
}

export function resolveDshModelId(modelId: string | null | undefined): string {
  if (!modelId) {
    return DSH_DEFAULT_MODEL_ID;
  }
  return modelId;
}

export function resolveDshModelRoute(modelId: string | null | undefined): DshModelRoute {
  const resolved = resolveDshModelId(modelId);
  const slashIndex = resolved.indexOf("/");
  if (slashIndex <= 0) {
    return {
      provider: DSH_LLM_PROVIDER,
      model: resolved,
      catalogId: resolved,
    };
  }
  const provider = resolved.slice(0, slashIndex);
  const model = resolved.slice(slashIndex + 1);
  return {
    provider,
    model,
    catalogId: resolved,
  };
}

export function buildDshCatalogModels(input: {
  settings?: Record<string, unknown>;
  additionalModels?: ProviderProfileModel[];
}): AgentModelDefinition[] {
  const models = new Map<string, AgentModelDefinition>();

  for (const model of DSH_MODELS) {
    models.set(model.id, model);
  }

  const llmProviders = readLlmPiAiProviders(input.settings ?? {});
  for (const [providerRoute, providerConfig] of Object.entries(llmProviders)) {
    if (!providerConfig || typeof providerConfig !== "object" || Array.isArray(providerConfig)) {
      continue;
    }
    const displayName =
      typeof (providerConfig as { displayName?: unknown }).displayName === "string"
        ? (providerConfig as { displayName: string }).displayName
        : providerRoute;
    const configuredModels = (providerConfig as { models?: unknown }).models;
    if (!Array.isArray(configuredModels)) {
      continue;
    }
    for (const entry of configuredModels) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const id =
        typeof (entry as { id?: unknown }).id === "string" ? (entry as { id: string }).id : null;
      if (!id) {
        continue;
      }
      const catalogId = `${providerRoute}/${id}`;
      models.set(catalogId, {
        provider: DSH_PROVIDER_ID,
        id: catalogId,
        label: `${displayName}: ${id}`,
        description: `DSH route ${providerRoute}`,
      });
    }
  }

  for (const model of input.additionalModels ?? []) {
    models.set(model.id, {
      provider: DSH_PROVIDER_ID,
      id: model.id,
      label: model.label,
      ...(model.description ? { description: model.description } : {}),
      ...(model.isDefault ? { isDefault: true } : {}),
    });
  }

  return [...models.values()];
}
