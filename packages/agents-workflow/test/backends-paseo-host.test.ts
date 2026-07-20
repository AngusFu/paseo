import { describe, expect, it, vi } from "vitest";
import { PaseoHostBackend, type PaseoAgentHost } from "../src/backends/paseo-host.js";
import type { AgentSpec } from "../src/backend.js";

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return { prompt: "do the thing", ...overrides };
}

describe("PaseoHostBackend", () => {
  it("forwards provider/model/workspace to the host", async () => {
    const runAgent = vi.fn(async () => ({ text: '{"ok":true}' }));
    const host: PaseoAgentHost = { runAgent };
    const backend = new PaseoHostBackend({
      host,
      defaultProvider: "cursor",
      defaultModel: "composer-2.5",
      cwd: "/repo",
      workspaceId: "wks_1",
    });
    const result = await backend.run(spec({ label: "plan:draft" }));
    expect(result.text).toBe('{"ok":true}');
    expect(runAgent).toHaveBeenCalledWith({
      prompt: "do the thing",
      provider: "cursor",
      model: "composer-2.5",
      thinkingOptionId: undefined,
      modeId: undefined,
      featureValues: undefined,
      cwd: "/repo",
      workspaceId: "wks_1",
      title: "plan:draft",
      labels: undefined,
      isolation: undefined,
    });
  });

  it("forwards effort/mode/featureValues (and backend defaults)", async () => {
    const runAgent = vi.fn(async () => ({ text: "ok" }));
    const backend = new PaseoHostBackend({
      host: { runAgent },
      defaultProvider: "claude",
      defaultEffort: "medium",
      defaultMode: "default",
      defaultFeatureValues: { fast_mode: false },
      workspaceId: "wks_1",
    });
    await backend.run(
      spec({
        effort: "high",
        mode: "plan",
        featureValues: { fast_mode: true },
      }),
    );
    expect(runAgent.mock.calls[0]?.[0]).toMatchObject({
      thinkingOptionId: "high",
      modeId: "plan",
      featureValues: { fast_mode: true },
    });
  });

  it("requires workspaceId for non-worktree runs", async () => {
    const backend = new PaseoHostBackend({
      host: { runAgent: async () => ({ text: "x" }) },
      defaultProvider: "cursor",
    });
    const result = await backend.run(spec());
    expect(result.error).toMatch(/workspaceId is required/);
  });

  it("omits workspaceId when isolation=worktree", async () => {
    const runAgent = vi.fn(async () => ({ text: "ok" }));
    const backend = new PaseoHostBackend({
      host: { runAgent },
      defaultProvider: "cursor",
      workspaceId: "wks_1",
    });
    await backend.run(spec({ isolation: "worktree", phase: "Plan" }));
    expect(runAgent.mock.calls[0]?.[0]).toMatchObject({
      isolation: "worktree",
      workspaceId: undefined,
      title: "Plan",
    });
  });

  it("returns host errors without throwing", async () => {
    const backend = new PaseoHostBackend({
      host: { runAgent: async () => ({ error: "Provider 'claude' is disabled" }) },
      defaultProvider: "claude",
      workspaceId: "wks_1",
    });
    await expect(backend.run(spec())).resolves.toEqual({
      error: "Provider 'claude' is disabled",
    });
  });

  it("forwards the engine callId to the host", async () => {
    const runAgent = vi.fn(async () => ({ text: "ok" }));
    const backend = new PaseoHostBackend({
      host: { runAgent },
      defaultProvider: "claude",
      workspaceId: "wks_1",
    });
    await backend.run(spec({ callId: 42 }));
    expect(runAgent.mock.calls[0]?.[0]).toMatchObject({ callId: 42 });
  });

  it("omits callId entirely when the engine did not supply one", async () => {
    const runAgent = vi.fn(async () => ({ text: "ok" }));
    const backend = new PaseoHostBackend({
      host: { runAgent },
      defaultProvider: "claude",
      workspaceId: "wks_1",
    });
    await backend.run(spec());
    expect(Object.hasOwn(runAgent.mock.calls[0]?.[0] ?? {}, "callId")).toBe(false);
  });

  it("passes the host's full usage record back to the engine", async () => {
    const usage = {
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 3,
      totalCostUsd: 0.01,
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 999,
    };
    const backend = new PaseoHostBackend({
      host: { runAgent: async () => ({ text: "ok", usage }) },
      defaultProvider: "claude",
      workspaceId: "wks_1",
    });
    await expect(backend.run(spec())).resolves.toEqual({ text: "ok", usage });
  });
});
