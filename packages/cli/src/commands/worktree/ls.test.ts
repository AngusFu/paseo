import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { runLsCommandWithDeps } from "./ls.js";

function createFakeDaemonClient(
  overrides: Partial<Pick<DaemonClient, "fetchAgents" | "getPaseoWorktreeList" | "close">> = {},
): DaemonClient {
  return {
    fetchAgents: async () => ({ entries: [] }),
    getPaseoWorktreeList: async () => ({
      worktrees: [],
      error: null,
      requestId: "req-list",
    }),
    close: async () => {},
    ...overrides,
  } as unknown as DaemonClient;
}

describe("runLsCommand", () => {
  it("passes process.cwd when --cwd is omitted", async () => {
    const listCalls: Array<Parameters<DaemonClient["getPaseoWorktreeList"]>[0]> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async (input) => {
        listCalls.push(input);
        return {
          worktrees: [],
          error: null,
          requestId: "req-list",
        };
      },
    });

    await runLsCommandWithDeps(
      {},
      {
        connectToDaemon: async () => fakeClient,
      },
    );

    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]?.cwd).toBe(process.cwd());
  });

  it("passes --cwd to the daemon list request", async () => {
    const listCalls: Array<Parameters<DaemonClient["getPaseoWorktreeList"]>[0]> = [];
    const fakeClient = createFakeDaemonClient({
      getPaseoWorktreeList: async (input) => {
        listCalls.push(input);
        return {
          worktrees: [
            {
              worktreePath: "/tmp/paseo-home/worktrees/repo/feature",
              branchName: "feature",
              head: "abc123",
              createdAt: "2026-04-12T00:00:00.000Z",
            },
          ],
          error: null,
          requestId: "req-list",
        };
      },
    });

    const result = await runLsCommandWithDeps(
      { cwd: "/tmp/repo" },
      {
        connectToDaemon: async () => fakeClient,
      },
    );

    expect(listCalls).toEqual([{ cwd: "/tmp/repo" }]);
    expect(result.data).toEqual([
      {
        name: "feature",
        branch: "feature",
        cwd: "/tmp/paseo-home/worktrees/repo/feature",
        agent: "-",
      },
    ]);
  });
});
