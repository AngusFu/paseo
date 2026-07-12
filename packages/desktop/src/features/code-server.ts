import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { ipcMain } from "electron";
import { createExternalProcessEnv, resolveExecutable } from "./editor-targets.js";

// A single, machine-global `code serve-web` instance. It serves any local
// folder over http://127.0.0.1:19490/?folder=<abs-path>, so one process backs
// every workspace. The port is fixed so the URL is stable and predictable.
const CODE_SERVER_HOST = "127.0.0.1";
const CODE_SERVER_PORT = 19490;
const CODE_SERVER_URL = `http://${CODE_SERVER_HOST}:${CODE_SERVER_PORT}`;
const READY_TIMEOUT_MS = 20_000;
const READY_POLL_INTERVAL_MS = 250;

export interface CodeServerStatus {
  running: boolean;
  url: string;
  port: number;
}

interface CodeServerDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  spawn?: typeof nodeSpawn;
}

interface IpcHandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

// The process we spawned, if any. We can only stop what we own; an externally
// launched serve-web on the same port still reads as "running" via port probe.
let managedProcess: ChildProcess | null = null;

function probePort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host });
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

async function waitForReady(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error("code serve-web exited before it became ready");
    }
    if (await probePort(CODE_SERVER_PORT, CODE_SERVER_HOST)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  throw new Error("code serve-web did not start listening in time");
}

export async function getCodeServerStatus(): Promise<CodeServerStatus> {
  const running = await probePort(CODE_SERVER_PORT, CODE_SERVER_HOST);
  return { running, url: CODE_SERVER_URL, port: CODE_SERVER_PORT };
}

export async function startCodeServer(
  dependencies: CodeServerDependencies = {},
): Promise<CodeServerStatus> {
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const existsSync = dependencies.existsSync ?? nodeExistsSync;
  const spawn = dependencies.spawn ?? nodeSpawn;

  // Already reachable (ours or externally launched) — nothing to do.
  if (await probePort(CODE_SERVER_PORT, CODE_SERVER_HOST)) {
    return { running: true, url: CODE_SERVER_URL, port: CODE_SERVER_PORT };
  }

  const executable = resolveExecutable("code", { env, existsSync, platform });
  if (!executable) {
    throw new Error("VS Code CLI (`code`) was not found on PATH");
  }

  const child = spawn(
    executable,
    [
      "serve-web",
      "--host",
      CODE_SERVER_HOST,
      "--port",
      String(CODE_SERVER_PORT),
      "--without-connection-token",
      "--accept-server-license-terms",
    ],
    {
      // Own process group so we can tree-kill it on stop, and so a crash in the
      // Electron main process does not SIGHUP it mid-session.
      detached: platform !== "win32",
      env: createExternalProcessEnv(env),
      stdio: "ignore",
    },
  );
  managedProcess = child;
  child.once("exit", () => {
    if (managedProcess === child) {
      managedProcess = null;
    }
  });

  try {
    await waitForReady(child);
  } catch (error) {
    stopManagedProcess(platform);
    throw error;
  }
  return { running: true, url: CODE_SERVER_URL, port: CODE_SERVER_PORT };
}

function stopManagedProcess(platform: NodeJS.Platform): void {
  const child = managedProcess;
  if (!child) {
    return;
  }
  managedProcess = null;
  if (child.pid === undefined) {
    return;
  }
  try {
    if (platform === "win32") {
      child.kill();
    } else {
      // Negative pid targets the whole process group (see `detached` above).
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    // Already gone.
  }
}

export async function stopCodeServer(
  dependencies: CodeServerDependencies = {},
): Promise<CodeServerStatus> {
  const platform = dependencies.platform ?? process.platform;
  stopManagedProcess(platform);
  return await getCodeServerStatus();
}

export function registerCodeServerHandlers(
  options: { ipc?: IpcHandlerRegistry; dependencies?: CodeServerDependencies } = {},
): void {
  const ipc = options.ipc ?? ipcMain;
  const dependencies = options.dependencies ?? {};
  ipc.handle("paseo:code-server:getStatus", () => getCodeServerStatus());
  ipc.handle("paseo:code-server:start", () => startCodeServer(dependencies));
  ipc.handle("paseo:code-server:stop", () => stopCodeServer(dependencies));
}

// Kill the serve-web process we own when the desktop app quits, so we do not
// leak an orphaned server the user can no longer see or control.
export function shutdownCodeServer(): void {
  stopManagedProcess(process.platform);
}
