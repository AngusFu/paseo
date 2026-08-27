import { spawn as nodeSpawn } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { createElectronNodeEnv } from "../../daemon/node-entrypoint-launcher.js";
import { createExternalProcessEnv } from "../editor-targets/runtime.js";

export const DSH_PASEO_PACKAGE_NAME = "dsh-paseo";

/** Same Node exec argv Desktop uses when spawning `dsh` under Electron. */
const DSH_NODE_EXEC_ARGV = ["--expose-internals"] as const;

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
  /** Absolute path to @deepseek-ai/dsh lib/bin.js (required for install). */
  entryPath?: string;
  /** Override $DSH_HOME (tests). */
  dshHome?: string;
  homedir?: () => string;
  userDataPath?: string;
  /** Override install target under $DSH_HOME/packages (tests). */
  installTarget?: string;
  cp?: typeof cp;
  rm?: typeof rm;
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

/** Writable install target — never link the web profile at the app bundle. */
export function resolveDshPaseoInstallTarget(
  dependencies: DshPaseoPluginDependencies = {},
): string {
  if (dependencies.installTarget) {
    return dependencies.installTarget;
  }
  return path.join(resolveDshHome(dependencies), "packages", DSH_PASEO_PACKAGE_NAME);
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

function runCommand(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawn: typeof nodeSpawn;
  label: string;
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
      reject(new Error(`${input.label} failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

/**
 * Sync packaged/monorepo sources into $DSH_HOME/packages/dsh-paseo.
 *
 * Cordis loads the package from this realpath. Linking the profile at the
 * app-bundle extraResources path fails because that tree has no node_modules
 * and Node will not walk into the web profile to resolve imports.
 */
export async function syncDshPaseoInstallTree(
  dependencies: DshPaseoPluginDependencies = {},
): Promise<{ sourceRoot: string; installTarget: string }> {
  const sourceRoot = resolveDshPaseoPluginRoot(dependencies);
  if (!sourceRoot) {
    throw new Error("dsh-paseo plugin root was not found (dev package or packaged resource)");
  }
  const installTarget = resolveDshPaseoInstallTarget(dependencies);
  const copy = dependencies.cp ?? cp;
  const remove = dependencies.rm ?? rm;
  await mkdir(path.dirname(installTarget), { recursive: true });
  await remove(installTarget, { recursive: true, force: true });
  await copy(sourceRoot, installTarget, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== "node_modules" && !base.endsWith(".test.js") && !base.startsWith("smoke");
    },
  });
  return { sourceRoot, installTarget };
}

/**
 * Install the built-in plugin into the user's web profile via
 * `dsh plugin --profile web add <dir>` (pnpm under the hood).
 *
 * Sources are first synced to $DSH_HOME/packages/dsh-paseo so the profile
 * never links into the read-only app bundle.
 *
 * Do not use `npm install --prefix` on the web profile — it corrupts the
 * pnpm-managed tree and breaks index.html serving.
 */
export async function ensureDshPaseoInstalledInWebProfile(
  dependencies: DshPaseoPluginDependencies = {},
): Promise<{ pluginRoot: string; profileDir: string; installTarget: string }> {
  const { installTarget } = await syncDshPaseoInstallTree(dependencies);
  const entryPath = dependencies.entryPath?.trim();
  if (!entryPath) {
    throw new Error("dsh entryPath is required to install dsh-paseo into the web profile");
  }
  const profileDir = resolveDshWebProfileDir(dependencies);
  const existsSync = dependencies.existsSync ?? nodeExistsSync;
  await mkdir(profileDir, { recursive: true });
  if (!existsSync(entryPath)) {
    throw new Error(`DeepSeek Harness entry was not found: ${entryPath}`);
  }

  const env = dependencies.env ?? process.env;
  const execPath = dependencies.execPath ?? process.execPath;
  const spawn = dependencies.spawn ?? nodeSpawn;
  const isPackaged = dependencies.isPackaged ?? app.isPackaged;
  const electronEnv = createElectronNodeEnv(createExternalProcessEnv(env), { isPackaged });

  await runCommand({
    command: execPath,
    args: [...DSH_NODE_EXEC_ARGV, entryPath, "plugin", "--profile", "web", "add", installTarget],
    env: electronEnv,
    cwd: profileDir,
    spawn,
    label: `dsh plugin add ${DSH_PASEO_PACKAGE_NAME}`,
  });

  return { pluginRoot: installTarget, profileDir, installTarget };
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
  input: {
    workspaceId?: string | null;
    sessionId?: string | null;
    permission?: string | null;
    agentPreset?: string | null;
    sidebar?: "collapsed" | "hidden" | "open" | null;
  },
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
  const permission = input.permission?.trim();
  if (permission) {
    url.searchParams.set("permission", permission);
  }
  const agentPreset = input.agentPreset?.trim();
  if (agentPreset) {
    url.searchParams.set("agentPreset", agentPreset);
  }
  const sidebar = input.sidebar?.trim();
  if (sidebar === "collapsed" || sidebar === "hidden" || sidebar === "open") {
    url.searchParams.set("sidebar", sidebar);
  }
  return url.toString();
}
