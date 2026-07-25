import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import type {
  AgentClient,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
} from "../agent-sdk-types.js";
import { PROSE_STOP_PREVENTION_PROMPT } from "./prevention-prompt.js";

const logger = createTestLogger();

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class CaptureClient implements AgentClient {
  readonly provider: AgentProvider = "codex";
  readonly capabilities = TEST_CAPABILITIES;
  createdConfigs: AgentSessionConfig[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.createdConfigs.push(config);
    return {
      provider: "codex",
      capabilities: this.capabilities,
      id: "session-1",
      async run() {
        return { sessionId: "session-1", finalText: "", timeline: [] };
      },
      async startTurn() {
        return { turnId: "turn-1" };
      },
      subscribe() {
        return () => undefined;
      },
      async *streamHistory() {},
      async getRuntimeInfo() {
        return { provider: "codex", sessionId: "session-1", model: null, modeId: null };
      },
      async getAvailableModes() {
        return [];
      },
      async getCurrentMode() {
        return null;
      },
      async setMode() {},
      getPendingPermissions() {
        return [];
      },
      async respondToPermission() {},
      describePersistence() {
        return { provider: "codex", sessionId: "session-1" };
      },
      async interrupt() {},
      async close() {},
    };
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }
}

describe("prose-stop prevention prompt injection", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appends prevention prompt after user daemon append when enabled", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "prevention-prompt-"));
    dirs.push(workdir);
    const client = new CaptureClient();
    const manager = new AgentManager({
      clients: { codex: client },
      registry: new AgentStorage(join(workdir, "agents"), logger),
      logger,
      appendSystemPrompt: "User daemon append.",
      getProseStopPreventionPromptEnabled: () => true,
      idFactory: () => "00000000-0000-4000-8000-00000000a001",
    });

    await manager.createAgent(
      { provider: "codex", cwd: workdir, systemPrompt: "Agent." },
      undefined,
      { workspaceId: undefined },
    );

    expect(client.createdConfigs[0]?.daemonAppendSystemPrompt).toBe(
      `User daemon append.\n\n${PROSE_STOP_PREVENTION_PROMPT.trim()}`,
    );
  });

  test("injects prevention prompt alone when user append is empty", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "prevention-prompt-"));
    dirs.push(workdir);
    const client = new CaptureClient();
    const manager = new AgentManager({
      clients: { codex: client },
      registry: new AgentStorage(join(workdir, "agents"), logger),
      logger,
      getProseStopPreventionPromptEnabled: () => true,
      idFactory: () => "00000000-0000-4000-8000-00000000a002",
    });

    await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });

    expect(client.createdConfigs[0]?.daemonAppendSystemPrompt).toBe(
      PROSE_STOP_PREVENTION_PROMPT.trim(),
    );
  });
});
