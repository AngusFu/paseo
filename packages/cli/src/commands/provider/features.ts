import type { Command } from "commander";
import type { AgentFeature, AgentProvider } from "@getpaseo/protocol/agent-types";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";

export interface FeatureListItem {
  id: string;
  type: string;
  label: string;
  value: string;
  options: string;
  description: string;
}

function formatFeatureValue(feature: AgentFeature): string {
  if (feature.type === "toggle") {
    return feature.value ? "true" : "false";
  }
  if (feature.value == null || feature.value === "") {
    return "(empty)";
  }
  return feature.value;
}

function formatFeatureOptions(feature: AgentFeature): string {
  if (feature.type !== "select") {
    return "-";
  }
  if (feature.options.length === 0) {
    return "none";
  }
  return feature.options
    .map((option) => {
      const id = option.id === "" ? '""' : option.id;
      return option.label && option.label !== option.id ? `${id} (${option.label})` : id;
    })
    .join(", ");
}

export function toFeatureListItems(features: AgentFeature[]): FeatureListItem[] {
  return features.map((feature) => ({
    id: feature.id,
    type: feature.type,
    label: feature.label,
    value: formatFeatureValue(feature),
    options: formatFeatureOptions(feature),
    description: feature.description ?? feature.tooltip ?? "",
  }));
}

export const providerFeaturesSchema: OutputSchema<FeatureListItem> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 18 },
    { header: "TYPE", field: "type", width: 8 },
    { header: "LABEL", field: "label", width: 16 },
    { header: "VALUE", field: "value", width: 12 },
    { header: "OPTIONS", field: "options", width: 40 },
  ],
};

export type ProviderFeaturesResult = ListResult<FeatureListItem>;

export interface ProviderFeaturesOptions extends CommandOptions {
  host?: string;
  cwd?: string;
  model?: string;
  mode?: string;
  thinking?: string;
}

export async function runFeaturesCommand(
  provider: string,
  options: ProviderFeaturesOptions,
  _command: Command,
): Promise<ProviderFeaturesResult> {
  const normalizedProvider = provider.trim().toLowerCase() as AgentProvider;
  if (!normalizedProvider) {
    throw {
      code: "INVALID_PROVIDER",
      message: "Provider is required",
      details:
        "Usage: paseo provider features <provider> --cwd <path> [--model <id>] [--mode <id>] [--thinking <id>]",
    };
  }

  const cwd = options.cwd?.trim() || process.cwd();
  const model = options.model?.trim();
  const modeId = options.mode?.trim();
  const thinkingOptionId = options.thinking?.trim();

  const client = await connectToDaemon({ host: options.host });
  try {
    const result = await client.listProviderFeatures({
      provider: normalizedProvider,
      cwd,
      ...(model ? { model } : {}),
      ...(modeId ? { modeId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    });

    if (result.error) {
      throw {
        code: "PROVIDER_ERROR",
        message: `Failed to fetch features for ${provider}: ${result.error}`,
      };
    }

    return {
      type: "list",
      data: toFeatureListItems(result.features ?? []),
      schema: providerFeaturesSchema,
    };
  } finally {
    await client.close();
  }
}
