import type { Command } from "commander";
import type { AgentModelDefinition, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, OutputOptions, SingleResult } from "../../output/index.js";
import type { OutputSchema } from "../../output/index.js";

export interface InspectModelEntry {
  id: string;
  label: string;
  description: string;
  defaultThinkingOptionId: string | null;
  thinkingOptionIds: string[];
}

export interface InspectProviderEntry {
  id: string;
  label: string;
  status: string;
  enabled: boolean;
  error: string | null;
  defaultModeId: string | null;
  modeIds: string[];
  modes: Array<{ id: string; label: string }>;
  models: InspectModelEntry[];
}

export interface ProviderInspectReport {
  cwd: string;
  /** When false, disabled providers were omitted from `providers`. */
  includeDisabled: boolean;
  fetchedAt: string;
  providers: InspectProviderEntry[];
}

function mapModel(model: AgentModelDefinition): InspectModelEntry {
  return {
    id: model.id,
    label: model.label,
    description: model.description ?? "",
    defaultThinkingOptionId: model.defaultThinkingOptionId ?? null,
    thinkingOptionIds: (model.thinkingOptions ?? []).map((option) => option.id),
  };
}

function mapProviderEntry(
  entry: ProviderSnapshotEntry,
  models: InspectModelEntry[],
): InspectProviderEntry {
  const modes = (entry.modes ?? []).map((mode) => ({
    id: mode.id,
    label: mode.label,
  }));
  return {
    id: entry.provider,
    label: entry.label ?? entry.provider,
    status: entry.status === "ready" ? "available" : entry.status,
    enabled: entry.enabled !== false,
    error: entry.error ?? null,
    defaultModeId: entry.defaultModeId ?? null,
    modeIds: modes.map((mode) => mode.id),
    modes,
    models,
  };
}

export function renderProviderInspectHuman(report: ProviderInspectReport): string {
  const lines: string[] = [
    `cwd: ${report.cwd}`,
    `disabled: ${report.includeDisabled ? "included (--all)" : "omitted (pass --all)"}`,
    `providers: ${report.providers.length}`,
    "",
  ];

  for (const provider of report.providers) {
    const modePart = provider.modeIds.length > 0 ? provider.modeIds.join(", ") : "-";
    lines.push(
      `${provider.id}  [${provider.status}]  enabled=${provider.enabled}  modes=${modePart}`,
    );
    if (provider.error) {
      lines.push(`  error: ${provider.error}`);
    }
    if (provider.models.length === 0) {
      lines.push("  models: (none)");
      lines.push("");
      continue;
    }
    for (const model of provider.models) {
      const thinking =
        model.thinkingOptionIds.length > 0 ? model.thinkingOptionIds.join(", ") : "none";
      const defaultThinking = model.defaultThinkingOptionId ?? "auto";
      lines.push(`  model ${model.id}  thinking=[${thinking}]  defaultThinking=${defaultThinking}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export async function buildProviderInspectReport(input: {
  entries: ProviderSnapshotEntry[];
  cwd: string;
  /** When true, include disabled providers. Default: enabled only. */
  includeDisabled?: boolean;
  providerFilter?: string | null;
}): Promise<ProviderInspectReport> {
  const includeDisabled = input.includeDisabled === true;
  const filter = input.providerFilter?.trim().toLowerCase() || null;
  let entries = filter
    ? input.entries.filter((entry) => entry.provider.toLowerCase() === filter)
    : input.entries;

  if (filter && entries.length === 0) {
    throw {
      code: "PROVIDER_NOT_FOUND",
      message: `Provider '${input.providerFilter}' not found in daemon snapshot`,
    };
  }

  if (filter && !includeDisabled && entries.some((entry) => entry.enabled === false)) {
    throw {
      code: "PROVIDER_DISABLED",
      message: `Provider '${input.providerFilter}' is disabled (pass --all to include)`,
    };
  }

  if (!includeDisabled) {
    entries = entries.filter((entry) => entry.enabled !== false);
  }

  const providers: InspectProviderEntry[] = entries.map((entry) =>
    mapProviderEntry(
      entry,
      (entry.models ?? []).map((model) => mapModel(model)),
    ),
  );

  return {
    cwd: input.cwd,
    includeDisabled,
    fetchedAt: new Date().toISOString(),
    providers,
  };
}

const providerInspectSchema: OutputSchema<ProviderInspectReport> = {
  idField: (report) => String(report.providers.length),
  columns: [],
  renderHuman: (result, _options: OutputOptions) =>
    renderProviderInspectHuman((result as SingleResult<ProviderInspectReport>).data),
  serialize: (report) => report,
};

export type ProviderInspectResult = SingleResult<ProviderInspectReport>;

export interface ProviderInspectOptions extends CommandOptions {
  host?: string;
  cwd?: string;
  provider?: string;
  all?: boolean;
}

export async function runInspectCommand(
  options: ProviderInspectOptions,
  _command: Command,
): Promise<ProviderInspectResult> {
  const cwd = options.cwd?.trim() || process.cwd();
  const includeDisabled = options.all === true;
  const client = await connectToDaemon({ host: options.host });

  try {
    const snapshot = await client.getProvidersSnapshot({ cwd });
    const report = await buildProviderInspectReport({
      entries: snapshot.entries ?? [],
      cwd,
      includeDisabled,
      providerFilter: options.provider,
    });

    return {
      type: "single",
      data: report,
      schema: providerInspectSchema,
    };
  } finally {
    await client.close();
  }
}
