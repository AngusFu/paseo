import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { registerImportedKnowledgeBase } from "./knowledge-base-registry.js";
import { mountKnowledgeBaseOnWorkspace } from "./knowledge-base-mounts.js";
import { resolveDocsTarget } from "./resolve-docs-target.js";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "paseo-resolve-"));
}

describe("resolveDocsTarget", () => {
  it("blocks --root under workspace without --unsafe", async () => {
    const home = makeHome();
    await expect(
      resolveDocsTarget({
        root: home,
        workspaceId: "wks_abc",
        paseoHome: home,
        env: {},
      }),
    ).rejects.toThrow(/--unsafe/);
  });

  it("lists mounts at /paseo-vfs and opens mounted KB by path", async () => {
    const home = makeHome();
    const root = join(home, "books");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "x.md"), "# X\n");
    const kb = await registerImportedKnowledgeBase({
      slug: "books",
      importProvenance: root,
      paseoHome: home,
    });
    const workspaceId = "wks_resolve000001";
    await writeJsonFileAtomic(join(home, "projects", "workspaces.json"), [
      {
        workspaceId,
        projectId: "prj_x",
        cwd: home,
        kind: "directory",
        displayName: "t",
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
        createdAt: "2026-07-31T00:00:00.000Z",
        updatedAt: "2026-07-31T00:00:00.000Z",
        archivedAt: null,
      },
    ]);
    await mountKnowledgeBaseOnWorkspace({
      workspaceId,
      knowledgeBaseIdOrSlug: kb.id,
      paseoHome: home,
    });

    const listing = await resolveDocsTarget({
      pathArg: "/paseo-vfs",
      workspaceId,
      paseoHome: home,
      env: {},
    });
    expect(listing.mode).toBe("mount_listing");
    expect(listing.mountSlugs).toEqual(["books"]);

    const opened = await resolveDocsTarget({
      pathArg: "/paseo-vfs/books/x.md",
      workspaceId,
      paseoHome: home,
      env: {},
    });
    expect(opened.mode).toBe("knowledge_base");
    expect(opened.knowledgeBase?.id).toBe(kb.id);
    expect(opened.mountSlug).toBe("books");
    expect(opened.storeDir).toContain(kb.id);
  });
});
