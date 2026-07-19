import { WORKFLOW_RUN_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkspaceTabSnapshot,
  deriveWorkspaceAgentVisibility,
  type WorkspaceAgentVisibility,
} from "@/workspace-tabs/agent-visibility";
import { selectSubagentsForParent } from "@/subagents/select";
import { buildWorkspaceTabPersistenceKey, useWorkspaceLayoutStore } from "./workspace-layout-store";
import { useSessionStore, type Agent } from "./session-store";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

const SERVER_ID = "server-1";
const WORKSPACE_ID = "ws-main";
const WORKSPACE_DIRECTORY = "/repo/worktree";

const AGENT_TIMESTAMP = new Date("2026-04-21T10:00:00.000Z");

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: "agent",
  provider: "codex",
  status: "idle",
  createdAt: AGENT_TIMESTAMP,
  updatedAt: AGENT_TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: AGENT_TIMESTAMP,
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  runtimeInfo: undefined,
  lastUsage: undefined,
  lastError: null,
  title: "Agent",
  cwd: WORKSPACE_DIRECTORY,
  workspaceId: WORKSPACE_ID,
  model: null,
  features: undefined,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  parentAgentId: null,
  labels: {},
  projectPlacement: null,
};

function makeAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  return { ...AGENT_DEFAULTS, ...input };
}

function initializeAgents(agents: Agent[]): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  useSessionStore
    .getState()
    .setAgents(SERVER_ID, new Map(agents.map((agent) => [agent.id, agent])));
}

function appendAgent(agent: Agent): void {
  useSessionStore.getState().setAgents(SERVER_ID, (agents) => {
    const nextAgents = new Map(agents);
    nextAgents.set(agent.id, agent);
    return nextAgents;
  });
}

function deriveVisibilityFromSession(): WorkspaceAgentVisibility {
  const sessionAgents = useSessionStore.getState().sessions[SERVER_ID]?.agents ?? new Map();
  return deriveWorkspaceAgentVisibility({
    sessionAgents,
    workspaceId: WORKSPACE_ID,
  });
}

function reconcileWorkspaceTabs(workspaceKey: string, visibility: WorkspaceAgentVisibility): void {
  useWorkspaceLayoutStore.getState().reconcileTabs(
    workspaceKey,
    buildWorkspaceTabSnapshot({
      agentVisibility: visibility,
      agentsHydrated: true,
      terminalsHydrated: true,
      knownTerminalIds: [],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    }),
  );
}

function getWorkspaceTabIds(workspaceKey: string): string[] {
  return useWorkspaceLayoutStore
    .getState()
    .getWorkspaceTabs(workspaceKey)
    .map((tab) => tab.tabId);
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    splitSizesByWorkspace: {},
    pinnedAgentIdsByWorkspace: {},
    hiddenAgentIdsByWorkspace: {},
    hiddenWorkflowRunIdsByWorkspace: {},
  });
});

describe("workspace subagents integration", () => {
  it("collapses workflow-run agents into one workflow_run tab and prunes it after archive", () => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(workspaceKey).toBeTruthy();

    const runAgentA = makeAgent({
      id: "run-agent-a",
      title: "review:bugs",
      labels: { [WORKFLOW_RUN_ID_LABEL]: "wfr_1" },
    });
    const runAgentB = makeAgent({
      id: "run-agent-b",
      title: "review:perf",
      labels: { [WORKFLOW_RUN_ID_LABEL]: "wfr_1" },
    });

    initializeAgents([runAgentA, runAgentB]);
    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    // One synthetic run tab, no per-agent tabs.
    expect(getWorkspaceTabIds(workspaceKey!)).toEqual(["workflow_run_wfr_1"]);

    const archivedAt = new Date("2026-04-21T12:00:00.000Z");
    initializeAgents([
      { ...runAgentA, archivedAt },
      { ...runAgentB, archivedAt },
    ]);
    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    expect(getWorkspaceTabIds(workspaceKey!)).toEqual([]);
  });

  it("does not reopen a workflow_run tab the user closed by hand", () => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(workspaceKey).toBeTruthy();

    const runAgent = makeAgent({
      id: "run-agent",
      labels: { [WORKFLOW_RUN_ID_LABEL]: "wfr_closed" },
    });
    initializeAgents([runAgent]);
    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());
    expect(getWorkspaceTabIds(workspaceKey!)).toEqual(["workflow_run_wfr_closed"]);

    useWorkspaceLayoutStore.getState().closeTab(workspaceKey!, "workflow_run_wfr_closed");
    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());
    // Agents are still live, but the user's close sticks.
    expect(getWorkspaceTabIds(workspaceKey!)).toEqual([]);

    // Explicitly reopening clears the hidden flag and the tab persists again.
    useWorkspaceLayoutStore
      .getState()
      .openTabFocused(workspaceKey!, { kind: "workflow_run", runId: "wfr_closed" });
    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());
    expect(getWorkspaceTabIds(workspaceKey!)).toEqual(["workflow_run_wfr_closed"]);
  });

  it("keeps a child ingested before its parent out of auto-tabs, then exposes it in the parent section", () => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(workspaceKey).toBeTruthy();

    const child = makeAgent({
      id: "child-agent",
      parentAgentId: "parent-agent",
      title: "Child agent",
    });
    const parent = makeAgent({
      id: "parent-agent",
      title: "Parent agent",
    });

    initializeAgents([child]);

    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    expect(getWorkspaceTabIds(workspaceKey!)).toEqual([]);

    appendAgent(parent);

    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    expect(getWorkspaceTabIds(workspaceKey!)).toEqual(["agent_parent-agent"]);
    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-agent",
        },
        new Set(),
      ).map((row) => row.id),
    ).toEqual(["child-agent"]);
  });

  it("moves a detached child out of the parent section and back into normal workspace tabs", () => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(workspaceKey).toBeTruthy();

    const parent = makeAgent({
      id: "parent-agent",
      title: "Parent agent",
    });
    const child = makeAgent({
      id: "child-agent",
      parentAgentId: "parent-agent",
      title: "Child agent",
    });

    initializeAgents([parent, child]);
    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    expect(getWorkspaceTabIds(workspaceKey!)).toEqual(["agent_parent-agent"]);
    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-agent",
        },
        new Set(),
      ).map((row) => row.id),
    ).toEqual(["child-agent"]);

    appendAgent({ ...child, parentAgentId: null, labels: {} });
    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    expect(getWorkspaceTabIds(workspaceKey!)).toEqual(["agent_parent-agent", "agent_child-agent"]);
    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-agent",
        },
        new Set(),
      ),
    ).toEqual([]);
  });

  it("auto-opens a cross-workspace child while retaining it in the parent section", () => {
    const workspaceKey = buildWorkspaceTabPersistenceKey({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
    });
    expect(workspaceKey).toBeTruthy();

    const parent = makeAgent({
      id: "parent-agent",
      workspaceId: "ws-parent",
      title: "Parent agent",
    });
    const child = makeAgent({
      id: "child-agent",
      parentAgentId: parent.id,
      title: "Cross-workspace child",
    });

    initializeAgents([parent, child]);
    reconcileWorkspaceTabs(workspaceKey!, deriveVisibilityFromSession());

    expect(getWorkspaceTabIds(workspaceKey!)).toEqual(["agent_child-agent"]);
    expect(
      selectSubagentsForParent(
        useSessionStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: parent.id,
        },
        new Set(),
      ).map((row) => row.id),
    ).toEqual([child.id]);
  });
});
