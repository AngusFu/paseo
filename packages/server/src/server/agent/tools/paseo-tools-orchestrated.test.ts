import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PARENT_AGENT_ID_LABEL, WORKFLOW_RUN_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { AgentManager } from "../agent-manager.js";
import { AgentStorage } from "../agent-storage.js";
import type { AgentClient, AgentSession, AgentSessionConfig } from "../agent-sdk-types.js";
import { createPaseoToolCatalog } from "./paseo-tools.js";

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

class StubClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return {
      provider: "codex",
      capabilities: this.capabilities,
      id: "session-1",
      config,
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
}

test("orchestrated callers do not get ask_question in the tool catalog", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "paseo-tools-orchestrated-"));
  try {
    const storage = new AgentStorage(join(workdir, "agents"), logger);
    let nextId = 0;
    const manager = new AgentManager({
      clients: { codex: new StubClient() },
      registry: storage,
      logger,
      idFactory: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    });

    const foreground = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const foregroundCatalog = createPaseoToolCatalog({
      agentManager: manager,
      agentStorage: storage,
      terminalManager: null,
      workspaceScripts: null,
      scheduleService: null,
      providerSnapshotManager: null,
      callerAgentId: foreground.id,
      logger,
    });
    expect(foregroundCatalog.tools.has("ask_question")).toBe(true);
    expect(foregroundCatalog.tools.has("render_markdown")).toBe(true);

    const delegated = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
      labels: { [PARENT_AGENT_ID_LABEL]: foreground.id },
    });
    const delegatedCatalog = createPaseoToolCatalog({
      agentManager: manager,
      agentStorage: storage,
      terminalManager: null,
      workspaceScripts: null,
      scheduleService: null,
      providerSnapshotManager: null,
      callerAgentId: delegated.id,
      logger,
    });
    expect(delegatedCatalog.tools.has("ask_question")).toBe(false);

    const workflow = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
      labels: { [WORKFLOW_RUN_ID_LABEL]: "run-1" },
    });
    const workflowCatalog = createPaseoToolCatalog({
      agentManager: manager,
      agentStorage: storage,
      terminalManager: null,
      workspaceScripts: null,
      scheduleService: null,
      providerSnapshotManager: null,
      callerAgentId: workflow.id,
      logger,
    });
    expect(workflowCatalog.tools.has("ask_question")).toBe(false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
