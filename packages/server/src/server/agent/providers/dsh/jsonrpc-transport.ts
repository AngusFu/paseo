import { randomUUID } from "node:crypto";
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

import { spawnProcess } from "../../../../utils/spawn.js";
import { terminateWithTreeKill } from "../../../../utils/tree-kill.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_BUFFER_LIMIT = 8192;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 1_000;

export interface JsonRpcLaunch {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

export interface JsonRpcExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error;
}

export interface JsonRpcTransportOptions {
  launch: JsonRpcLaunch;
  logger: Logger;
  diagnosticName?: string;
  spawn?: (launch: JsonRpcLaunch) => ChildProcessWithoutNullStreams;
}

function assertChildWithPipes(
  child: ChildProcess,
): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("JSON-RPC process was spawned without stdio streams");
  }
}

function spawnJsonRpcProcess(launch: JsonRpcLaunch): ChildProcessWithoutNullStreams {
  const child = spawnProcess(launch.command, launch.args, {
    cwd: launch.cwd,
    envOverlay: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  assertChildWithPipes(child);
  return child;
}

export class JsonRpcLineTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly diagnosticName: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationSubscribers = new Set<(notification: JsonRpcNotification) => void>();
  private readonly exitSubscribers = new Set<(exit: JsonRpcExit) => void>();
  private stderrBuffer = "";
  private stdoutBuffer = "";
  private disposed = false;

  constructor(private readonly options: JsonRpcTransportOptions) {
    this.diagnosticName = options.diagnosticName ?? "JSON-RPC";
    this.child = (options.spawn ?? spawnJsonRpcProcess)(options.launch);
    this.child.stdout.on("data", (chunk) => {
      this.handleStdoutChunk(chunk.toString());
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
      }
    });
    this.child.on("error", (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(
        `${this.diagnosticName} process exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderrBuffer}`.trim(),
      );
      const exit = { code, signal, error };
      for (const subscriber of this.exitSubscribers) {
        subscriber(exit);
      }
      this.failAll(error);
    });
  }

  onNotification(callback: (notification: JsonRpcNotification) => void): () => void {
    this.notificationSubscribers.add(callback);
    return () => {
      this.notificationSubscribers.delete(callback);
    };
  }

  onExit(callback: (exit: JsonRpcExit) => void): () => void {
    this.exitSubscribers.add(callback);
    return () => {
      this.exitSubscribers.delete(callback);
    };
  }

  request(
    method: string,
    params?: Record<string, unknown> | null,
    timeoutMs: number | null = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error(`${this.diagnosticName} process is closed`));
    }
    const id = `req_${randomUUID().replaceAll("-", "")}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(
                new Error(
                  `${this.diagnosticName} request timed out for ${method}\n${this.stderrBuffer}`.trim(),
                ),
              );
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const message: Record<string, unknown> = {
        jsonrpc: "2.0",
        id,
        method,
      };
      if (params !== undefined && params !== null) {
        message.params = params;
      }
      this.write(message);
    });
  }

  async shutdown(): Promise<void> {
    try {
      await this.request("shutdown", null, SHUTDOWN_REQUEST_TIMEOUT_MS);
    } catch {
      // Process may already be dead; kill below.
    }
  }

  async close(error = new Error(`${this.diagnosticName} process is closed`)): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.failAll(error);
    try {
      await this.shutdown();
    } catch {
      // Ignore shutdown races.
    }
    try {
      this.child.stdin.end();
    } catch {
      // Ignore cleanup races.
    }
    const result = await terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.options.logger.warn(
          { timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          `${this.diagnosticName} process did not exit after SIGTERM; sending SIGKILL`,
        );
      },
    });
    if (result === "kill-timeout") {
      this.options.logger.warn(
        { timeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS },
        `${this.diagnosticName} process did not report exit after SIGKILL`,
      );
    }
  }

  async kill(error = new Error(`${this.diagnosticName} process killed`)): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.failAll(error);
    try {
      this.child.stdin.end();
    } catch {
      // Ignore.
    }
    await terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: 0,
      forceTimeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS,
      gracefulSignal: "SIGKILL",
    });
  }

  private write(message: Record<string, unknown>): void {
    if (this.disposed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.trim()) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const message = parsed as Record<string, unknown>;
    const hasId = message.id !== undefined && message.id !== null;
    const hasMethod = typeof message.method === "string";

    if (hasId && !hasMethod) {
      this.handleResponse(message);
      return;
    }
    if (hasMethod && !hasId) {
      const notification: JsonRpcNotification = {
        method: message.method as string,
        params: message.params,
      };
      for (const subscriber of this.notificationSubscribers) {
        subscriber(notification);
      }
    }
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id =
      typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : null;
    if (!id) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    if (message.error !== undefined) {
      const errorValue = message.error;
      const errorMessage =
        errorValue && typeof errorValue === "object" && !Array.isArray(errorValue)
          ? String((errorValue as { message?: unknown }).message ?? JSON.stringify(errorValue))
          : String(errorValue);
      pending.reject(new Error(`${this.diagnosticName} error: ${errorMessage}`));
      return;
    }
    pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}
