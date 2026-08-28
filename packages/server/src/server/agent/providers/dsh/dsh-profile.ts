import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { dump, load } from "js-yaml";

import { type DshLocation, type DshLocationOptions, resolveDshLocation } from "./dsh-home.js";

const execFileAsync = promisify(execFile);

const SETTINGS_FILE = "settings.yaml";
const CORDIS_PATCH_FILE = "cordis.patch.yml";
const PACKAGE_FILE = "package.json";

const DEFAULT_SETTINGS = {
  "agent-default-model": {
    provider: "deepseek-official",
    model: "deepseek-v4-flash",
  },
  "llm-pi-ai": {
    providers: {},
  },
};

const DEFAULT_PACKAGE = {
  name: "paseo-dsh-provider",
  private: true,
  dependencies: {
    "@deepseek-ai/dsh-mcp-client": "0.0.1-rc.1",
    "@deepseek-ai/dsh-llm-pi-ai": "0.1.1-rc.2",
  },
};

export interface DshProfileState {
  profilePath: string;
  settingsPath: string;
  cordisPatchPath: string;
  settings: Record<string, unknown>;
  cordisPatch: unknown;
  nodeModulesPath: string;
  sessionRoot: string;
}

export function ensureDshProfile(options?: DshLocationOptions): DshProfileState {
  const location = resolveDshLocation(options);
  mkdirSync(location.profileHome, { recursive: true });
  mkdirSync(location.pluginDir, { recursive: true });

  const settingsPath = join(location.profileHome, SETTINGS_FILE);
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, dump(DEFAULT_SETTINGS), "utf8");
  }

  const cordisPatchPath = join(location.pluginDir, CORDIS_PATCH_FILE);
  if (!existsSync(cordisPatchPath)) {
    writeFileSync(cordisPatchPath, "# Paseo DSH Cordis patch layer\n[]\n", "utf8");
  }

  const packagePath = join(location.pluginDir, PACKAGE_FILE);
  if (!existsSync(packagePath)) {
    writeFileSync(packagePath, `${JSON.stringify(DEFAULT_PACKAGE, null, 2)}\n`, "utf8");
  }

  return readDshProfileState(options);
}

export function readDshProfileState(options?: DshLocationOptions): DshProfileState {
  const location = resolveDshLocation(options);
  const settingsPath = join(location.profileHome, SETTINGS_FILE);
  const cordisPatchPath = join(location.pluginDir, CORDIS_PATCH_FILE);
  const nodeModulesPath = join(location.pluginDir, "node_modules");

  let settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (existsSync(settingsPath)) {
    const parsed = load(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  }

  let cordisPatch: unknown = [];
  if (existsSync(cordisPatchPath)) {
    cordisPatch = load(readFileSync(cordisPatchPath, "utf8")) ?? [];
  }

  return {
    profilePath: location.profileHome,
    settingsPath,
    cordisPatchPath,
    settings,
    cordisPatch,
    nodeModulesPath,
    sessionRoot: location.sessionRoot,
  };
}

export function readLlmPiAiProviders(settings: Record<string, unknown>): Record<string, unknown> {
  const llmPiAi = settings["llm-pi-ai"];
  if (!llmPiAi || typeof llmPiAi !== "object" || Array.isArray(llmPiAi)) {
    return {};
  }
  const providers = (llmPiAi as Record<string, unknown>).providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return {};
  }
  return providers as Record<string, unknown>;
}

async function runPnpm(cwd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync("pnpm", args, {
      cwd,
      env: process.env,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "pnpm command failed — is pnpm installed?";
    throw new Error(message, { cause: error });
  }
}

export async function runPnpmInPluginDir(pluginDir: string, args: string[]): Promise<void> {
  await runPnpm(pluginDir, args);
}

export type { DshLocation };
