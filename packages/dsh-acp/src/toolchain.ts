import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNTIME_PACKAGE_DIR = join("deepseek_harness_runtime", "runtime");

export interface DshToolchain {
  runtimeBin: string;
  cordisPath: string;
}

export interface ResolveDshToolchainInput {
  dshHome: string;
  runtimeBin?: string;
  cordis?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SetupDshToolchainInput {
  dshHome: string;
  env?: NodeJS.ProcessEnv;
  run?: ProcessRunner;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<ProcessResult>;

export function resolveDshToolchain(input: ResolveDshToolchainInput): DshToolchain | undefined {
  const env = input.env ?? process.env;
  const explicitRuntime = input.runtimeBin?.trim();
  const explicitCordis = input.cordis?.trim();

  if (explicitRuntime) {
    const runtimeBin = resolveExecutable(explicitRuntime, env);
    if (!isFile(runtimeBin)) {
      return undefined;
    }
    const cordisPath = explicitCordis ?? findCordisNearRuntime(runtimeBin);
    if (!cordisPath || !isFile(cordisPath)) {
      return undefined;
    }
    return { runtimeBin, cordisPath };
  }

  for (const root of candidateToolchainRoots(input.dshHome)) {
    const toolchain = findToolchainInRoot(root, explicitCordis);
    if (toolchain) {
      return toolchain;
    }
  }

  const pathRuntime = resolveExecutable("dsh-jsonrpc-agent", env);
  if (pathRuntime !== "dsh-jsonrpc-agent" || commandExistsOnPath(pathRuntime, env)) {
    const cordisPath = explicitCordis ?? findCordisNearRuntime(pathRuntime);
    if (cordisPath && isFile(cordisPath)) {
      return { runtimeBin: pathRuntime, cordisPath };
    }
  }
  return undefined;
}

export async function setupDshToolchain(input: SetupDshToolchainInput): Promise<DshToolchain> {
  const env = input.env ?? process.env;
  const existing = resolveDshToolchain({ dshHome: input.dshHome, env });
  if (existing) {
    installDshWebWorkspaceBridge(input.dshHome);
    return existing;
  }

  const uv = resolveUv(env);
  if (!uv) {
    throw new Error("uv was not found. Install it from https://docs.astral.sh/uv/");
  }

  const root = join(input.dshHome, "toolchains", "dsh-runtime");
  const venv = join(root, ".venv");
  mkdirSync(root, { recursive: true });
  const run = input.run ?? runProcess;

  if (!existsSync(venv)) {
    const created = await run(uv, ["venv", venv], { env });
    assertProcessSucceeded(created, "create the DeepSeek Harness runtime environment");
  }

  const python =
    process.platform === "win32"
      ? join(venv, "Scripts", "python.exe")
      : join(venv, "bin", "python");
  const installed = await run(
    uv,
    ["pip", "install", "--upgrade", "--python", python, "deepseek-harness-sdk"],
    { cwd: root, env },
  );
  assertProcessSucceeded(installed, "install deepseek-harness-sdk");

  const toolchain = resolveDshToolchain({ dshHome: input.dshHome, env });
  if (!toolchain) {
    throw new Error("deepseek-harness-sdk installed, but dsh-jsonrpc-agent was not found");
  }
  installDshWebWorkspaceBridge(input.dshHome);
  return toolchain;
}

export function installDshWebWorkspaceBridge(dshHome: string): boolean {
  const webProfile = join(dshHome, "profiles", "web");
  if (!existsSync(join(webProfile, "package.json"))) {
    return false;
  }
  const managedDirectory = join(dshHome, "paseo");
  mkdirSync(managedDirectory, { recursive: true });
  const source = resolveWebWorkspaceBridgeAsset();
  const target = join(managedDirectory, "dsh-acp-web-workspace.js");
  copyFileSync(source, target);

  const patchPath = join(webProfile, "cordis.patch.yml");
  const current = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "[]\n";
  const begin = "# dsh-acp-workspace-bridge: begin";
  const end = "# dsh-acp-workspace-bridge: end";
  const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "g");
  const unmanaged = current.replace(pattern, "").trimEnd();
  const block = [
    begin,
    "- insert:",
    "    - id: dsh-acp-workspace-host",
    `      name: ${JSON.stringify(pathToFileURL(target).href)}`,
    end,
  ].join("\n");
  atomicWrite(patchPath, `${unmanaged}\n${block}\n`);
  return true;
}

function resolveWebWorkspaceBridgeAsset(): string {
  for (const candidate of [
    new URL("../assets/dsh-web-workspace-plugin.mjs", import.meta.url),
    new URL("../../assets/dsh-web-workspace-plugin.mjs", import.meta.url),
  ]) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) {
      return path;
    }
  }
  throw new Error("dsh-acp Web workspace bridge asset is missing");
}

export function candidateToolchainRoots(dshHome: string): string[] {
  const home = homedir();
  const roots = [
    join(dshHome, "toolchains", "dsh-runtime"),
    join(dshHome, "venv"),
    join(dshHome, ".venv"),
  ];
  if (process.platform === "darwin") {
    roots.push(
      join(home, "Library", "Application Support", "Paseo", "toolchains", "dsh-runtime"),
      join(home, "Library", "Application Support", "Paseo", "toolchains", "deepseek-harness"),
    );
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    if (appData) {
      roots.push(join(appData, "Paseo", "toolchains", "dsh-runtime"));
      roots.push(join(appData, "Paseo", "toolchains", "deepseek-harness"));
    }
  } else {
    roots.push(join(home, ".local", "share", "Paseo", "toolchains", "dsh-runtime"));
    roots.push(join(home, ".local", "share", "Paseo", "toolchains", "deepseek-harness"));
  }
  return [...new Set(roots)];
}

function findToolchainInRoot(root: string, explicitCordis?: string): DshToolchain | undefined {
  if (!existsSync(root)) {
    return undefined;
  }
  for (const candidate of [root, join(root, ".venv"), join(root, "venv")]) {
    const found = findToolchainInVenv(candidate, explicitCordis);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findToolchainInVenv(venv: string, explicitCordis?: string): DshToolchain | undefined {
  const binDir = process.platform === "win32" ? join(venv, "Scripts") : join(venv, "bin");
  const script = join(
    binDir,
    process.platform === "win32" ? "dsh-jsonrpc-agent.exe" : "dsh-jsonrpc-agent",
  );
  if (isFile(script)) {
    const cordisPath = explicitCordis ?? findCordisInVenv(venv) ?? findCordisNearRuntime(script);
    if (cordisPath && isFile(cordisPath)) {
      return { runtimeBin: script, cordisPath };
    }
  }

  const runtimeDir = findRuntimePackageDir(venv);
  if (!runtimeDir) {
    return undefined;
  }
  const runtimeBin = runtimeBinaryNames()
    .map((name) => join(runtimeDir, name))
    .find(isFile);
  const cordisPath = explicitCordis ?? join(runtimeDir, "cordis.yml");
  if (!runtimeBin || !isFile(cordisPath)) {
    return undefined;
  }
  return { runtimeBin, cordisPath };
}

function findCordisInVenv(venv: string): string | undefined {
  const runtimeDir = findRuntimePackageDir(venv);
  const cordis = runtimeDir ? join(runtimeDir, "cordis.yml") : undefined;
  return cordis && isFile(cordis) ? cordis : undefined;
}

function findRuntimePackageDir(venv: string): string | undefined {
  const lib = join(venv, "lib");
  if (!existsSync(lib)) {
    return undefined;
  }
  for (const entry of safeReadDir(lib)) {
    if (!entry.startsWith("python")) {
      continue;
    }
    const runtimeDir = join(lib, entry, "site-packages", RUNTIME_PACKAGE_DIR);
    if (existsSync(runtimeDir)) {
      return runtimeDir;
    }
  }
  return undefined;
}

function runtimeBinaryNames(): string[] {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return ["dsh-jsonrpc-agent-pkg-macos-arm64", "dsh-jsonrpc-agent"];
  }
  if (process.platform === "darwin") {
    return ["dsh-jsonrpc-agent-pkg-macos-x64", "dsh-jsonrpc-agent"];
  }
  if (process.platform === "win32") {
    return ["dsh-jsonrpc-agent-pkg-win-x64.exe", "dsh-jsonrpc-agent.exe"];
  }
  return ["dsh-jsonrpc-agent-pkg-linux-x64", "dsh-jsonrpc-agent"];
}

function findCordisNearRuntime(runtimeBin: string): string | undefined {
  const beside = join(dirname(runtimeBin), "cordis.yml");
  return isFile(beside) ? beside : undefined;
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string {
  if (command.includes("/") || command.includes("\\")) {
    return command;
  }
  const pathValue = env.PATH ?? "";
  for (const pathDir of pathValue.split(delimiter)) {
    const candidate = join(pathDir, command);
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return command;
}

function commandExistsOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  return resolveExecutable(command, env) !== command;
}

function resolveUv(env: NodeJS.ProcessEnv): string | undefined {
  const fromPath = resolveExecutable("uv", env);
  if (fromPath !== "uv") {
    return fromPath;
  }
  for (const candidate of [
    join(homedir(), ".local", "bin", "uv"),
    join(homedir(), ".cargo", "bin", "uv"),
    "/opt/homebrew/bin/uv",
    "/usr/local/bin/uv",
  ]) {
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function runProcess(
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function assertProcessSucceeded(result: ProcessResult, action: string): void {
  if (result.code === 0) {
    return;
  }
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  throw new Error(`Failed to ${action}: ${detail}`);
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, content, "utf8");
  renameSync(temporary, path);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
