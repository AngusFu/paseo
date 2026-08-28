import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { type DshLocation, resolveDshLocation, type DshLocationOptions } from "./dsh-home.js";
import { ensureDshProfile, runPnpmInPluginDir } from "./dsh-profile.js";

const REQUIRED_PLUGIN_PACKAGES = [
  "@deepseek-ai/dsh-llm-pi-ai",
  "@deepseek-ai/dsh-credentials-local",
] as const;

export function resolveDesktopDshNodeModulesPath(): string | undefined {
  if (process.platform === "darwin") {
    const path = join(
      homedir(),
      "Library",
      "Application Support",
      "Paseo",
      "toolchains",
      "deepseek-harness",
      "node_modules",
    );
    if (existsSync(path)) {
      return path;
    }
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) {
      const path = join(appData, "Paseo", "toolchains", "deepseek-harness", "node_modules");
      if (existsSync(path)) {
        return path;
      }
    }
  }
  return undefined;
}

export function resolveDshNodeModulesSearchPaths(options?: DshLocationOptions): string[] {
  const location = resolveDshLocation(options);
  const paths: string[] = [];

  const profileModules = join(location.pluginDir, "node_modules");
  if (existsSync(profileModules)) {
    paths.push(profileModules);
  }

  const fromEnv = process.env.DSH_PLUGIN_NODE_MODULES?.trim();
  if (fromEnv && existsSync(fromEnv)) {
    paths.push(fromEnv);
  }

  const desktopModules = resolveDesktopDshNodeModulesPath();
  if (desktopModules) {
    paths.push(desktopModules);
  }

  return [...new Set(paths)];
}

export function areDshPluginsAvailable(paths: string[]): boolean {
  if (paths.length === 0) {
    return false;
  }
  return paths.some((root) =>
    REQUIRED_PLUGIN_PACKAGES.every((packageName) => existsSync(join(root, packageName))),
  );
}

export async function ensureDshProfilePlugins(options?: DshLocationOptions): Promise<DshLocation> {
  const location = resolveDshLocation(options);
  ensureDshProfile(options);

  const searchPaths = resolveDshNodeModulesSearchPaths(options);
  if (areDshPluginsAvailable(searchPaths)) {
    return location;
  }

  await runPnpmInPluginDir(location.pluginDir, ["install"]);
  return location;
}
