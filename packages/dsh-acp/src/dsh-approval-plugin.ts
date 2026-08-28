import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { Duplex } from "node:stream";

export const name = "dsh-acp-approval";
export const inject = ["approval", "tools"];

type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable";

interface ApprovalRequest {
  readonly agent: { session: { id: string } };
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

interface ApprovalContext {
  on(
    event: "approval/request",
    listener: (
      request: ApprovalRequest,
      next: () => Promise<ApprovalOutcome>,
    ) => Promise<ApprovalOutcome>,
  ): () => void;
  on(
    event: "agent/request",
    listener: (
      payload: unknown,
      next: () => Promise<Record<string, unknown>>,
    ) => Promise<Record<string, unknown>>,
  ): () => void;
  on(
    event: "tools/pre-execute",
    listener: (
      execution: { name: string },
      next: () => Promise<{ kind: string; reason?: string }>,
    ) => Promise<{ kind: string; reason?: string }>,
  ): () => void;
}

interface ApprovalResponse {
  id: string;
  outcome: ApprovalOutcome;
}

export function apply(ctx: ApprovalContext): void {
  const channel = new ApprovalChannel(3);
  channel.ready();
  ctx.on("approval/request", async (request) => channel.request(request));
  ctx.on("agent/request", async (_payload, next) => {
    const request = await next();
    const reasoningEffort = process.env.DSH_ACP_REASONING_EFFORT?.trim();
    if (!reasoningEffort) {
      return request;
    }
    return { ...request, reasoningEffort };
  });
  ctx.on("tools/pre-execute", async (execution, next) => {
    const mode = process.env.DSH_ACP_PERMISSION_MODE ?? "ask";
    if (mode === "full-access") {
      return next();
    }
    if (mode === "read-only") {
      return isReadOnlyTool(execution.name)
        ? next()
        : { kind: "deny", reason: `tool "${execution.name}" is blocked in read-only mode` };
    }
    return { kind: "ask", reason: `Allow DSH to run ${execution.name}?` };
  });
}

function isReadOnlyTool(toolName: string): boolean {
  return ["read", "search", "grep", "glob", "find", "list", "get"].some((part) =>
    toolName.toLowerCase().includes(part),
  );
}

export class ApprovalChannel {
  private readonly stream: Duplex;
  private readonly pending = new Map<string, (outcome: ApprovalOutcome) => void>();
  private buffer = "";

  constructor(streamOrFd: Duplex | number) {
    this.stream =
      typeof streamOrFd === "number"
        ? new Socket({ fd: streamOrFd, readable: true, writable: true })
        : streamOrFd;
    this.stream.on("data", (chunk: Buffer) => {
      this.consume(chunk.toString());
    });
    this.stream.on("close", () => this.resolveAll("unavailable"));
    this.stream.on("error", () => this.resolveAll("unavailable"));
  }

  request(request: ApprovalRequest): Promise<ApprovalOutcome> {
    if (request.signal?.aborted) {
      return Promise.resolve("cancelled");
    }
    const id = randomUUID();
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      this.pending.set(id, resolve);
    });
    this.stream.write(
      `${JSON.stringify({
        id,
        type: "approval/request",
        sessionId: String(request.agent.session.id),
        toolName: request.toolName,
        ...(request.callId ? { callId: String(request.callId) } : {}),
        ...(request.reason ? { reason: request.reason } : {}),
      })}\n`,
    );
    if (!request.signal) {
      return outcome;
    }
    return Promise.race([
      outcome,
      new Promise<ApprovalOutcome>((resolve) => {
        request.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
      }),
    ]).finally(() => this.pending.delete(id));
  }

  ready(): void {
    this.stream.write(`${JSON.stringify({ type: "approval/ready" })}\n`);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
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
    if (!isApprovalResponse(value)) {
      return;
    }
    const resolve = this.pending.get(value.id);
    if (!resolve) {
      return;
    }
    this.pending.delete(value.id);
    resolve(value.outcome);
  }

  private resolveAll(outcome: ApprovalOutcome): void {
    for (const resolve of this.pending.values()) {
      resolve(outcome);
    }
    this.pending.clear();
  }
}

function isApprovalResponse(value: unknown): value is ApprovalResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const response = value as Partial<ApprovalResponse>;
  return (
    typeof response.id === "string" &&
    ["allowed-once", "rejected", "cancelled", "unavailable"].includes(response.outcome ?? "")
  );
}
