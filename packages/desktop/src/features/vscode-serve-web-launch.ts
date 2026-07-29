import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolvePaseoHome } from "@getpaseo/server";
import { resolveExecutable } from "./editor-targets/runtime.js";

const CODE_SERVER_DATA_DIRNAME = "code-server-data";
const CODE_SERVER_TRUST_SETTINGS = {
  "security.workspace.trust.enabled": false,
  "security.workspace.trust.startupPrompt": "never",
} as const;

export interface VSCodeServeWebLaunchConfig {
  executable: string;
  /** When true, invoke the `serve-web` subcommand (code-tunnel / PATH `code`). */
  usesServeWebSubcommand: boolean;
  env: NodeJS.ProcessEnv;
}

export interface ResolveVSCodeServeWebLaunchInput {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  pathExists?: (targetPath: string) => boolean;
  readFile?: (targetPath: string) => string | null;
  readDir?: (targetPath: string) => string[];
  statMtimeMs?: (targetPath: string) => number | null;
}

interface VSCodeInstall {
  appResourcesPath: string;
  dataFolderName: string;
}

function isSafePathComponent(component: string): boolean {
  if (component.length === 0 || component === "." || component === "..") {
    return false;
  }
  return !/[\\/]/u.test(component);
}

function defaultPathExists(targetPath: string): boolean {
  try {
    accessSync(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultIsExecutable(targetPath: string, platform: NodeJS.Platform): boolean {
  if (!defaultPathExists(targetPath)) {
    return false;
  }
  if (platform === "win32") {
    return true;
  }
  try {
    accessSync(targetPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultReadFile(targetPath: string): string | null {
  try {
    return readFileSync(targetPath, "utf8");
  } catch {
    return null;
  }
}

function defaultReadDir(targetPath: string): string[] {
  try {
    return readdirSync(targetPath);
  } catch {
    return [];
  }
}

function defaultStatMtimeMs(targetPath: string): number | null {
  try {
    return statSync(targetPath).mtimeMs;
  } catch {
    return null;
  }
}

/** Mirrors VS Code's shellEnv hygiene before launching CLI binaries. */
export function createVSCodeNodeSafeEnvironment(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...baseEnv };
  delete environment.VSCODE_NODE_OPTIONS;
  delete environment.VSCODE_NODE_REPL_EXTERNAL_MODULE;

  const nodeOptions = environment.NODE_OPTIONS;
  if (nodeOptions !== undefined) {
    environment.VSCODE_NODE_OPTIONS = nodeOptions;
  }
  const nodeReplExternalModule = environment.NODE_REPL_EXTERNAL_MODULE;
  if (nodeReplExternalModule !== undefined) {
    environment.VSCODE_NODE_REPL_EXTERNAL_MODULE = nodeReplExternalModule;
  }

  delete environment.NODE_OPTIONS;
  delete environment.NODE_REPL_EXTERNAL_MODULE;
  return environment;
}

function readDataFolderName(
  appResourcesPath: string,
  readFile: (path: string) => string | null,
): string {
  const productPath = path.join(appResourcesPath, "product.json");
  const raw = readFile(productPath);
  if (!raw) {
    return ".vscode";
  }
  try {
    const product = JSON.parse(raw) as { dataFolderName?: unknown };
    const dataFolderName = product.dataFolderName;
    if (typeof dataFolderName === "string" && isSafePathComponent(dataFolderName)) {
      return dataFolderName;
    }
  } catch {
    // Fall back to stable VS Code default.
  }
  return ".vscode";
}

function listVSCodeInstallRoots(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  const roots: string[] = [];
  if (input.platform === "darwin") {
    roots.push(
      "/Applications/Visual Studio Code.app",
      path.join(input.homeDirectory, "Applications/Visual Studio Code.app"),
      "/Applications/Code.app",
    );
    return roots;
  }
  if (input.platform === "win32") {
    if (input.env.LOCALAPPDATA) {
      roots.push(path.join(input.env.LOCALAPPDATA, "Programs/Microsoft VS Code"));
    }
    if (input.env.ProgramFiles) {
      roots.push(path.join(input.env.ProgramFiles, "Microsoft VS Code"));
    }
    return roots;
  }
  roots.push("/usr/share/code", "/opt/visual-studio-code");
  return roots;
}

function appResourcesPathForInstallRoot(installRoot: string, platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return path.join(installRoot, "Contents/Resources/app");
  }
  return path.join(installRoot, "resources/app");
}

function listVSCodeInstalls(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  pathExists: (targetPath: string) => boolean;
  readFile: (targetPath: string) => string | null;
}): VSCodeInstall[] {
  const installs: VSCodeInstall[] = [];
  for (const installRoot of listVSCodeInstallRoots(input)) {
    if (!input.pathExists(installRoot)) {
      continue;
    }
    const appResourcesPath = appResourcesPathForInstallRoot(installRoot, input.platform);
    if (!input.pathExists(appResourcesPath)) {
      continue;
    }
    installs.push({
      appResourcesPath,
      dataFolderName: readDataFolderName(appResourcesPath, input.readFile),
    });
  }
  return installs;
}

function readServeWebLRUCacheIDs(
  serveWebCachePath: string,
  readFile: (targetPath: string) => string | null,
): string[] | null {
  const raw = readFile(path.join(serveWebCachePath, "lru.json"));
  if (!raw) {
    return null;
  }
  try {
    const cacheIDs = JSON.parse(raw) as unknown;
    if (!Array.isArray(cacheIDs)) {
      return null;
    }
    return cacheIDs.filter(
      (value): value is string => typeof value === "string" && isSafePathComponent(value),
    );
  } catch {
    return null;
  }
}

function preferredCachedCodeServerURL(input: {
  dataFolderName: string;
  homeDirectory: string;
  platform: NodeJS.Platform;
  isExecutable: (targetPath: string) => boolean;
  readFile: (targetPath: string) => string | null;
  readDir: (targetPath: string) => string[];
  statMtimeMs: (targetPath: string) => number | null;
}): string | null {
  const serveWebCachePath = path.join(input.homeDirectory, input.dataFolderName, "cli/serve-web");
  const codeServerName = input.platform === "win32" ? "code-server.exe" : "code-server";

  const orderedCacheIDs = readServeWebLRUCacheIDs(serveWebCachePath, input.readFile);
  if (orderedCacheIDs) {
    for (const cacheID of orderedCacheIDs) {
      const candidate = path.join(serveWebCachePath, cacheID, "bin", codeServerName);
      if (input.isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  const candidates = input
    .readDir(serveWebCachePath)
    .map((cacheID) => path.join(serveWebCachePath, cacheID, "bin", codeServerName))
    .filter((candidate) => input.isExecutable(candidate))
    .sort((left, right) => {
      const leftMtime = input.statMtimeMs(left) ?? 0;
      const rightMtime = input.statMtimeMs(right) ?? 0;
      if (leftMtime !== rightMtime) {
        return rightMtime - leftMtime;
      }
      return right.localeCompare(left);
    });

  return candidates[0] ?? null;
}

function codeTunnelPath(appResourcesPath: string, platform: NodeJS.Platform): string {
  const name = platform === "win32" ? "code-tunnel.exe" : "code-tunnel";
  return path.join(appResourcesPath, "bin", name);
}

function launchFromCachedCodeServer(
  executable: string,
  env: NodeJS.ProcessEnv,
): VSCodeServeWebLaunchConfig {
  const launchEnv = createVSCodeNodeSafeEnvironment(env);
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  return {
    executable,
    usesServeWebSubcommand: false,
    env: launchEnv,
  };
}

function launchFromCodeTunnel(
  executable: string,
  env: NodeJS.ProcessEnv,
): VSCodeServeWebLaunchConfig {
  return {
    executable,
    usesServeWebSubcommand: true,
    env: {
      ...createVSCodeNodeSafeEnvironment(env),
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}

function listPathCodeCommands(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
}): string[] {
  if (input.platform === "win32") {
    const commands: string[] = [];
    if (input.env.LOCALAPPDATA) {
      commands.push(path.join(input.env.LOCALAPPDATA, "Programs/Microsoft VS Code/bin/code.cmd"));
    }
    if (input.env.ProgramFiles) {
      commands.push(path.join(input.env.ProgramFiles, "Microsoft VS Code/bin/code.cmd"));
    }
    commands.push("code");
    return commands;
  }
  if (input.platform === "darwin") {
    const commands = ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"];
    if (input.homeDirectory) {
      commands.push(
        path.join(
          input.homeDirectory,
          "Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        ),
      );
    }
    commands.push("code");
    return commands;
  }
  return ["code", "/usr/share/code/bin/code"];
}

function resolveCachedServeWebLaunch(input: {
  installs: VSCodeInstall[];
  homeDirectory: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isExecutable: (targetPath: string) => boolean;
  readFile: (targetPath: string) => string | null;
  readDir: (targetPath: string) => string[];
  statMtimeMs: (targetPath: string) => number | null;
}): VSCodeServeWebLaunchConfig | null {
  const seenDataFolders = new Set<string>();
  for (const install of input.installs) {
    if (seenDataFolders.has(install.dataFolderName)) {
      continue;
    }
    seenDataFolders.add(install.dataFolderName);
    const cachedCodeServer = preferredCachedCodeServerURL({
      dataFolderName: install.dataFolderName,
      homeDirectory: input.homeDirectory,
      platform: input.platform,
      isExecutable: input.isExecutable,
      readFile: input.readFile,
      readDir: input.readDir,
      statMtimeMs: input.statMtimeMs,
    });
    if (cachedCodeServer) {
      return launchFromCachedCodeServer(cachedCodeServer, input.env);
    }
  }
  return null;
}

function resolveCodeTunnelServeWebLaunch(input: {
  installs: VSCodeInstall[];
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isExecutable: (targetPath: string) => boolean;
}): VSCodeServeWebLaunchConfig | null {
  for (const install of input.installs) {
    const tunnel = codeTunnelPath(install.appResourcesPath, input.platform);
    if (input.isExecutable(tunnel)) {
      return launchFromCodeTunnel(tunnel, input.env);
    }
  }
  return null;
}

function resolvePathCodeServeWebLaunch(input: {
  platform: NodeJS.Platform;
  homeDirectory: string;
  env: NodeJS.ProcessEnv;
  pathExists: (targetPath: string) => boolean;
}): VSCodeServeWebLaunchConfig | null {
  const executable = resolveExecutable(
    listPathCodeCommands({
      platform: input.platform,
      homeDirectory: input.homeDirectory,
      env: input.env,
    }),
    { env: input.env, pathExists: input.pathExists, platform: input.platform },
  );
  if (!executable) {
    return null;
  }
  return {
    executable,
    usesServeWebSubcommand: true,
    env: createVSCodeNodeSafeEnvironment(input.env),
  };
}

export function resolveVSCodeServeWebLaunch(
  input: ResolveVSCodeServeWebLaunchInput = {},
): VSCodeServeWebLaunchConfig | null {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const homeDirectory = input.homeDirectory ?? env.HOME ?? env.USERPROFILE ?? "";
  const pathExists = input.pathExists ?? defaultPathExists;
  const readFile = input.readFile ?? defaultReadFile;
  const readDir = input.readDir ?? defaultReadDir;
  const statMtimeMs = input.statMtimeMs ?? defaultStatMtimeMs;
  const isExecutable = (targetPath: string): boolean => {
    if (input.pathExists) {
      return input.pathExists(targetPath);
    }
    return defaultIsExecutable(targetPath, platform);
  };

  const installs = listVSCodeInstalls({
    platform,
    homeDirectory,
    env,
    pathExists,
    readFile,
  });

  const resolverInput = {
    installs,
    homeDirectory,
    platform,
    env,
    isExecutable,
    readFile,
    readDir,
    statMtimeMs,
    pathExists,
  };

  return (
    resolveCachedServeWebLaunch(resolverInput) ??
    resolveCodeTunnelServeWebLaunch(resolverInput) ??
    resolvePathCodeServeWebLaunch(resolverInput)
  );
}

export function resolveCodeServerDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePaseoHome(env), CODE_SERVER_DATA_DIRNAME);
}

/** Seed Paseo-managed serve-web data so workspace trust stays off for code-tunnel fallback. */
export function ensureCodeServerDataDir(dataDir: string): void {
  const userDir = path.join(dataDir, "User");
  mkdirSync(userDir, { recursive: true });
  const settingsPath = path.join(userDir, "settings.json");
  let settings: Record<string, unknown> = {};
  const existing = defaultReadFile(settingsPath);
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      // Replace corrupt settings with trust defaults.
    }
  }
  for (const [key, value] of Object.entries(CODE_SERVER_TRUST_SETTINGS)) {
    settings[key] = value;
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function buildServeWebArguments(input: {
  launch: VSCodeServeWebLaunchConfig;
  host: string;
  port: number;
  serverDataDir?: string;
}): string[] {
  const args: string[] = [];
  if (input.launch.usesServeWebSubcommand) {
    args.push("serve-web");
  }
  if (input.serverDataDir) {
    args.push("--server-data-dir", input.serverDataDir);
  }
  // Cached code-server accepts this; code-tunnel serve-web rejects it (use server-data-dir settings).
  if (!input.launch.usesServeWebSubcommand) {
    args.push("--disable-workspace-trust");
  }
  args.push(
    "--host",
    input.host,
    "--port",
    String(input.port),
    "--without-connection-token",
    "--accept-server-license-terms",
  );
  return args;
}
