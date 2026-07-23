import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createSchema, runCreateCommandWithDeps } from "./create.js";

function createFakeDaemonClient(
  workspace: Record<string, unknown> | null,
  error: string | null = null,
): DaemonClient {
  return {
    createPaseoWorktree: async () => ({
      workspace,
      error,
      setupTerminalId: null,
      requestId: "req-create",
    }),
    close: async () => {},
  } as unknown as DaemonClient;
}

const WORKSPACE = {
  id: "wks_5294ba9d7f40499a",
  name: "feat/SCIF-5183_email-banner-ratio",
  workspaceDirectory: "/paseo/worktrees/abc/scif-5183-email-banner-ratio",
};

describe("runCreateCommand", () => {
  // Callers spawn an agent into the new worktree straight afterwards, which
  // needs the workspace id. The command used to report only name/branch/path,
  // so scripts had to go hunting for it.
  it("reports the workspace the daemon registered", async () => {
    const result = await runCreateCommandWithDeps(
      { cwd: "/repo", mode: "checkout-branch", branch: "feat/SCIF-5183_email-banner-ratio" },
      { connectToDaemon: async () => createFakeDaemonClient(WORKSPACE) },
    );

    expect(result.data.workspaceId).toBe("wks_5294ba9d7f40499a");
    expect(result.data.branchName).toBe("feat/SCIF-5183_email-banner-ratio");
    expect(result.data.worktreePath).toBe(WORKSPACE.workspaceDirectory);
    expect(result.data.name).toBe("scif-5183-email-banner-ratio");
  });

  it("shows the workspace id in the default table output", () => {
    expect(createSchema.columns.map((column) => column.field)).toContain("workspaceId");
  });

  it("fails loudly when the daemon returns no workspace", async () => {
    await expect(
      runCreateCommandWithDeps(
        { cwd: "/repo", mode: "checkout-branch", branch: "feat/SCIF-5183_email-banner-ratio" },
        { connectToDaemon: async () => createFakeDaemonClient(null, "boom") },
      ),
    ).rejects.toMatchObject({ code: "WORKTREE_CREATE_FAILED" });
  });
});
