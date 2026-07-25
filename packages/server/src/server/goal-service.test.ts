import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "./agent/agent-manager.js";
import { GoalService } from "./goal-service.js";
import { formatGoalContinuationPrompt } from "./goal/continuation-prompt.js";

describe("formatGoalContinuationPrompt", () => {
  it("includes condition, reason, and iteration budget", () => {
    const text = formatGoalContinuationPrompt({
      condition: "Tests pass",
      reason: "No test output yet",
      iteration: 2,
      maxIterations: 12,
    });
    expect(text).toContain("Tests pass");
    expect(text).toContain("No test output yet");
    expect(text).toContain("2/12");
  });
});

describe("GoalService", () => {
  let tempHome = "";
  let service: GoalService;

  const agentManager = {
    getAgent: vi.fn(() => ({ id: "agent-1", cwd: "/tmp/project" })),
    getTimeline: vi.fn(() => []),
    getPendingPermissions: vi.fn(() => []),
    streamAgent: vi.fn(async function* () {}),
  } satisfies Pick<
    AgentManager,
    "getAgent" | "getTimeline" | "getPendingPermissions" | "streamAgent"
  >;

  const providerSnapshotManager = {
    listProviders: vi.fn(async () => []),
  };

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  async function createService() {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-goal-"));
    service = new GoalService({
      paseoHome: tempHome,
      agentManager,
      providerSnapshotManager,
      readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
      logger: {
        child: () => ({
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
          trace: vi.fn(),
        }),
      } as never,
    });
    await service.initialize();
  }

  it("set/get/clear round-trip persists active.json", async () => {
    await createService();
    const set = await service.setGoal("agent-1", {
      condition: "All tests green",
      maxIterations: 5,
    });
    expect(set.status).toBe("active");
    expect(set.maxIterations).toBe(5);
    expect(service.getGoal("agent-1")?.condition).toBe("All tests green");

    const cleared = await service.clearGoal("agent-1");
    expect(cleared?.status).toBe("cleared");
    expect(service.getGoal("agent-1")).toBeNull();

    const raw = await readFile(path.join(tempHome, "goals", "active.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({});
  });

  it("pauses when permissions are pending", async () => {
    await createService();
    await service.setGoal("agent-1", { condition: "Ship feature" });
    agentManager.getPendingPermissions.mockReturnValueOnce([
      { id: "perm-1", name: "approve", kind: "permission" } as never,
    ]);

    await service.maybeScheduleContinuation("agent-1");

    expect(service.getGoal("agent-1")?.status).toBe("paused");
    expect(agentManager.streamAgent).not.toHaveBeenCalled();
  });

  it("hasActiveGoal is true for active and paused records", async () => {
    await createService();
    expect(service.hasActiveGoal("agent-1")).toBe(false);
    await service.setGoal("agent-1", { condition: "Done" });
    expect(service.hasActiveGoal("agent-1")).toBe(true);

    agentManager.getPendingPermissions.mockReturnValueOnce([
      { id: "perm-1", name: "approve", kind: "permission" } as never,
    ]);
    await service.maybeScheduleContinuation("agent-1");
    expect(service.hasActiveGoal("agent-1")).toBe(true);
  });
});
