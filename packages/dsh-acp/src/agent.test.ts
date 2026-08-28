import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, test } from "vitest";

import { DshAcpAgent, type SessionUpdateSink } from "./agent.js";
import type {
  DshApprovalRequest,
  DshNotification,
  DshRuntime,
  DshRuntimeSession,
  DshRuntimeStart,
} from "./runtime.js";
import type { DshWorkspaceRegistry } from "./workspace.js";

class FakeSink implements SessionUpdateSink {
  readonly updates: SessionNotification[] = [];
  readonly permissions: Array<{ sessionId: string; toolCallId: string; title: string }> = [];
  permissionOutcome: "allow-once" | "reject-once" | "cancelled" = "allow-once";

  async sessionUpdate(notification: SessionNotification): Promise<void> {
    this.updates.push(notification);
  }

  async requestPermission(params: Parameters<SessionUpdateSink["requestPermission"]>[0]) {
    this.permissions.push({
      sessionId: params.sessionId,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title,
    });
    if (this.permissionOutcome === "cancelled") {
      return { outcome: { outcome: "cancelled" as const } };
    }
    return { outcome: { outcome: "selected" as const, optionId: this.permissionOutcome } };
  }
}

class FakeSession implements DshRuntimeSession {
  private readonly notificationSubscribers = new Set<(notification: DshNotification) => void>();
  private readonly approvalSubscribers = new Set<(request: DshApprovalRequest) => void>();
  private readonly exitSubscribers = new Set<(error: Error) => void>();
  readonly prompts: Array<{ sessionId: string; text: string }> = [];
  readonly resumes: string[] = [];
  runtimeModels: import("./runtime.js").DshRuntimeModel[] = [];
  killed = false;
  closed = false;

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

  async prompt(sessionId: string, text: string): Promise<string> {
    this.prompts.push({ sessionId, text });
    return `message-${this.prompts.length}`;
  }

  async resume(sessionId: string): Promise<void> {
    this.resumes.push(sessionId);
  }

  async listModels(): Promise<import("./runtime.js").DshRuntimeModel[]> {
    return this.runtimeModels;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async kill(): Promise<void> {
    this.killed = true;
  }

  emit(notification: DshNotification): void {
    for (const subscriber of this.notificationSubscribers) {
      subscriber(notification);
    }
  }

  requestApproval(input: Omit<DshApprovalRequest, "respond">): Promise<string> {
    return new Promise((resolve) => {
      for (const subscriber of this.approvalSubscribers) {
        subscriber({ ...input, respond: resolve });
      }
    });
  }
}

class FakeRuntime implements DshRuntime {
  readonly starts: DshRuntimeStart[] = [];
  readonly sessions: FakeSession[] = [];

  async start(input: DshRuntimeStart): Promise<DshRuntimeSession> {
    this.starts.push(input);
    const session = new FakeSession();
    this.sessions.push(session);
    return session;
  }
}

class FakeWorkspaceRegistry implements DshWorkspaceRegistry {
  readonly ensured: string[] = [];
  readonly attachments: Array<{ cwd: string; sessionId: string }> = [];

  async ensure(cwd: string): Promise<void> {
    this.ensured.push(cwd);
  }

  async attach(input: { cwd: string; sessionId: string }): Promise<void> {
    this.attachments.push(input);
  }
}

function createAgent(): {
  agent: DshAcpAgent;
  runtime: FakeRuntime;
  sink: FakeSink;
  workspaceRegistry: FakeWorkspaceRegistry;
} {
  const runtime = new FakeRuntime();
  const sink = new FakeSink();
  const workspaceRegistry = new FakeWorkspaceRegistry();
  return {
    agent: new DshAcpAgent({
      connection: sink,
      runtime,
      workspaceRegistry,
      config: {
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        runtimeBin: "dsh-jsonrpc-agent",
        cordis: "/tmp/cordis.yml",
        dshHome: "/tmp/.dsh",
        sessionRoot: "/tmp/.dsh/sessions",
      },
    }),
    runtime,
    sink,
    workspaceRegistry,
  };
}

describe("DshAcpAgent", () => {
  test("streams a DSH text, reasoning, and tool turn over ACP", async () => {
    const { agent, runtime, sink } = createAgent();
    const created = await agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
    const fake = runtime.sessions[0];
    if (!fake) {
      throw new Error("Expected a runtime session");
    }

    const prompt = agent.prompt({
      sessionId: created.sessionId,
      messageId: "6b33b75a-54e4-46cf-a0d8-5b6070503ff6",
      prompt: [{ type: "text", text: "Say hi" }],
    });
    await Promise.resolve();
    expect(fake.prompts).toEqual([{ sessionId: created.sessionId, text: "Say hi" }]);

    fake.emit(inbox(created.sessionId, "message-1"));
    fake.emit(
      event(created.sessionId, "assistant/chunk", { chunk: { type: "text-delta", text: "Hi" } }),
    );
    fake.emit(
      event(created.sessionId, "assistant/chunk", {
        chunk: { type: "reasoning-delta", text: "Checking" },
      }),
    );
    fake.emit(
      event(created.sessionId, "tool/call", {
        callId: "call-1",
        name: "bash",
        arguments: JSON.stringify({ command: "echo hi" }),
      }),
    );
    fake.emit(
      event(created.sessionId, "tool/result", {
        message: {
          source: { callId: "call-1" },
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              content: [{ type: "text", text: "hi\n" }],
            },
          ],
        },
      }),
    );
    fake.emit(status(created.sessionId, "idle"));

    await expect(prompt).resolves.toEqual({
      stopReason: "end_turn",
      userMessageId: "6b33b75a-54e4-46cf-a0d8-5b6070503ff6",
    });
    expect(sink.updates.map((notification) => notification.update.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
    ]);
    expect(sink.updates[0]?.update).toMatchObject({ messageId: expect.any(String) });
    expect(sink.updates[2]?.update).toMatchObject({
      toolCallId: "call-1",
      kind: "execute",
      rawInput: { command: "echo hi" },
    });
    expect(sink.updates[3]?.update).toMatchObject({
      toolCallId: "call-1",
      status: "completed",
      rawOutput: "hi\n",
    });
    await agent.close();
  });

  test("completes when idle arrives before the inbox receipt", async () => {
    const { agent, runtime } = createAgent();
    const created = await agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
    const fake = runtime.sessions[0];
    if (!fake) {
      throw new Error("Expected a runtime session");
    }
    const prompt = agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Race" }],
    });
    await Promise.resolve();
    fake.emit(status(created.sessionId, "idle"));
    fake.emit(inbox(created.sessionId, "message-1"));
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    await agent.close();
  });

  test("restarts the DSH runtime after cancellation and accepts another turn", async () => {
    const { agent, runtime } = createAgent();
    const created = await agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
    const first = runtime.sessions[0];
    if (!first) {
      throw new Error("Expected a runtime session");
    }
    const cancelled = agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Long turn" }],
    });
    await Promise.resolve();
    await agent.cancel({ sessionId: created.sessionId });
    await expect(cancelled).resolves.toEqual({ stopReason: "cancelled" });
    expect(first.killed).toBe(true);
    expect(runtime.sessions).toHaveLength(2);

    const second = runtime.sessions[1];
    if (!second) {
      throw new Error("Expected a replacement runtime session");
    }
    const next = agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Next turn" }],
    });
    await Promise.resolve();
    second.emit(inbox(created.sessionId, "message-1"));
    second.emit(status(created.sessionId, "idle"));
    await expect(next).resolves.toEqual({ stopReason: "end_turn" });
    await agent.close();
  });

  test("maps DSH approval requests to ACP permission responses", async () => {
    const { agent, runtime, sink } = createAgent();
    const created = await agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
    const fake = runtime.sessions[0];
    if (!fake) {
      throw new Error("Expected a runtime session");
    }

    const outcome = fake.requestApproval({
      sessionId: created.sessionId,
      toolName: "bash",
      callId: "call-approval",
      reason: "Needs access outside the workspace",
    });

    await expect(outcome).resolves.toBe("allowed-once");
    expect(sink.permissions).toEqual([
      {
        sessionId: created.sessionId,
        toolCallId: "call-approval",
        title: "Needs access outside the workspace",
      },
    ]);
    await agent.close();
  });

  test("passes session MCP servers through every runtime restart", async () => {
    const { agent, runtime } = createAgent();
    const mcpServer = {
      type: "http" as const,
      name: "paseo",
      url: "http://127.0.0.1:6767/mcp/agents",
      headers: [{ name: "Authorization", value: "Bearer token" }],
    };
    const created = await agent.newSession({ cwd: "/tmp/project", mcpServers: [mcpServer] });
    await agent.setSessionMode({ sessionId: created.sessionId, modeId: "full-access" });

    expect(runtime.starts).toHaveLength(2);
    expect(runtime.starts[0]?.mcpServers).toEqual([mcpServer]);
    expect(runtime.starts[1]?.mcpServers).toEqual([mcpServer]);
    await agent.close();
  });

  test("resumes the same native DSH session id in a fresh ACP process", async () => {
    const first = createAgent();
    const created = await first.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
    await first.agent.close();

    const second = createAgent();
    const resumed = await second.agent.unstable_resumeSession({
      sessionId: created.sessionId,
      cwd: "/tmp/project",
      mcpServers: [],
    });
    expect(resumed.models?.currentModelId).toBe("deepseek-v4-flash");
    expect(resumed.modes?.currentModeId).toBe("ask");

    const runtimeSession = second.runtime.sessions[0];
    if (!runtimeSession) {
      throw new Error("Expected resumed runtime session");
    }
    expect(runtimeSession.resumes).toEqual([created.sessionId]);
    const prompt = second.agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "Continue" }],
    });
    await Promise.resolve();
    expect(runtimeSession.prompts).toEqual([{ sessionId: created.sessionId, text: "Continue" }]);
    runtimeSession.emit(inbox(created.sessionId, "message-1"));
    runtimeSession.emit(status(created.sessionId, "idle"));
    await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
    await second.agent.close();
  });

  test("attaches new and resumed sessions to their DSH workspace", async () => {
    const created = createAgent();
    const session = await created.agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
    expect(created.workspaceRegistry.ensured).toEqual(["/tmp/project"]);
    expect(created.workspaceRegistry.attachments).toEqual([]);
    const runtimeSession = created.runtime.sessions[0];
    if (!runtimeSession) {
      throw new Error("Expected runtime session");
    }
    const prompt = created.agent.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "Materialize" }],
    });
    await Promise.resolve();
    runtimeSession.emit(inbox(session.sessionId, "message-1"));
    runtimeSession.emit(status(session.sessionId, "idle"));
    await prompt;
    expect(created.workspaceRegistry.attachments).toEqual([
      { cwd: "/tmp/project", sessionId: session.sessionId },
    ]);
    await created.agent.close();

    const resumed = createAgent();
    await resumed.agent.unstable_resumeSession({
      cwd: "/tmp/project",
      sessionId: session.sessionId,
      mcpServers: [],
    });
    expect(resumed.workspaceRegistry.attachments).toEqual([
      { cwd: "/tmp/project", sessionId: session.sessionId },
    ]);
    await resumed.agent.close();
  });

  test("merges models discovered from generic DSH runtime providers", async () => {
    const runtime = new FakeRuntime();
    const originalStart = runtime.start.bind(runtime);
    runtime.start = async (input) => {
      const session = (await originalStart(input)) as FakeSession;
      session.runtimeModels = [
        {
          provider: "provider-from-plugin",
          id: "dynamic-model",
          name: "Dynamic Model",
          reasoningEfforts: [{ id: "medium", name: "Medium" }],
        },
      ];
      return session;
    };
    const sink = new FakeSink();
    const agent = new DshAcpAgent({
      connection: sink,
      runtime,
      workspaceRegistry: new FakeWorkspaceRegistry(),
      config: {
        dshHome: "/tmp/.dsh",
        sessionRoot: "/tmp/.dsh/sessions",
        runtimeBin: "dsh-jsonrpc-agent",
        cordis: "/tmp/cordis.yml",
      },
    });

    const created = await agent.newSession({ cwd: "/tmp/project", mcpServers: [] });
    expect(created.models?.availableModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: "provider-from-plugin/dynamic-model",
          name: "Dynamic Model",
        }),
      ]),
    );
    await agent.close();
  });
});

function event(sessionId: string, type: string, data: unknown): DshNotification {
  return { method: "session.event", params: { sessionId, event: { type, data } } };
}

function inbox(sessionId: string, messageId: string): DshNotification {
  return event(sessionId, "agent/inbox/spliced", { inserted: [{ id: messageId }] });
}

function status(sessionId: string, value: string): DshNotification {
  return { method: "session.status", params: { sessionId, status: value } };
}
