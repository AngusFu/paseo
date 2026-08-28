import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dump, load } from "js-yaml";
import type { McpServer } from "@agentclientprotocol/sdk";

import { toDshMcpCordisEntries } from "./mcp.js";
import { readDshModelCatalog } from "./models.js";
import { resolveDshToolchain } from "./toolchain.js";

const REQUEST_TIMEOUT_MS = 30_000;
const APPROVAL_READY_TIMEOUT_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 1_000;
const EXIT_TIMEOUT_MS = 2_000;

export interface DshNotification {
  method: string;
  params?: unknown;
}

export type DshApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

export interface DshApprovalRequest {
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  respond(outcome: DshApprovalOutcome): void;
}

export interface DshRuntimeStart {
  cwd: string;
  runtimeBin?: string;
  provider: string;
  model: string;
  reasoningEffort?: string;
  permissionMode: "ask" | "read-only" | "full-access";
  mcpServers: McpServer[];
  cordis?: string;
  dshHome: string;
  sessionRoot: string;
  maxTokens?: number;
}

export interface DshRuntimeSession {
  onNotification(callback: (notification: DshNotification) => void): () => void;
  onApprovalRequest(callback: (request: DshApprovalRequest) => void): () => void;
  onExit(callback: (error: Error) => void): () => void;
  prompt(sessionId: string, text: string): Promise<string>;
  resume(sessionId: string): Promise<void>;
  listModels(): Promise<DshRuntimeModel[]>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

export interface DshRuntimeModel {
  provider: string;
  id: string;
  name: string;
  description?: string;
  reasoningEfforts?: Array<{ id: string; name: string; description?: string }>;
  defaultReasoningEffort?: string;
}

export interface DshRuntime {
  start(input: DshRuntimeStart): Promise<DshRuntimeSession>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class DshCliRuntime implements DshRuntime {
  async start(input: DshRuntimeStart): Promise<DshRuntimeSession> {
    const toolchain = resolveDshToolchain({
      dshHome: input.dshHome,
      ...(input.runtimeBin ? { runtimeBin: input.runtimeBin } : {}),
      ...(input.cordis ? { cordis: input.cordis } : {}),
    });
    if (!toolchain) {
      throw new Error(
        "DeepSeek Harness runtime was not found. Run `dsh-acp setup` or pass --runtime-bin and --cordis",
      );
    }

    const cordis = materializeDshAcpCordis(toolchain.cordisPath, input.dshHome, input.mcpServers);
    const env = {
      ...buildRuntimeEnv(input, cordis.path),
      DSH_ACP_PERMISSION_MODE: input.permissionMode,
      ...(input.reasoningEffort ? { DSH_ACP_REASONING_EFFORT: input.reasoningEffort } : {}),
    };
    const child = spawn(toolchain.runtimeBin, [], {
      cwd: input.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    assertRuntimeChild(child);
    const approvalStream = child.stdio[3];
    if (!approvalStream || !("write" in approvalStream)) {
      await terminateSpawnedChild(child);
      cordis.cleanup();
      throw new Error("dsh-jsonrpc-agent did not open the approval channel on fd 3");
    }
    const transport = new DshJsonRpcTransport(child, approvalStream, cordis.cleanup);
    try {
      await transport.waitForApprovalReady();
      await transport.request("initialize", {
        cwd: input.cwd,
        provider: input.provider,
        model: input.model,
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      });
      return transport;
    } catch (error) {
      await transport.kill();
      throw error;
    }
  }
}

class DshJsonRpcTransport implements DshRuntimeSession {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationSubscribers = new Set<(notification: DshNotification) => void>();
  private readonly exitSubscribers = new Set<(error: Error) => void>();
  private readonly approvalSubscribers = new Set<(request: DshApprovalRequest) => void>();
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private requestSequence = 0;
  private closed = false;
  private approvalReadyResolve: (() => void) | null = null;
  private readonly approvalReady = new Promise<void>((resolve) => {
    this.approvalReadyResolve = resolve;
  });

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly approvalStream: Duplex,
    private readonly cleanup: () => void,
  ) {
    child.stdout.on("data", (chunk: Buffer) => {
      this.consumeStdout(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk.toString()}`.slice(-8192);
    });
    child.on("error", (error) => {
      this.handleExit(error);
    });
    child.on("exit", (code, signal) => {
      this.handleExit(
        new Error(
          `dsh-jsonrpc-agent exited with code ${code ?? "null"} and signal ${signal ?? "null"}${this.stderrBuffer ? `\n${this.stderrBuffer}` : ""}`,
        ),
      );
    });
    let approvalBuffer = "";
    approvalStream.on("data", (chunk: Buffer) => {
      approvalBuffer += chunk.toString();
      for (;;) {
        const newline = approvalBuffer.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = approvalBuffer.slice(0, newline).trim();
        approvalBuffer = approvalBuffer.slice(newline + 1);
        if (line) {
          this.handleApprovalLine(line);
        }
      }
    });
  }

  onNotification(callback: (notification: DshNotification) => void): () => void {
    this.notificationSubscribers.add(callback);
    return () => this.notificationSubscribers.delete(callback);
  }

  onExit(callback: (error: Error) => void): () => void {
    this.exitSubscribers.add(callback);
    return () => this.exitSubscribers.delete(callback);
  }

  onApprovalRequest(callback: (request: DshApprovalRequest) => void): () => void {
    this.approvalSubscribers.add(callback);
    return () => this.approvalSubscribers.delete(callback);
  }

  async waitForApprovalReady(): Promise<void> {
    await Promise.race([
      this.approvalReady,
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("DSH approval bridge did not become ready")),
          APPROVAL_READY_TIMEOUT_MS,
        );
      }),
    ]);
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    const result = await this.request("session/prompt", {
      sessionId,
      contentBlocks: [{ type: "text", text }],
    });
    const record = asRecord(result);
    if (typeof record?.messageId !== "string" || record.messageId.length === 0) {
      throw new Error("DSH session/prompt did not return a messageId");
    }
    return record.messageId;
  }

  async resume(sessionId: string): Promise<void> {
    await this.request("session/resume", { sessionId });
  }

  async listModels(): Promise<DshRuntimeModel[]> {
    const result = asRecord(await this.request("catalog/list"));
    if (!Array.isArray(result?.models)) {
      throw new Error("DSH catalog/list returned an invalid model list");
    }
    return result.models.map(parseRuntimeModel);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      await this.request("shutdown", undefined, SHUTDOWN_TIMEOUT_MS);
    } catch {
      // The runtime may exit before acknowledging shutdown.
    }
    await this.terminate("SIGTERM");
  }

  async kill(): Promise<void> {
    await this.terminate("SIGKILL");
  }

  async request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closed) {
      throw new Error("dsh-jsonrpc-agent is closed");
    }
    const id = `dsh-acp-${(this.requestSequence += 1)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`dsh-jsonrpc-agent request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const message = asRecord(value);
    if (!message) {
      return;
    }
    if (typeof message.method === "string" && message.id === undefined) {
      for (const subscriber of this.notificationSubscribers) {
        subscriber({ method: message.method, params: message.params });
      }
      return;
    }
    const id = typeof message.id === "string" ? message.id : null;
    const pending = id ? this.pending.get(id) : undefined;
    if (!id || !pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(new Error(`dsh-jsonrpc-agent error: ${formatRpcError(message.error)}`));
      return;
    }
    pending.resolve(message.result);
  }

  private async terminate(signal: NodeJS.Signals): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.child.stdin.end();
    signalProcessTree(this.child, signal);
    if (!(await waitForExit(this.child, EXIT_TIMEOUT_MS)) && signal !== "SIGKILL") {
      signalProcessTree(this.child, "SIGKILL");
      await waitForExit(this.child, EXIT_TIMEOUT_MS);
    }
    this.failPending(new Error("dsh-jsonrpc-agent is closed"));
    this.cleanup();
  }

  private handleExit(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failPending(error);
    this.cleanup();
    for (const subscriber of this.exitSubscribers) {
      subscriber(error);
    }
  }

  private failPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private handleApprovalLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = asRecord(parsed);
    if (message?.type === "approval/ready") {
      this.approvalReadyResolve?.();
      this.approvalReadyResolve = null;
      return;
    }
    if (
      typeof message?.id !== "string" ||
      message.type !== "approval/request" ||
      typeof message.sessionId !== "string" ||
      typeof message.toolName !== "string"
    ) {
      return;
    }
    const respond = (outcome: DshApprovalOutcome): void => {
      if (!this.closed) {
        this.approvalStream.write(`${JSON.stringify({ id: message.id, outcome })}\n`);
      }
    };
    const request: DshApprovalRequest = {
      sessionId: message.sessionId,
      toolName: message.toolName,
      ...(typeof message.callId === "string" ? { callId: message.callId } : {}),
      ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
      respond,
    };
    if (this.approvalSubscribers.size === 0) {
      respond("unavailable");
      return;
    }
    for (const subscriber of this.approvalSubscribers) {
      subscriber(request);
    }
  }
}

function materializeDshAcpCordis(
  baseCordisPath: string,
  dshHome: string,
  mcpServers: McpServer[],
): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-acp-cordis-"));
  const path = join(dir, "cordis.yml");
  const pluginPath = fileURLToPath(new URL("./dsh-approval-plugin.js", import.meta.url));
  const serverPluginPath = fileURLToPath(
    new URL("./dsh-runtime-server-plugin.js", import.meta.url),
  );
  const base = replaceSdkServerPlugin(
    readFileSync(baseCordisPath, "utf8").trimEnd(),
    serverPluginPath,
  );
  const approvalService = base.includes("@deepseek-ai/dsh-user-approval")
    ? ""
    : '\n- id: dsh-acp-approval-service\n  name: "@deepseek-ai/dsh-user-approval"\n  config:\n    policy: ask\n';
  const catalog = readDshModelCatalog(dshHome);
  const pluginEntries = catalog.pluginEntries.map((plugin) => ({
    id: plugin.id,
    name: pathToFileURL(plugin.entryPath).href,
  }));
  if (Object.keys(catalog.llmPiAiProviders).length > 0) {
    pluginEntries.push({
      id: "llm-pi-ai",
      name: "@deepseek-ai/dsh-llm-pi-ai",
      config: { providers: catalog.llmPiAiProviders },
    } as { id: string; name: string; config: Record<string, unknown> });
  }
  pluginEntries.push(...toDshMcpCordisEntries(mcpServers));
  const modelEntries = pluginEntries.length > 0 ? `\n${dump(pluginEntries).trimEnd()}\n` : "";
  const approvalEntry = `${approvalService}\n- id: dsh-acp-approval\n  name: ${JSON.stringify(pluginPath)}\n`;
  writeFileSync(path, `${base}${modelEntries}${approvalEntry}`, { encoding: "utf8", mode: 0o600 });
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function replaceSdkServerPlugin(base: string, pluginPath: string): string {
  const official = /name:\s*['"]@deepseek-ai\/dsh-sdk-jsonrpc-server['"]/;
  if (!official.test(base)) {
    throw new Error("DSH base Cordis does not contain the SDK JSON-RPC server entry");
  }
  return base.replace(official, `name: ${JSON.stringify(pluginPath)}`);
}

function assertRuntimeChild(
  child: ChildProcess,
): asserts child is ChildProcessWithoutNullStreams & { stdio: [Duplex, Duplex, Duplex, Duplex] } {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("dsh-jsonrpc-agent was spawned without standard streams");
  }
}

async function terminateSpawnedChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  signalProcessTree(child, "SIGKILL");
  await waitForExit(child, EXIT_TIMEOUT_MS);
}

function buildRuntimeEnv(input: DshRuntimeStart, cordis: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: input.dshHome,
    DSH_CWD: input.cwd,
    DSH_SESSION_ROOT: input.sessionRoot,
    DSH_CORDIS_CONFIG: cordis,
  };
  const credentials = loadCredentialRefs(input.dshHome);
  for (const [name, value] of Object.entries(credentials)) {
    env[name] ??= value;
  }
  const nodePaths = resolveNodePaths(input.dshHome);
  if (nodePaths.length > 0) {
    env.NODE_PATH = [...nodePaths, ...(env.NODE_PATH ? [env.NODE_PATH] : [])].join(
      process.platform === "win32" ? ";" : ":",
    );
  }
  return env;
}

function loadCredentialRefs(dshHome: string): Record<string, string> {
  const path = join(dshHome, ".credentials.yaml");
  if (!existsSync(path)) {
    return {};
  }
  const parsed = asRecord(load(readFileSync(path, "utf8")));
  const refs = asRecord(parsed?.refs);
  if (!refs) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(refs)) {
    if (typeof value === "string" && value.trim()) {
      result[name] = value.trim();
    }
  }
  return result;
}

function resolveNodePaths(dshHome: string): string[] {
  const paths = [
    join(dshHome, "profiles", "web", "node_modules"),
    join(dshHome, "paseo", "node_modules"),
    resolvePackageNodeModules(),
  ];
  const configured = process.env.DSH_PLUGIN_NODE_MODULES?.trim();
  if (configured) {
    paths.push(configured);
  }
  return paths.filter((path) => existsSync(path));
}

function resolvePackageNodeModules(): string {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("@deepseek-ai/dsh-user-approval/package.json");
  return join(packageJson, "..", "..", "..");
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    child.kill(signal);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return Promise.race([
    new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function formatRpcError(value: unknown): string {
  const record = asRecord(value);
  return typeof record?.message === "string" ? record.message : JSON.stringify(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRuntimeModel(value: unknown): DshRuntimeModel {
  const model = asRecord(value);
  if (
    typeof model?.provider !== "string" ||
    typeof model.id !== "string" ||
    typeof model.name !== "string"
  ) {
    throw new Error("DSH catalog/list returned an invalid model");
  }
  const efforts = Array.isArray(model.reasoningEfforts)
    ? model.reasoningEfforts.map((rawEffort) => {
        const effort = asRecord(rawEffort);
        if (typeof effort?.id !== "string" || typeof effort.name !== "string") {
          throw new Error("DSH catalog/list returned an invalid reasoning effort");
        }
        return {
          id: effort.id,
          name: effort.name,
          ...(typeof effort.description === "string" ? { description: effort.description } : {}),
        };
      })
    : undefined;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    ...(typeof model.description === "string" ? { description: model.description } : {}),
    ...(efforts ? { reasoningEfforts: efforts } : {}),
    ...(typeof model.defaultReasoningEffort === "string"
      ? { defaultReasoningEffort: model.defaultReasoningEffort }
      : {}),
  };
}
