import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const logger = createTestLogger();

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

const RETRIABLE_ERROR = "RetriableError: [resource_exhausted] Rate limit exceeded";

abstract class RetriableTurnTestSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(protected readonly config: AgentSessionConfig) {}

  abstract emitTurn(): void;

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    const turnId = "turn-retriable-1";
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.emitTurn();
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const cb of this.subscribers) {
      cb(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return {
      provider: this.provider,
      sessionId: this.id,
    };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class RetriableTurnFailedSession extends RetriableTurnTestSession {
  emitTurn(): void {
    this.pushEvent({
      type: "turn_failed",
      provider: this.provider,
      turnId: "turn-retriable-1",
      error: RETRIABLE_ERROR,
    });
  }
}

class RetriableTurnCompletedSession extends RetriableTurnTestSession {
  emitTurn(): void {
    const turnId = "turn-retriable-1";
    this.pushEvent({
      type: "timeline",
      provider: this.provider,
      turnId,
      item: { type: "assistant_message", text: RETRIABLE_ERROR },
    });
    this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
  }
}

class RetriableTurnTestClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;

  constructor(private readonly SessionClass: typeof RetriableTurnTestSession) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new this.SessionClass(config);
  }

  async resumeSession(
    _handle: unknown,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return new this.SessionClass({
      provider: "codex",
      cwd: config?.cwd ?? process.cwd(),
    });
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }
}

async function drainForegroundTurn(manager: AgentManager, agentId: string): Promise<void> {
  for await (const _event of manager.streamAgent(agentId, "continue task")) {
    // Drain until the foreground waiter settles.
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}

afterEach(() => {
  vi.useRealTimers();
});

test("arms retriable retry on foreground turn_failed without broadcasting turn_failed", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "retriable-turn-failed-"));
  try {
    const manager = new AgentManager({
      clients: { codex: new RetriableTurnTestClient(RetriableTurnFailedSession) },
      registry: new AgentStorage(join(workdir, "agents"), logger),
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000301",
    });
    manager.setPaseoToolsEnabled(false);

    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });

    const broadcastEvents: AgentStreamEvent[] = [];
    manager.subscribe(
      (event) => {
        if (event.type === "stream") {
          broadcastEvents.push(event.event);
        }
      },
      { agentId: agent.id, replayState: false },
    );

    await drainForegroundTurn(manager, agent.id);

    expect(broadcastEvents.some((event) => event.type === "turn_failed")).toBe(false);
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("running");

    const timeline = manager.getTimeline(agent.id);
    const retryNotice = timeline.find(
      (item) =>
        item.type === "assistant_message" &&
        item.text.includes("Retriable provider error — retrying"),
    );
    expect(retryNotice).toBeDefined();
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("arms retriable retry when provider finishes with turn_completed after streaming RetriableError", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "retriable-turn-completed-"));
  try {
    const manager = new AgentManager({
      clients: { codex: new RetriableTurnTestClient(RetriableTurnCompletedSession) },
      registry: new AgentStorage(join(workdir, "agents"), logger),
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000302",
    });
    manager.setPaseoToolsEnabled(false);

    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });

    const broadcastEvents: AgentStreamEvent[] = [];
    manager.subscribe(
      (event) => {
        if (event.type === "stream") {
          broadcastEvents.push(event.event);
        }
      },
      { agentId: agent.id, replayState: false },
    );

    await drainForegroundTurn(manager, agent.id);

    expect(broadcastEvents.some((event) => event.type === "turn_completed")).toBe(false);
    expect(manager.getAgent(agent.id)?.lifecycle).toBe("running");

    const timeline = manager.getTimeline(agent.id);
    const retryNotice = timeline.find(
      (item) =>
        item.type === "assistant_message" &&
        item.text.includes("Retriable provider error — retrying"),
    );
    expect(retryNotice).toBeDefined();
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("runAgent does not throw when a retriable turn_failed is armed for retry", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "retriable-run-agent-"));
  try {
    const manager = new AgentManager({
      clients: { codex: new RetriableTurnTestClient(RetriableTurnFailedSession) },
      registry: new AgentStorage(join(workdir, "agents"), logger),
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000303",
    });
    manager.setPaseoToolsEnabled(false);

    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });

    await expect(manager.runAgent(agent.id, "continue task")).resolves.toMatchObject({
      canceled: false,
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
