import { spawn as nodeSpawn } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { createElectronNodeEnv } from "../../daemon/node-entrypoint-launcher.js";
import { createExternalProcessEnv, resolveExecutable } from "../editor-targets/runtime.js";

export const DSH_PASEO_PACKAGE_NAME = "dsh-paseo";

export interface DshPaseoPluginDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  existsSync?: (filePath: string) => boolean;
  spawn?: typeof nodeSpawn;
  isPackaged?: boolean;
  resourcesPath?: string;
  /** Absolute path to packages/dsh-paseo (tests). */
  pluginRoot?: string;
  /** Override $DSH_HOME (tests). */
  dshHome?: string;
  homedir?: () => string;
  userDataPath?: string;
}

export function resolveDshHome(dependencies: DshPaseoPluginDependencies = {}): string {
  const env = dependencies.env ?? process.env;
  if (typeof env.DSH_HOME === "string" && env.DSH_HOME.trim()) {
    return path.resolve(env.DSH_HOME.trim());
  }
  const home = (dependencies.homedir ?? os.homedir)();
  return path.join(home, ".dsh");
}

export function resolveDshWebProfileDir(dependencies: DshPaseoPluginDependencies = {}): string {
  return path.join(resolveDshHome(dependencies), "profiles", "web");
}

/**
 * Dev: monorepo packages/dsh-paseo.
 * Packaged: process.resourcesPath/dsh-paseo (electron-builder extraResources).
 */
export function resolveDshPaseoPluginRoot(
  dependencies: DshPaseoPluginDependencies = {},
): string | null {
  if (dependencies.pluginRoot) {
    return dependencies.pluginRoot;
  }
  const existsSync = dependencies.existsSync ?? nodeExistsSync;
  const isPackaged = dependencies.isPackaged ?? app.isPackaged;
  if (isPackaged) {
    const resourcesPath = dependencies.resourcesPath ?? process.resourcesPath;
    const packaged = path.join(resourcesPath, "dsh-paseo");
    return existsSync(path.join(packaged, "package.json")) ? packaged : null;
  }
  // packages/desktop/src/features/deepseek-harness → ../../../../dsh-paseo
  // dist/features/deepseek-harness → ../../../../dsh-paseo (packages/dsh-paseo)
  const fromDesktop = path.resolve(__dirname, "../../../../dsh-paseo");
  if (existsSync(path.join(fromDesktop, "package.json"))) {
    return fromDesktop;
  }
  return null;
}

function resolveNpmCliPath(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  existsSync: (filePath: string) => boolean;
}): string {
  const npmExecutable = resolveExecutable(["npm"], {
    env: input.env,
    pathExists: input.existsSync,
    platform: input.platform,
  });
  if (!npmExecutable) {
    throw new Error("npm was not found on PATH (required to install dsh-paseo)");
  }
  const siblingCli = path.join(path.dirname(npmExecutable), "npm-cli.js");
  if (input.existsSync(siblingCli)) {
    return siblingCli;
  }
  return npmExecutable;
}

function runCommand(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawn: typeof nodeSpawn;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = input.spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `npm install ${DSH_PASEO_PACKAGE_NAME} failed: ${stderr.trim() || `exit ${code}`}`,
        ),
      );
    });
  });
}

/** Install the monorepo/packaged plugin into the user's web profile so DSH can resolve it. */
export async function ensureDshPaseoInstalledInWebProfile(
  dependencies: DshPaseoPluginDependencies = {},
): Promise<{ pluginRoot: string; profileDir: string }> {
  const pluginRoot = resolveDshPaseoPluginRoot(dependencies);
  if (!pluginRoot) {
    throw new Error("dsh-paseo plugin root was not found (dev package or packaged resource)");
  }
  const profileDir = resolveDshWebProfileDir(dependencies);
  const existsSync = dependencies.existsSync ?? nodeExistsSync;
  await mkdir(profileDir, { recursive: true });

  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const execPath = dependencies.execPath ?? process.execPath;
  const spawn = dependencies.spawn ?? nodeSpawn;
  const isPackaged = dependencies.isPackaged ?? app.isPackaged;
  const npmCli = resolveNpmCliPath({ env, platform, existsSync });
  const electronEnv = createElectronNodeEnv(createExternalProcessEnv(env), { isPackaged });

  await runCommand({
    command: execPath,
    args: [
      npmCli,
      "install",
      `file:${pluginRoot}`,
      "--prefix",
      profileDir,
      "--no-fund",
      "--no-audit",
    ],
    env: electronEnv,
    cwd: profileDir,
    spawn,
  });

  return { pluginRoot, profileDir };
}

/**
 * Host-only overlay patch. MCP is not auto-mounted by Desktop (avoids surprising
 * agent tool surfaces); install the package manually for MCP/CLI.
 */
export function buildDshPaseoOverlayPatchYaml(): string {
  return `# Generated by Paseo Desktop — do not edit
- insert:
    - id: paseo-host
      name: ${DSH_PASEO_PACKAGE_NAME}
`;
}

export async function writeDshPaseoOverlayPatch(
  dependencies: DshPaseoPluginDependencies = {},
): Promise<string> {
  const userDataPath = dependencies.userDataPath ?? app.getPath("userData");
  const dir = path.join(userDataPath, "toolchains", "deepseek-harness");
  await mkdir(dir, { recursive: true });
  const patchPath = path.join(dir, "dsh-paseo.overlay.yml");
  await writeFile(patchPath, buildDshPaseoOverlayPatchYaml(), "utf8");
  return patchPath;
}

export function buildDeepseekHarnessEmbedUrl(
  baseUrl: string,
  input: { workspaceId?: string | null; sessionId?: string | null },
): string {
  const url = new URL(String(baseUrl).replace(/\/$/, ""));
  url.searchParams.set("paseoEmbed", "1");
  const workspaceId = input.workspaceId?.trim();
  const sessionId = input.sessionId?.trim();
  if (sessionId) {
    url.searchParams.set("sessionId", sessionId);
  } else if (workspaceId) {
    url.searchParams.set("workspaceId", workspaceId);
  }
  return url.toString();
}
