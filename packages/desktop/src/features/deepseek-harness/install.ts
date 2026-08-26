import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync as nodeExistsSync, realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { createElectronNodeEnv } from "../../daemon/node-entrypoint-launcher.js";
import { createExternalProcessEnv, resolveExecutable } from "../editor-targets/runtime.js";

export const DSH_PACKAGE_NAME = "@deepseek-ai/dsh";

export interface DeepseekHarnessInstallStatus {
  installed: boolean;
  version: string | null;
  installRoot: string;
  entryPath: string | null;
}

export interface DeepseekHarnessInstallDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  userDataPath?: string;
  existsSync?: (filePath: string) => boolean;
  spawn?: typeof nodeSpawn;
  isPackaged?: boolean;
  /** Optional live stdout/stderr chunks from `npm install`. */
  onLog?: (chunk: string) => void;
}

function resolveInstallRoot(userDataPath: string): string {
  return path.join(userDataPath, "toolchains", "deepseek-harness");
}

export function resolveDeepseekHarnessInstallRoot(
  dependencies: DeepseekHarnessInstallDependencies = {},
): string {
  const userDataPath = dependencies.userDataPath ?? app.getPath("userData");
  return resolveInstallRoot(userDataPath);
}

export function resolveDeepseekHarnessEntryPath(installRoot: string): string {
  return path.join(installRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
}

export function resolveDeepseekHarnessPackageJsonPath(installRoot: string): string {
  return path.join(installRoot, "node_modules", "@deepseek-ai", "dsh", "package.json");
}

async function readInstalledVersion(
  installRoot: string,
  existsSync: (filePath: string) => boolean,
): Promise<string | null> {
  const packageJsonPath = resolveDeepseekHarnessPackageJsonPath(installRoot);
  if (!existsSync(packageJsonPath)) {
    return null;
  }
  try {
    const raw = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: unknown };
    return typeof raw.version === "string" && raw.version.trim() ? raw.version.trim() : null;
  } catch {
    return null;
  }
}

export async function getDeepseekHarnessInstallStatus(
  dependencies: DeepseekHarnessInstallDependencies = {},
): Promise<DeepseekHarnessInstallStatus> {
  const existsSync = dependencies.existsSync ?? nodeExistsSync;
  const installRoot = resolveDeepseekHarnessInstallRoot(dependencies);
  const entryPath = resolveDeepseekHarnessEntryPath(installRoot);
  const installed = existsSync(entryPath);
  const version = installed ? await readInstalledVersion(installRoot, existsSync) : null;
  return {
    installed,
    version,
    installRoot,
    entryPath: installed ? entryPath : null,
  };
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
    throw new Error("npm was not found on PATH (required to install DeepSeek Harness)");
  }

  let resolved = npmExecutable;
  try {
    resolved = realpathSync(npmExecutable);
  } catch {
    // keep as-is
  }

  // Prefer the JS entry so ELECTRON_RUN_AS_NODE can execute it.
  if (resolved.endsWith("npm-cli.js") && input.existsSync(resolved)) {
    return resolved;
  }
  const siblingCli = path.join(path.dirname(resolved), "npm-cli.js");
  if (input.existsSync(siblingCli)) {
    return siblingCli;
  }
  return resolved;
}

function chunkToString(chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

function runCommand(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  spawn: typeof nodeSpawn;
  onLog?: (chunk: string) => void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = input.spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunkToString(chunk);
      input.onLog?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunkToString(chunk);
      stderr += text;
      input.onLog?.(text);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim() || `exit code ${code ?? "unknown"}`;
      reject(new Error(`npm install ${DSH_PACKAGE_NAME} failed: ${detail}`));
    });
  });
}

export async function installOrUpgradeDeepseekHarness(
  dependencies: DeepseekHarnessInstallDependencies = {},
): Promise<DeepseekHarnessInstallStatus> {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const execPath = dependencies.execPath ?? process.execPath;
  const existsSync = dependencies.existsSync ?? nodeExistsSync;
  const spawn = dependencies.spawn ?? nodeSpawn;
  const isPackaged = dependencies.isPackaged ?? app.isPackaged;
  const installRoot = resolveDeepseekHarnessInstallRoot(dependencies);

  await mkdir(installRoot, { recursive: true });

  const npmCli = resolveNpmCliPath({ env, platform, existsSync });
  const electronEnv = createElectronNodeEnv(createExternalProcessEnv(env), { isPackaged });
  const onLog = dependencies.onLog;
  onLog?.(`Installing ${DSH_PACKAGE_NAME}@latest into ${installRoot}\n`);

  await runCommand({
    command: execPath,
    args: [
      npmCli,
      "install",
      `${DSH_PACKAGE_NAME}@latest`,
      "--prefix",
      installRoot,
      "--no-fund",
      "--no-audit",
    ],
    env: electronEnv,
    cwd: installRoot,
    spawn,
    onLog,
  });

  const status = await getDeepseekHarnessInstallStatus(dependencies);
  if (!status.installed) {
    throw new Error(
      `DeepSeek Harness install completed but ${DSH_PACKAGE_NAME} entry was not found`,
    );
  }
  return status;
}
