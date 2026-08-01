/**
 * Local-first Chroma sidecar for Docs VFS.
 *
 * JS/TS Chroma client is HTTP-only (no PersistentClient). We spawn the official
 * `chromadb` CLI (`chroma run --path …`) under $PASEO_HOME and talk over loopback.
 * Query path is pure JS; only the sidecar process loads platform NAPI bindings.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ChromaClient } from "chromadb";

import { resolvePaseoHomeForDocs } from "./embeddings.js";

export interface DocsChromaEndpoint {
  host: string;
  port: number;
  dataDir: string;
  /** True when we spawned this process in the current ensure call. */
  owned: boolean;
}

interface SidecarStateFile {
  host: string;
  port: number;
  pid: number;
  dataDir: string;
  startedAt: string;
}

const CHROMA_DIRNAME = "_chroma";
const STATE_FILENAME = "sidecar.json";
const LOCK_FILENAME = "sidecar.lock";

const childrenByHome = new Map<string, ChildProcess>();

export function docsChromaRoot(paseoHome: string): string {
  return join(paseoHome, "docs-vfs", CHROMA_DIRNAME);
}

export function docsChromaDataDir(paseoHome: string): string {
  return join(docsChromaRoot(paseoHome), "data");
}

function statePath(paseoHome: string): string {
  return join(docsChromaRoot(paseoHome), STATE_FILENAME);
}

function lockPath(paseoHome: string): string {
  return join(docsChromaRoot(paseoHome), LOCK_FILENAME);
}

function resolveChromaCliPath(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("chromadb");
  let dir = dirname(entry);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "cli.mjs");
    if (existsSync(candidate)) return candidate;
    const nested = join(dir, "dist", "cli.mjs");
    if (existsSync(nested)) return nested;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not resolve chromadb CLI (dist/cli.mjs). Ensure chromadb@3.5.0 is installed in @getpaseo/server.",
  );
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to reserve a loopback port for Chroma"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function readState(paseoHome: string): SidecarStateFile | null {
  const path = statePath(paseoHome);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as SidecarStateFile;
    if (
      typeof raw.host === "string" &&
      typeof raw.port === "number" &&
      typeof raw.pid === "number" &&
      typeof raw.dataDir === "string"
    ) {
      return raw;
    }
    return null;
  } catch {
    return null;
  }
}

function writeState(paseoHome: string, state: SidecarStateFile): void {
  mkdirSync(docsChromaRoot(paseoHome), { recursive: true });
  writeFileSync(statePath(paseoHome), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function heartbeatOk(host: string, port: number): Promise<boolean> {
  try {
    const client = new ChromaClient({ host, port, ssl: false });
    await client.heartbeat();
    return true;
  } catch {
    return false;
  }
}

function tryAcquireLock(paseoHome: string): boolean {
  mkdirSync(docsChromaRoot(paseoHome), { recursive: true });
  try {
    writeFileSync(lockPath(paseoHome), `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(paseoHome: string): void {
  try {
    unlinkSync(lockPath(paseoHome));
  } catch {
    // ignore
  }
}

async function waitForHeartbeat(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await heartbeatOk(host, port)) return;
    await sleep(100);
  }
  throw new Error(
    `Chroma sidecar at http://${host}:${port} did not become ready within ${timeoutMs}ms`,
  );
}

function spawnChroma(options: {
  paseoHome: string;
  dataDir: string;
  host: string;
  port: number;
}): ChildProcess {
  const cli = resolveChromaCliPath();
  mkdirSync(options.dataDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Prefer Electron-as-Node when the daemon/CLI already runs under Electron.
  if (process.env.ELECTRON_RUN_AS_NODE === undefined && process.versions.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  const child = spawn(
    process.execPath,
    [cli, "run", "--path", options.dataDir, "--host", options.host, "--port", String(options.port)],
    {
      // Detach so short-lived CLI invocations can exit while the sidecar keeps serving.
      detached: true,
      stdio: "ignore",
      env,
    },
  );
  childrenByHome.set(options.paseoHome, child);
  child.once("exit", () => {
    if (childrenByHome.get(options.paseoHome) === child) {
      childrenByHome.delete(options.paseoHome);
    }
  });
  // Allow the parent (CLI/vitest worker) to exit independently of the sidecar.
  child.unref();
  return child;
}

async function endpointFromHealthyState(
  state: SidecarStateFile,
  owned: boolean,
): Promise<DocsChromaEndpoint | null> {
  if (!processAlive(state.pid)) return null;
  if (!(await heartbeatOk(state.host, state.port))) return null;
  return {
    host: state.host,
    port: state.port,
    dataDir: state.dataDir,
    owned,
  };
}

async function resolveOverrideEndpoint(paseoHome: string): Promise<DocsChromaEndpoint | null> {
  const override = process.env.PASEO_CHROMA_URL?.trim();
  if (!override) return null;
  const url = new URL(override);
  let port = url.port ? Number(url.port) : 0;
  if (!port) {
    port = url.protocol === "https:" ? 443 : 80;
  }
  const host = url.hostname || "127.0.0.1";
  if (!(await heartbeatOk(host, port))) {
    throw new Error(`PASEO_CHROMA_URL is set but Chroma is unreachable at ${override}`);
  }
  return { host, port, dataDir: docsChromaDataDir(paseoHome), owned: false };
}

async function waitForLockOrPeer(paseoHome: string): Promise<DocsChromaEndpoint | "locked"> {
  const deadline = Date.now() + 15_000;
  while (!tryAcquireLock(paseoHome)) {
    const raced = readState(paseoHome);
    if (raced) {
      const endpoint = await endpointFromHealthyState(raced, false);
      if (endpoint) return endpoint;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for Chroma sidecar lock under ${docsChromaRoot(paseoHome)}`,
      );
    }
    await sleep(100);
  }
  return "locked";
}

async function startOwnedSidecar(paseoHome: string): Promise<DocsChromaEndpoint> {
  const host = "127.0.0.1";
  const port = await reserveLoopbackPort();
  const dataDir = docsChromaDataDir(paseoHome);
  const child = spawnChroma({ paseoHome, dataDir, host, port });
  if (child.pid == null) {
    throw new Error("Failed to spawn Chroma sidecar (no pid)");
  }

  try {
    await waitForHeartbeat(host, port, 20_000);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  const state: SidecarStateFile = {
    host,
    port,
    pid: child.pid,
    dataDir,
    startedAt: new Date().toISOString(),
  };
  writeState(paseoHome, state);
  return { host, port, dataDir, owned: true };
}

/**
 * Ensure a Chroma HTTP server is reachable for this Paseo home.
 * Reuses an existing healthy sidecar when possible.
 */
export async function ensureDocsChromaSidecar(
  paseoHome = resolvePaseoHomeForDocs(),
): Promise<DocsChromaEndpoint> {
  const override = await resolveOverrideEndpoint(paseoHome);
  if (override) return override;

  const existing = readState(paseoHome);
  if (existing) {
    const endpoint = await endpointFromHealthyState(existing, childrenByHome.has(paseoHome));
    if (endpoint) return endpoint;
  }

  const lockOrPeer = await waitForLockOrPeer(paseoHome);
  if (lockOrPeer !== "locked") return lockOrPeer;

  try {
    const again = readState(paseoHome);
    if (again) {
      const endpoint = await endpointFromHealthyState(again, false);
      if (endpoint) return endpoint;
    }
    return await startOwnedSidecar(paseoHome);
  } finally {
    releaseLock(paseoHome);
  }
}

export async function createDocsChromaClient(
  paseoHome = resolvePaseoHomeForDocs(),
): Promise<{ client: ChromaClient; endpoint: DocsChromaEndpoint }> {
  const endpoint = await ensureDocsChromaSidecar(paseoHome);
  const client = new ChromaClient({
    host: endpoint.host,
    port: endpoint.port,
    ssl: false,
  });
  return { client, endpoint };
}

/** Best-effort stop for tests / teardown. Does not delete chroma data. */
export async function stopDocsChromaSidecar(paseoHome = resolvePaseoHomeForDocs()): Promise<void> {
  const child = childrenByHome.get(paseoHome);
  if (child && !child.killed) {
    child.kill("SIGTERM");
    childrenByHome.delete(paseoHome);
  }
  const state = readState(paseoHome);
  if (state && processAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  try {
    unlinkSync(statePath(paseoHome));
  } catch {
    // ignore
  }
  releaseLock(paseoHome);
  // Give the process a moment to release the port.
  await sleep(50);
}
