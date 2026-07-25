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
  let evaluateGoal = vi.fn<
    Parameters<NonNullable<ConstructorParameters<typeof GoalService>[0]["evaluateGoal"]>>[0],
    ReturnType<NonNullable<ConstructorParameters<typeof GoalService>[0]["evaluateGoal"]>>
  >();

  const streamAgent = vi.fn(async function* (_agentId: string, _prompt: string) {});

  const agentManager = {
    getAgent: vi.fn(() => ({ id: "agent-1", cwd: "/tmp/project" })),
    getTimeline: vi.fn(() => []),
    getPendingPermissions: vi.fn(() => []),
    streamAgent,
  } satisfies Pick<
    AgentManager,
    "getAgent" | "getTimeline" | "getPendingPermissions" | "streamAgent"
  >;

  const providerSnapshotManager = {
    listProviders: vi.fn(async () => []),
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function createService() {
    tempHome = await mkdtemp(path.join(tmpdir(), "paseo-goal-"));
    streamAgent.mockClear();
    evaluateGoal = vi.fn(async () => ({ met: false, reason: "Still in progress" }));
    service = new GoalService({
      paseoHome: tempHome,
      agentManager,
      providerSnapshotManager,
      readDaemonConfig: () => ({ metadataGeneration: { providers: [] } }),
      evaluateGoal: (input) => evaluateGoal(input),
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
    expect(service.getGoal("agent-1")?.pauseReason).toBe("permissions");
    expect(streamAgent).not.toHaveBeenCalled();
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

  it("clears goal when evaluation reports met", async () => {
    await createService();
    evaluateGoal.mockResolvedValueOnce({ met: true, reason: "Tests passed" });
    await service.setGoal("agent-1", { condition: "Tests pass" });

    await service.maybeScheduleContinuation("agent-1");

    expect(service.getGoal("agent-1")).toBeNull();
    expect(streamAgent).not.toHaveBeenCalled();
  });

  it("schedules continuation when evaluation reports not met", async () => {
    vi.useFakeTimers();
    await createService();
    await service.setGoal("agent-1", { condition: "Tests pass", maxIterations: 3 });

    await service.maybeScheduleContinuation("agent-1");
    await vi.runAllTimersAsync();

    expect(service.getGoal("agent-1")?.iteration).toBe(1);
    expect(streamAgent).toHaveBeenCalledTimes(1);
    const prompt = streamAgent.mock.calls[0]?.[1];
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("paseo-system");
  });

  it("stops after max iterations", async () => {
    await createService();
    await service.setGoal("agent-1", { condition: "Tests pass", maxIterations: 1 });
    evaluateGoal.mockResolvedValue({ met: false, reason: "Not yet" });

    await service.maybeScheduleContinuation("agent-1");
    expect(service.getGoal("agent-1")?.iteration).toBe(1);

    await service.maybeScheduleContinuation("agent-1");
    expect(service.getGoal("agent-1")).toBeNull();
  });

  it("pauses and notifies when evaluation fails", async () => {
    await createService();
    evaluateGoal.mockRejectedValueOnce(new Error("no structured providers"));
    await service.setGoal("agent-1", { condition: "Tests pass" });

    await service.maybeScheduleContinuation("agent-1");

    const goal = service.getGoal("agent-1");
    expect(goal?.status).toBe("paused");
    expect(goal?.pauseReason).toBe("evaluation_failed");
    expect(streamAgent).toHaveBeenCalledTimes(1);
    expect(streamAgent.mock.calls[0]?.[1]).toContain("evaluator could not run");

    streamAgent.mockClear();
    await service.maybeScheduleContinuation("agent-1");
    expect(streamAgent).not.toHaveBeenCalled();
  });
});
