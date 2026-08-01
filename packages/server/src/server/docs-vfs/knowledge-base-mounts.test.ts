import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { FileBackedWorkspaceRegistry } from "../workspace-registry.js";
import { registerImportedKnowledgeBase } from "./knowledge-base-registry.js";
import {
  listWorkspaceKnowledgeBaseMounts,
  mountKnowledgeBaseOnWorkspace,
} from "./knowledge-base-mounts.js";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "paseo-kb-mounts-"));
}

async function seedWorkspace(home: string, workspaceId: string): Promise<void> {
  mkdirSync(join(home, "projects"), { recursive: true });
  await writeJsonFileAtomic(join(home, "projects", "workspaces.json"), [
    {
      workspaceId,
      projectId: "prj_test",
      cwd: home,
      kind: "directory",
      displayName: "feature-auth",
      title: "feature-auth",
      worktreeRoot: null,
      isPaseoOwnedWorktree: false,
      mainRepoRoot: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      archivedAt: null,
    },
  ]);
}

describe("knowledge base mounts via workspace registry", () => {
  it("keeps mounts after a later registry update (rename) on the same cache", async () => {
    const home = makeHome();
    const workspaceId = "wks_test0000000001";
    await seedWorkspace(home, workspaceId);

    const kb = await registerImportedKnowledgeBase({
      slug: "runbooks",
      paseoHome: home,
    });

    const workspaceRegistry = new FileBackedWorkspaceRegistry(
      join(home, "projects", "workspaces.json"),
      createTestLogger(),
    );
    await workspaceRegistry.initialize();

    await mountKnowledgeBaseOnWorkspace({
      workspaceId,
      knowledgeBaseIdOrSlug: kb.id,
      paseoHome: home,
      workspaceRegistry,
    });

    // Simulate Host rename / any registry write that used to wipe out-of-band mounts.
    const renamed = await workspaceRegistry.update(workspaceId, (existing) => ({
      ...existing,
      title: "feature-auth-renamed",
      updatedAt: "2026-08-01T01:00:00.000Z",
    }));
    expect(renamed?.title).toBe("feature-auth-renamed");
    expect(renamed?.knowledgeBaseMounts).toEqual([
      { knowledgeBaseId: kb.id, mountSlug: "runbooks" },
    ]);

    expect(
      await listWorkspaceKnowledgeBaseMounts({
        workspaceId,
        paseoHome: home,
        workspaceRegistry,
      }),
    ).toEqual([{ knowledgeBaseId: kb.id, mountSlug: "runbooks" }]);

    // Fresh registry load proves disk retained mounts too.
    const reloaded = new FileBackedWorkspaceRegistry(
      join(home, "projects", "workspaces.json"),
      createTestLogger(),
    );
    await reloaded.initialize();
    expect((await reloaded.get(workspaceId))?.knowledgeBaseMounts).toEqual([
      { knowledgeBaseId: kb.id, mountSlug: "runbooks" },
    ]);

    const onDisk = JSON.parse(
      readFileSync(join(home, "projects", "workspaces.json"), "utf8"),
    ) as Array<{ knowledgeBaseMounts?: unknown }>;
    expect(onDisk[0]?.knowledgeBaseMounts).toEqual([
      { knowledgeBaseId: kb.id, mountSlug: "runbooks" },
    ]);
  });
});
