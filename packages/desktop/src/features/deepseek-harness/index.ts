import { execFileSync, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";
import { connect as netConnect, createServer } from "node:net";
import { app, ipcMain } from "electron";
import { createElectronNodeEnv } from "../../daemon/node-entrypoint-launcher.js";
import { getDesktopSettingsStore } from "../../settings/desktop-settings-electron.js";
import { createExternalProcessEnv } from "../editor-targets/runtime.js";
import { ensureDshWorkspace, normalizeBaseUrl, probeDshApi } from "./api.js";
import {
  getDeepseekHarnessInstallStatus,
  installOrUpgradeDeepseekHarness,
  type DeepseekHarnessInstallDependencies,
  type DeepseekHarnessInstallStatus,
} from "./install.js";

const HOST = "127.0.0.1";
const READY_TIMEOUT_MS = 45_000;
const READY_POLL_INTERVAL_MS = 250;
const STOP_TIMEOUT_MS = 3_000;

export interface DeepseekHarnessStatus extends DeepseekHarnessInstallStatus {
  running: boolean;
  url: string | null;
  port: number | null;
  startWithDesktop: boolean;
  spawnedByUs: boolean;
}

export interface DeepseekHarnessOpenWorkspaceResult {
  status: DeepseekHarnessStatus;
  dshWorkspaceId: string;
  url: string;
}

interface RuntimeDependencies extends DeepseekHarnessInstallDependencies {
  ipc?: IpcHandlerRegistry;
}

interface IpcHandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

let spawnedByUs = false;
let managedChild: ChildProcess | null = null;
let managedPort: number | null = null;

function buildUrl(port: number): string {
  return `http://${HOST}:${port}`;
}

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host: HOST });
    const done = (reachable: boolean) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export async function allocateFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a free port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function findPortListenerPids(port: number, platform: NodeJS.Platform): number[] {
  try {
    if (platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
      const pids = new Set<number>();
      for (const line of out.split(/\r?\n/)) {
        const match = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
        if (match && Number(match[1]) === port) {
          pids.add(Number(match[2]));
        }
      }
      return [...pids];
    }
    const out = execFileSync("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    });
    return out
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function killPids(pids: readonly number[], platform: NodeJS.Platform, force: boolean): void {
  for (const pid of pids) {
    try {
      if (platform === "win32") {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
      } else {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      }
    } catch {
      // already gone
    }
  }
}

async function waitForReady(input: { port: number; child: ChildProcess }): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let exited = false;
  input.child.once("exit", () => {
    exited = true;
  });
  const baseUrl = buildUrl(input.port);
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error("DeepSeek Harness exited before it became ready");
    }
    if (await probeDshApi(baseUrl)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  throw new Error("DeepSeek Harness did not become ready in time");
}

async function readSettingsSlice(): Promise<{
  startWithDesktop: boolean;
  port: number | null;
}> {
  const settings = await getDesktopSettingsStore().get();
  return {
    startWithDesktop: settings.deepseekHarness.startWithDesktop,
    port: settings.deepseekHarness.port,
  };
}

async function persistPort(port: number): Promise<void> {
  await getDesktopSettingsStore().patch({ deepseekHarness: { port } });
}

export async function getDeepseekHarnessStatus(
  dependencies: RuntimeDependencies = {},
): Promise<DeepseekHarnessStatus> {
  const install = await getDeepseekHarnessInstallStatus(dependencies);
  const settings = await readSettingsSlice();
  const port = managedPort ?? settings.port;
  if (port == null) {
    return {
      ...install,
      running: false,
      url: null,
      port: null,
      startWithDesktop: settings.startWithDesktop,
      spawnedByUs,
    };
  }

  const url = buildUrl(port);
  const running = await probeDshApi(url);
  return {
    ...install,
    running,
    url: running ? url : null,
    port,
    startWithDesktop: settings.startWithDesktop,
    spawnedByUs,
  };
}

async function resolveLaunchPort(preferred: number | null): Promise<number> {
  if (preferred != null && preferred > 0) {
    const url = buildUrl(preferred);
    if (await probeDshApi(url)) {
      return preferred;
    }
    if (!(await isPortListening(preferred))) {
      return preferred;
    }
  }
  return await allocateFreePort();
}

export async function startDeepseekHarness(
  dependencies: RuntimeDependencies = {},
): Promise<DeepseekHarnessStatus> {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const execPath = dependencies.execPath ?? process.execPath;
  const existsSync = dependencies.existsSync ?? nodeExistsSync;
  const spawn = dependencies.spawn ?? nodeSpawn;
  const isPackaged = dependencies.isPackaged ?? app.isPackaged;

  const current = await getDeepseekHarnessStatus(dependencies);
  if (current.running && current.port != null) {
    managedPort = current.port;
    return current;
  }

  let installStatus = {
    installed: current.installed,
    version: current.version,
    installRoot: current.installRoot,
    entryPath: current.entryPath,
  };
  if (!installStatus.installed || !installStatus.entryPath) {
    installStatus = await installOrUpgradeDeepseekHarness(dependencies);
  }
  if (!installStatus.entryPath || !existsSync(installStatus.entryPath)) {
    throw new Error("DeepSeek Harness is not installed");
  }

  const settings = await readSettingsSlice();
  const port = await resolveLaunchPort(settings.port);
  await persistPort(port);
  managedPort = port;

  // Another process may already be serving our persisted port.
  if (await probeDshApi(buildUrl(port))) {
    return await getDeepseekHarnessStatus(dependencies);
  }

  const childEnv = createElectronNodeEnv(createExternalProcessEnv(env), { isPackaged });
  const child = spawn(
    execPath,
    [installStatus.entryPath, "web", "--port", String(port), "--no-open"],
    {
      detached: platform !== "win32",
      env: childEnv,
      stdio: "ignore",
    },
  );
  managedChild = child;
  spawnedByUs = true;
  child.once("exit", () => {
    if (managedChild === child) {
      managedChild = null;
    }
  });

  try {
    await waitForReady({ port, child });
  } catch (error) {
    await stopDeepseekHarness({ ...dependencies, platform });
    throw error;
  }

  return await getDeepseekHarnessStatus(dependencies);
}

async function stopByPort(port: number, platform: NodeJS.Platform): Promise<void> {
  const pids = findPortListenerPids(port, platform);
  if (pids.length === 0) {
    return;
  }
  killPids(pids, platform, false);
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await isPortListening(port))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  killPids(findPortListenerPids(port, platform), platform, true);
}

export async function stopDeepseekHarness(
  dependencies: RuntimeDependencies = {},
): Promise<DeepseekHarnessStatus> {
  const platform = dependencies.platform ?? process.platform;
  const settings = await readSettingsSlice();
  const port = managedPort ?? settings.port;

  if (managedChild && !managedChild.killed) {
    try {
      managedChild.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  managedChild = null;

  if (spawnedByUs && port != null) {
    await stopByPort(port, platform);
  }
  spawnedByUs = false;
  return await getDeepseekHarnessStatus(dependencies);
}

export async function openDeepseekHarnessWorkspace(input: {
  cwd: string;
  title?: string | null;
  dependencies?: RuntimeDependencies;
}): Promise<DeepseekHarnessOpenWorkspaceResult> {
  const dependencies = input.dependencies ?? {};
  let status = await getDeepseekHarnessStatus(dependencies);
  if (!status.running) {
    status = await startDeepseekHarness(dependencies);
  }
  if (!status.url || status.port == null) {
    throw new Error("DeepSeek Harness is not running");
  }
  const workspace = await ensureDshWorkspace({
    baseUrl: status.url,
    cwd: input.cwd,
    title: input.title,
  });
  return {
    status,
    dshWorkspaceId: workspace.workspaceId,
    url: normalizeBaseUrl(status.url),
  };
}

export function registerDeepseekHarnessHandlers(
  options: { ipc?: IpcHandlerRegistry; dependencies?: RuntimeDependencies } = {},
): void {
  const ipc = options.ipc ?? ipcMain;
  const dependencies = options.dependencies ?? {};

  ipc.handle("paseo:deepseek-harness:getStatus", () => getDeepseekHarnessStatus(dependencies));
  ipc.handle("paseo:deepseek-harness:install", () => installOrUpgradeDeepseekHarness(dependencies));
  ipc.handle("paseo:deepseek-harness:start", () => startDeepseekHarness(dependencies));
  ipc.handle("paseo:deepseek-harness:stop", () => stopDeepseekHarness(dependencies));
  ipc.handle("paseo:deepseek-harness:openWorkspace", (_event, rawInput: unknown) => {
    if (!rawInput || typeof rawInput !== "object") {
      throw new Error("Invalid DeepSeek Harness openWorkspace input");
    }
    const record = rawInput as Record<string, unknown>;
    const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
    if (!cwd) {
      throw new Error("DeepSeek Harness openWorkspace requires cwd");
    }
    const title = typeof record.title === "string" ? record.title : null;
    return openDeepseekHarnessWorkspace({ cwd, title, dependencies });
  });
}

export function shutdownDeepseekHarness(): void {
  if (!spawnedByUs) {
    return;
  }
  spawnedByUs = false;
  if (managedChild && !managedChild.killed) {
    try {
      managedChild.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  managedChild = null;
  if (managedPort != null) {
    killPids(findPortListenerPids(managedPort, process.platform), process.platform, false);
  }
}

export async function maybeAutoStartDeepseekHarness(
  dependencies: RuntimeDependencies = {},
): Promise<void> {
  const settings = await readSettingsSlice();
  if (!settings.startWithDesktop) {
    return;
  }
  await startDeepseekHarness(dependencies);
}
