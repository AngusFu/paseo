import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { DshAgentClient, DshAgentSession } from "./agent.js";
import type { JsonRpcNotification } from "./jsonrpc-transport.js";
import { readDshWorkspaceDocument } from "./dsh-workspace.js";
import type {
  DshContentBlock,
  DshInitializeParams,
  DshRuntime,
  DshRuntimeSession,
  DshStartSessionInput,
} from "./runtime.js";

class FakeDshSession implements DshRuntimeSession {
  readonly prompts: Array<{ sessionId: string; contentBlocks: DshContentBlock[] }> = [];
  readonly initializes: DshInitializeParams[] = [];
  private readonly notificationSubscribers = new Set<(n: JsonRpcNotification) => void>();
  private readonly exitSubscribers = new Set<(error: Error) => void>();
  private closed = false;
  private killed = false;
  nextMessageId = "msg_user_1";

  onNotification(callback: (notification: JsonRpcNotification) => void): () => void {
    this.notificationSubscribers.add(callback);
    return () => {
      this.notificationSubscribers.delete(callback);
    };
  }

  onExit(callback: (error: Error) => void): () => void {
    this.exitSubscribers.add(callback);
    return () => {
      this.exitSubscribers.delete(callback);
    };
  }

  async initialize(params: DshInitializeParams): Promise<void> {
    this.initializes.push(params);
  }

  async prompt(sessionId: string, contentBlocks: DshContentBlock[]): Promise<string> {
    this.prompts.push({ sessionId, contentBlocks });
    return this.nextMessageId;
  }

  emit(notification: JsonRpcNotification): void {
    for (const subscriber of this.notificationSubscribers) {
      subscriber(notification);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async kill(): Promise<void> {
    this.killed = true;
  }

  get wasClosed(): boolean {
    return this.closed;
  }

  get wasKilled(): boolean {
    return this.killed;
  }
}

class FakeDshRuntime implements DshRuntime {
  readonly launches: DshStartSessionInput[] = [];
  readonly sessions: FakeDshSession[] = [];

  async startSession(input: DshStartSessionInput): Promise<DshRuntimeSession> {
    this.launches.push(input);
    const session = new FakeDshSession();
    this.sessions.push(session);
    return session;
  }
}

class SessionEvents {
  private readonly events: AgentStreamEvent[] = [];
  private readonly waiters: Array<{
    predicate: (event: AgentStreamEvent) => boolean;
    resolve: (event: AgentStreamEvent) => void;
  }> = [];

  constructor(session: DshAgentSession) {
    session.subscribe((event) => {
      this.events.push(event);
      const remaining: typeof this.waiters = [];
      for (const waiter of this.waiters) {
        if (waiter.predicate(event)) {
          waiter.resolve(event);
        } else {
          remaining.push(waiter);
        }
      }
      this.waiters.length = 0;
      this.waiters.push(...remaining);
    });
  }

  all(): AgentStreamEvent[] {
    return [...this.events];
  }

  waitFor(predicate: (event: AgentStreamEvent) => boolean): Promise<AgentStreamEvent> {
    const existing = this.events.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      this.waiters.push({ predicate, resolve });
    });
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function seedDshPluginNodeModules(profileHome: string): string {
  const nodeModules = join(profileHome, "paseo", "node_modules");
  mkdirSync(join(nodeModules, "@deepseek-ai", "dsh-llm-pi-ai"), { recursive: true });
  mkdirSync(join(nodeModules, "@deepseek-ai", "dsh-credentials-local"), { recursive: true });
  return nodeModules;
}

function createClient(runtime = new FakeDshRuntime()): {
  client: DshAgentClient;
  runtime: FakeDshRuntime;
  profileHome: string;
  cordisPath: string;
  nodeModulesPath: string;
} {
  const profileHome = mkdtempSync(join(tmpdir(), "paseo-dsh-"));
  tempDirs.push(profileHome);
  const nodeModulesPath = seedDshPluginNodeModules(profileHome);
  const cordisDir = mkdtempSync(join(tmpdir(), "paseo-dsh-cordis-"));
  tempDirs.push(cordisDir);
  const cordisPath = join(cordisDir, "cordis.yml");
  writeFileSync(
    cordisPath,
    `- id: base
  name: base-plugin
`,
    "utf8",
  );
  const client = new DshAgentClient({
    logger: pino({ level: "silent" }),
    runtime,
    providerParams: { cordis: cordisPath, profileHome },
  });
  return { client, runtime, profileHome, cordisPath, nodeModulesPath };
}

describe("DshAgentClient", () => {
  test("creates a session, maps a text turn, and completes on idle", async () => {
    const { client, runtime, profileHome, nodeModulesPath } = createClient();
    const session = (await client.createSession({
      provider: "dsh",
      cwd: "/tmp/dsh-workspace",
      model: "deepseek-v4-flash",
    })) as DshAgentSession;
    const events = new SessionEvents(session);
    const fake = runtime.sessions[0];
    if (!fake) {
      throw new Error("expected fake session");
    }

    expect(runtime.launches[0]).toMatchObject({
      cwd: "/tmp/dsh-workspace",
      sessionRoot: join(profileHome, "sessions"),
      nodeModulesPaths: expect.arrayContaining([nodeModulesPath]),
    });
    expect(session.id).toMatch(/^session-[0-9a-f-]{36}$/);
    expect(runtime.launches[0]?.cordis).toEqual(expect.stringContaining("cordis.yml"));
    expect(fake.initializes).toEqual([
      {
        cwd: "/tmp/dsh-workspace",
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
      },
    ]);

    const wsDoc = readDshWorkspaceDocument({ profileHome });
    const wsRecord = Object.values(wsDoc.tables.workspaces).find(
      (w) => w.path === "/tmp/dsh-workspace",
    );
    expect(wsRecord?.sessionIds).toContain(session.id);

    const runPromise = session.run("hello from paseo");
    await events.waitFor(
      (event) => event.type === "timeline" && event.item.type === "user_message",
    );

    expect(fake.prompts).toEqual([
      {
        sessionId: session.id,
        contentBlocks: [{ type: "text", text: "hello from paseo" }],
      },
    ]);

    fake.emit({
      method: "session.event",
      params: {
        sessionId: session.id,
        event: {
          type: "agent/inbox/spliced",
          data: {
            inserted: [{ id: "msg_user_1", role: "user" }],
          },
        },
      },
    });
    fake.emit({
      method: "session.status",
      params: { sessionId: session.id, status: "running" },
    });
    fake.emit({
      method: "session.event",
      params: {
        sessionId: session.id,
        event: {
          type: "assistant/chunk",
          data: {
            chunk: { type: "text-delta", text: "hi" },
          },
        },
      },
    });
    fake.emit({
      method: "session.event",
      params: {
        sessionId: session.id,
        event: {
          type: "assistant/chunk",
          data: {
            chunk: { type: "text-delta", text: " there" },
          },
        },
      },
    });
    fake.emit({
      method: "session.event",
      params: {
        sessionId: session.id,
        event: {
          type: "tool/call",
          data: {
            callId: "call_1",
            name: "bash",
            arguments: JSON.stringify({ command: "echo hi" }),
          },
        },
      },
    });
    fake.emit({
      method: "session.event",
      params: {
        sessionId: session.id,
        event: {
          type: "tool/result",
          data: {
            message: {
              source: { kind: "tool", callId: "call_1" },
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call_1",
                  content: [{ type: "text", text: "hi\n" }],
                  isError: false,
                },
              ],
            },
          },
        },
      },
    });
    fake.emit({
      method: "session.status",
      params: { sessionId: session.id, status: "idle" },
    });

    const result = await runPromise;
    expect(result.finalText).toBe("hi there");
    expect(result.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "user_message",
          text: "hello from paseo",
          messageId: "msg_user_1",
        }),
        expect.objectContaining({ type: "assistant_message", text: "hi" }),
        expect.objectContaining({ type: "assistant_message", text: " there" }),
        expect.objectContaining({
          type: "tool_call",
          callId: "call_1",
          name: "bash",
          status: "running",
          detail: { type: "shell", command: "echo hi" },
        }),
        expect.objectContaining({
          type: "tool_call",
          callId: "call_1",
          name: "bash",
          status: "completed",
          detail: { type: "shell", command: "echo hi", output: "hi\n" },
        }),
      ]),
    );

    await session.close();
    expect(fake.wasClosed).toBe(true);
  });

  test("interrupt kills the runtime process", async () => {
    const { client, runtime } = createClient();
    const session = (await client.createSession({
      provider: "dsh",
      cwd: "/tmp/dsh-workspace",
    })) as DshAgentSession;
    const events = new SessionEvents(session);
    const fake = runtime.sessions[0];
    if (!fake) {
      throw new Error("expected fake session");
    }

    const runPromise = session.run("long turn");
    await events.waitFor(
      (event) => event.type === "timeline" && event.item.type === "user_message",
    );
    await session.interrupt();

    const result = await runPromise;
    expect(result.finalText).toBe("");
    expect(fake.wasKilled).toBe(true);
    expect(events.all().some((event) => event.type === "turn_canceled")).toBe(true);

    await session.close();
  });

  test("enables MCP capability and materializes cordis when mcpServers are present", async () => {
    const { client, runtime } = createClient();
    const session = (await client.createSession({
      provider: "dsh",
      cwd: "/tmp/dsh-workspace",
      mcpServers: {
        paseo: {
          type: "stdio",
          command: "paseo-mcp",
        },
      },
    })) as DshAgentSession;

    expect(session.capabilities.supportsMcpServers).toBe(true);
    expect(runtime.launches[0]?.cordis).toEqual(expect.stringContaining("cordis.yml"));
    await session.close();
  });

  test("fetchCatalog returns static DeepSeek models", async () => {
    const { client } = createClient();
    const catalog = await client.fetchCatalog({ scope: "global", force: false });
    expect(catalog.modes).toEqual([]);
    expect(catalog.models.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
  });
});
