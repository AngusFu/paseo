import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { ipcMain } from "electron";
import { createExternalProcessEnv, resolveExecutable } from "./editor-targets/runtime.js";

// A single, machine-global `code serve-web` instance. It serves any local
// folder over http://127.0.0.1:19490/?folder=<abs-path>, so one process backs
// every workspace. The port is fixed so the URL is stable and predictable.
const CODE_SERVER_HOST = "127.0.0.1";
const CODE_SERVER_PORT = 19490;
const CODE_SERVER_URL = `http://${CODE_SERVER_HOST}:${CODE_SERVER_PORT}`;
const READY_TIMEOUT_MS = 20_000;
const READY_POLL_INTERVAL_MS = 250;
const STOP_TIMEOUT_MS = 3_000;

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

// Whether we started serve-web this session — gates the kill-on-quit cleanup so
// we never tear down a serve-web the user launched independently of the app.
// We stop by killing whatever holds the port (see stopByPort), never by a saved
// child handle: the `code` launcher reparents serve-web into its own process
// group, so a process-group kill misses it, and an orphan can outlive a restart.
let spawnedByUs = false;

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

// PIDs listening on the port. Authoritative for stop: the port is the resource
// we own, regardless of which process (ours, an orphan, external) holds it.
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
    // lsof/netstat exit non-zero when nothing matches.
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
      // Already gone.
    }
  }
}

async function waitForReady(child: ReturnType<typeof nodeSpawn>): Promise<void> {
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

  const executable = resolveExecutable(["code"], { env, pathExists: existsSync, platform });
  if (!executable) {
    throw new Error("VS Code CLI (`code`) was not found on PATH");
  }

  const child = spawn(
    executable,
    [
      // Pin the UI to English regardless of the OS locale — a localized VS Code
      // web UI is jarring here. Global `code` option, must precede the `serve-web`
      // subcommand.
      "--locale",
      "en-US",
      "serve-web",
      "--host",
      CODE_SERVER_HOST,
      "--port",
      String(CODE_SERVER_PORT),
      "--without-connection-token",
      "--accept-server-license-terms",
    ],
    {
      // Detach so a crash in the Electron main process does not SIGHUP serve-web
      // mid-session; we clean it up explicitly by port on stop/quit.
      detached: platform !== "win32",
      env: createExternalProcessEnv(env),
      stdio: "ignore",
    },
  );
  spawnedByUs = true;

  try {
    await waitForReady(child);
  } catch (error) {
    await stopByPort(platform);
    throw error;
  }
  return { running: true, url: CODE_SERVER_URL, port: CODE_SERVER_PORT };
}

async function stopByPort(platform: NodeJS.Platform): Promise<void> {
  spawnedByUs = false;
  const pids = findPortListenerPids(CODE_SERVER_PORT, platform);
  if (pids.length === 0) {
    return;
  }
  killPids(pids, platform, false);

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await probePort(CODE_SERVER_PORT, CODE_SERVER_HOST))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  // Escalate to SIGKILL for anything that ignored SIGTERM.
  killPids(findPortListenerPids(CODE_SERVER_PORT, platform), platform, true);
}

export async function stopCodeServer(
  dependencies: CodeServerDependencies = {},
): Promise<CodeServerStatus> {
  const platform = dependencies.platform ?? process.platform;
  await stopByPort(platform);
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

// Kill the serve-web we started when the desktop app quits, so we do not leak an
// orphan the user can no longer see or control. Synchronous + best-effort: the
// quit path cannot await. Only fires if we started it (never touches a serve-web
// the user launched independently).
export function shutdownCodeServer(): void {
  if (!spawnedByUs) {
    return;
  }
  spawnedByUs = false;
  killPids(findPortListenerPids(CODE_SERVER_PORT, process.platform), process.platform, false);
}
