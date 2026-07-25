import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type { GoalService } from "../goal-service.js";
import type {
  AgentClient,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const checkProseStopWithLlama = vi.fn(async () => ({
  decision: "block" as const,
  source: "regex" as const,
  pattern: "let me know",
  llmVerdict: "SKIP" as const,
}));

vi.mock("./prose-stop/check.js", () => ({
  checkProseStopWithLlama: (...args: unknown[]) => checkProseStopWithLlama(...args),
}));

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

class ProseStopTestSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private subscribers = new Set<(event: AgentStreamEvent) => void>();

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    const turnId = "turn-1";
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "assistant_message", text: "Let me know if you need anything else." },
      });
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
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

class ProseStopTestClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new ProseStopTestSession(config);
  }

  async resumeSession(
    _handle: unknown,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return new ProseStopTestSession({
      provider: "codex",
      cwd: config?.cwd ?? process.cwd(),
    });
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }
}

function createGoalServiceStub(active: boolean): GoalService {
  const maybeScheduleContinuation = vi.fn(async () => {});
  return {
    hasActiveGoal: vi.fn(() => active),
    maybeScheduleContinuation,
  } as unknown as GoalService & { maybeScheduleContinuation: typeof maybeScheduleContinuation };
}

class TurnFailedTestSession extends ProseStopTestSession {
  override async startTurn(): Promise<{ turnId: string }> {
    const turnId = "turn-failed-1";
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({
        type: "turn_failed",
        provider: this.provider,
        turnId,
        error: "provider exploded",
      });
    }, 0);
    return { turnId };
  }
}

class TurnFailedTestClient extends ProseStopTestClient {
  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new TurnFailedTestSession(config);
  }
}

afterEach(() => {
  checkProseStopWithLlama.mockClear();
});

test("maybeScheduleGoalContinuation skips prose-stop when a goal is active", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "goal-hook-prose-stop-"));
  try {
    const manager = new AgentManager({
      clients: { codex: new ProseStopTestClient() },
      registry: new AgentStorage(join(workdir, "agents"), logger),
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000201",
    });
    manager.configureProseStop({
      getProseStopEnabled: () => true,
      getLlamaService: () => ({}) as never,
    });
    manager.setGoalService(createGoalServiceStub(true));
    manager.setPaseoToolsEnabled(false);

    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });

    for await (const _event of manager.streamAgent(agent.id, "finish this task")) {
      // Drain foreground turn through turn_completed hook chain.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(checkProseStopWithLlama).not.toHaveBeenCalled();
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("maybeScheduleGoalContinuation runs prose-stop when no goal is active", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "goal-hook-prose-stop-"));
  try {
    const manager = new AgentManager({
      clients: { codex: new ProseStopTestClient() },
      registry: new AgentStorage(join(workdir, "agents"), logger),
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000202",
    });
    manager.configureProseStop({
      getProseStopEnabled: () => true,
      getLlamaService: () => ({}) as never,
    });
    manager.setGoalService(createGoalServiceStub(false));
    manager.setPaseoToolsEnabled(false);

    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });

    for await (const _event of manager.streamAgent(agent.id, "finish this task")) {
      // Drain foreground turn through turn_completed hook chain.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(checkProseStopWithLlama).toHaveBeenCalled();
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("maybeScheduleGoalContinuation runs on foreground turn_failed", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "goal-hook-turn-failed-"));
  try {
    const goalService = createGoalServiceStub(true);
    const manager = new AgentManager({
      clients: { codex: new TurnFailedTestClient() },
      registry: new AgentStorage(join(workdir, "agents"), logger),
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000203",
    });
    manager.setGoalService(goalService);
    manager.setPaseoToolsEnabled(false);

    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });

    for await (const _event of manager.streamAgent(agent.id, "finish this task")) {
      // Drain foreground turn through turn_failed hook chain.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(goalService.maybeScheduleContinuation).toHaveBeenCalledWith(agent.id);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
