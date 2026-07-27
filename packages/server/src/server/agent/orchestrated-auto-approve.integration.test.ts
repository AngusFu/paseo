import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import {
  PARENT_AGENT_ID_LABEL,
  WORKFLOW_AGENT_LABEL,
  WORKFLOW_RUN_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type { AgentClient, AgentSession, AgentSessionConfig } from "./agent-sdk-types.js";
import { buildACPAutoAcceptFeature } from "./providers/acp-agent.js";

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

class CaptureConfigClient implements AgentClient {
  readonly provider = "codex" as const;
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

describe("orchestrated auto_accept at create (in-process dev harness)", () => {
  test("preserves explicit auto_accept false for delegated subagents", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "orch-auto-approve-"));
    const client = new CaptureConfigClient();
    let nextId = 0;
    const manager = new AgentManager({
      clients: { codex: client },
      registry: new AgentStorage(join(workdir, "agents"), logger),
      logger,
      idFactory: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
    });

    try {
      const agent = await manager.createAgent(
        {
          provider: "codex",
          cwd: workdir,
          featureValues: { auto_accept: false },
        },
        undefined,
        {
          workspaceId: undefined,
          labels: { [PARENT_AGENT_ID_LABEL]: "parent-1" },
        },
      );

      expect(agent.config.featureValues?.auto_accept).toBe(false);
      expect(client.createdConfigs[0]?.featureValues?.auto_accept).toBe(false);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test.each([
    { label: WORKFLOW_RUN_ID_LABEL, value: "run-1" },
    { label: WORKFLOW_AGENT_LABEL, value: "1" },
  ])("forces auto_accept for workflow label $label", async ({ label, value }) => {
    const workdir = mkdtempSync(join(tmpdir(), "orch-auto-approve-"));
    const client = new CaptureConfigClient();
    const manager = new AgentManager({
      clients: { codex: client },
      registry: new AgentStorage(join(workdir, "agents"), logger),
      logger,
    });

    try {
      const agent = await manager.createAgent(
        {
          provider: "codex",
          cwd: workdir,
          featureValues: { auto_accept: "false" },
        },
        undefined,
        {
          workspaceId: undefined,
          labels: { [label]: value },
        },
      );

      expect(agent.config.featureValues?.auto_accept).toBe(true);
      expect(client.createdConfigs[0]?.featureValues?.auto_accept).toBe(true);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("ACP wire coercion: buildACPAutoAcceptFeature accepts boolean true stamp", () => {
    const feature = buildACPAutoAcceptFeature({
      provider: "cursor",
      cwd: "/tmp",
      featureValues: { auto_accept: true },
    });
    expect(feature.type).toBe("toggle");
    if (feature.type === "toggle") {
      expect(feature.value).toBe(true);
    }
  });

  test("ACP wire coercion: buildACPAutoAcceptFeature accepts string true stamp", () => {
    const feature = buildACPAutoAcceptFeature({
      provider: "cursor",
      cwd: "/tmp",
      featureValues: { auto_accept: "true" },
    });
    expect(feature.type).toBe("toggle");
    if (feature.type === "toggle") {
      expect(feature.value).toBe(true);
    }
  });
});
