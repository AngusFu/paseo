import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

export interface DshModelRoute {
  provider: string;
  model: string;
  catalogId: string;
}

export interface DshModelDefinition {
  modelId: string;
  name: string;
  description?: string;
  reasoningEfforts?: string[];
}

export interface DshModelCatalog {
  models: DshModelDefinition[];
  defaultModelId: string;
  defaultReasoningEffort?: string;
  pluginEntries: DshLlmPlugin[];
  llmPiAiProviders: Record<string, unknown>;
}

export interface DshLlmPlugin {
  id: string;
  entryPath: string;
  packageName: string;
  providerId: string;
  settingsSection?: string;
}

const OFFICIAL_MODELS: DshModelDefinition[] = [
  {
    modelId: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    description: "Fast DeepSeek V4 model",
    reasoningEfforts: ["off", "low", "high", "max"],
  },
  {
    modelId: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    description: "Higher-capability DeepSeek V4 model",
    reasoningEfforts: ["off", "low", "high", "max"],
  },
];

export function readDshModelCatalog(dshHome: string): DshModelCatalog {
  const settings = readSettings(dshHome);
  const plugins = discoverDshLlmPlugins(dshHome);
  const llmPiAiProviders = readLlmPiAiProviders(settings);
  const models = new Map<string, DshModelDefinition>();
  for (const model of OFFICIAL_MODELS) {
    models.set(model.modelId, model);
  }

  for (const model of extractPluginModels(settings, plugins)) {
    models.set(model.modelId, model);
  }
  for (const model of extractPiAiModels(llmPiAiProviders)) {
    models.set(model.modelId, model);
  }

  const defaults = asRecord(settings["agent-default-model"]);
  const defaultProvider = stringValue(defaults?.provider) ?? "deepseek-official";
  const defaultModel = stringValue(defaults?.model) ?? "deepseek-v4-flash";
  const defaultModelId =
    defaultProvider === "deepseek-official" ? defaultModel : `${defaultProvider}/${defaultModel}`;
  return {
    models: [...models.values()],
    defaultModelId: models.has(defaultModelId) ? defaultModelId : "deepseek-v4-flash",
    ...(stringValue(defaults?.reasoningEffort)
      ? { defaultReasoningEffort: stringValue(defaults?.reasoningEffort) }
      : {}),
    pluginEntries: plugins,
    llmPiAiProviders,
  };
}

export function resolveDshModelRoute(modelId: string): DshModelRoute {
  const slashIndex = modelId.indexOf("/");
  if (slashIndex <= 0) {
    return { provider: "deepseek-official", model: modelId, catalogId: modelId };
  }
  return {
    provider: modelId.slice(0, slashIndex),
    model: modelId.slice(slashIndex + 1),
    catalogId: modelId,
  };
}

function extractPiAiModels(providers: Record<string, unknown>): DshModelDefinition[] {
  const models: DshModelDefinition[] = [];
  for (const [providerRoute, rawConfig] of Object.entries(providers)) {
    const config = asRecord(rawConfig);
    if (!config || !Array.isArray(config.models)) {
      continue;
    }
    const displayName = stringValue(config.displayName) ?? providerRoute;
    for (const rawModel of config.models) {
      const model = asRecord(rawModel);
      const id = stringValue(model?.id);
      if (!id) {
        continue;
      }
      const modelId = `${providerRoute}/${id}`;
      const efforts = extractReasoningEfforts(model?.reasoningEfforts);
      models.push({
        modelId,
        name: `${displayName}: ${stringValue(model?.name) ?? id}`,
        description: `DSH route ${providerRoute}`,
        ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
      });
    }
  }
  return models;
}

function extractPluginModels(
  settings: Record<string, unknown>,
  plugins: DshLlmPlugin[],
): DshModelDefinition[] {
  const models: DshModelDefinition[] = [];
  for (const plugin of plugins) {
    const section = asRecord(
      (plugin.settingsSection ? settings[plugin.settingsSection] : undefined) ??
        settings[plugin.id],
    );
    if (!section || !Array.isArray(section.models)) {
      continue;
    }
    for (const rawModel of section.models) {
      const model = asRecord(rawModel);
      const id = stringValue(model?.id);
      if (!id) {
        continue;
      }
      const modelId = `${plugin.providerId}/${id}`;
      models.push({
        modelId,
        name: `${plugin.providerId}: ${stringValue(model?.name) ?? id}`,
        description: `DSH ${plugin.packageName}`,
      });
    }
  }
  return models;
}

function discoverDshLlmPlugins(dshHome: string): DshLlmPlugin[] {
  const roots = [
    join(dshHome, "profiles", "web", "node_modules"),
    join(dshHome, "paseo", "node_modules"),
  ];
  const discovered = new Map<string, DshLlmPlugin>();
  for (const root of roots) {
    for (const packageDir of nodeModulePackageDirs(root)) {
      const plugin = inspectLlmPlugin(packageDir);
      if (plugin && !discovered.has(plugin.id)) {
        discovered.set(plugin.id, plugin);
      }
    }
  }
  return [...discovered.values()];
}

function inspectLlmPlugin(packageDir: string): DshLlmPlugin | undefined {
  try {
    const manifest = asRecord(JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")));
    if (!manifest) {
      return undefined;
    }
    const packageName = stringValue(manifest?.name);
    if (!packageName || packageName.startsWith("@deepseek-ai/")) {
      return undefined;
    }
    const patchId = readPatchId(packageDir, manifest);
    if (!isLlmPackage(manifest, packageName, patchId)) {
      return undefined;
    }
    const entryPath = resolvePackageEntry(packageDir, stringValue(manifest.main));
    if (!entryPath) {
      return undefined;
    }
    const id = patchId ?? packageName.split("/").at(-1) ?? packageName;
    const providerId = id.startsWith("llm-") ? id.slice(4) : id;
    return { packageName, id, providerId, entryPath, settingsSection: id };
  } catch {
    return undefined;
  }
}

function nodeModulePackageDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith("@")) {
      for (const child of safeReadDir(join(root, entry.name))) {
        if (child.isDirectory()) {
          dirs.push(join(root, entry.name, child.name));
        }
      }
    } else {
      dirs.push(join(root, entry.name));
    }
  }
  return dirs;
}

function readPatchId(packageDir: string, manifest: Record<string, unknown>): string | undefined {
  const dsh = asRecord(manifest.dsh);
  const bundle = asRecord(dsh?.bundle);
  const patchPath = join(packageDir, stringValue(bundle?.patch) ?? "cordis.patch.yml");
  if (!existsSync(patchPath)) {
    return undefined;
  }
  const patch = load(readFileSync(patchPath, "utf8"));
  if (!Array.isArray(patch)) {
    return undefined;
  }
  for (const item of patch) {
    const record = asRecord(item);
    const directId = stringValue(record?.id);
    if (directId) {
      return directId;
    }
    if (Array.isArray(record?.insert)) {
      for (const inserted of record.insert) {
        const id = stringValue(asRecord(inserted)?.id);
        if (id) {
          return id;
        }
      }
    }
  }
  return undefined;
}

function isLlmPackage(
  manifest: Record<string, unknown>,
  packageName: string,
  patchId: string | undefined,
): boolean {
  if (
    packageName.includes("sidebar") ||
    packageName.includes("theme") ||
    packageName.includes("client")
  ) {
    return false;
  }
  const dependencies = asRecord(manifest.dependencies);
  const peerDependencies = asRecord(manifest.peerDependencies);
  return (
    packageName.includes("dsh-llm-") ||
    packageName.includes("llm-") ||
    patchId?.startsWith("llm-") === true ||
    dependencies?.["@deepseek-ai/dsh-llm"] !== undefined ||
    peerDependencies?.["@deepseek-ai/dsh-llm"] !== undefined
  );
}

function resolvePackageEntry(packageDir: string, main: string | undefined): string | undefined {
  for (const relative of [main, "lib/index.js", "index.js", "dist/index.js", "lib/index.mjs"]) {
    if (!relative) {
      continue;
    }
    const path = join(packageDir, relative);
    if (existsSync(path)) {
      return path;
    }
  }
  return undefined;
}

function readSettings(dshHome: string): Record<string, unknown> {
  const path = join(dshHome, "settings.yaml");
  if (!existsSync(path)) {
    return {};
  }
  const parsed = load(readFileSync(path, "utf8"));
  return asRecord(parsed) ?? {};
}

function readLlmPiAiProviders(settings: Record<string, unknown>): Record<string, unknown> {
  return asRecord(asRecord(settings["llm-pi-ai"])?.providers) ?? {};
}

function extractReasoningEfforts(value: unknown): string[] {
  const efforts = asRecord(value);
  return efforts ? Object.keys(efforts) : [];
}

function safeReadDir(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
