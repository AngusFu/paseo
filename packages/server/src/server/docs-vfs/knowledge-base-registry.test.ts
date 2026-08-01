import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEmptyKnowledgeBase,
  deleteKnowledgeBase,
  docsVfsDirForKnowledgeBase,
  getKnowledgeBase,
  listKnowledgeBases,
  registerImportedKnowledgeBase,
} from "./knowledge-base-registry.js";
import {
  knowledgeBaseHasMounts,
  mountKnowledgeBaseOnWorkspace,
  unmountKnowledgeBaseFromWorkspace,
} from "./knowledge-base-mounts.js";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { openDocsVectorStore } from "./vector-store.js";
import { sqliteDbPath } from "./vector-store-sqlite.js";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "paseo-kb-"));
}

describe("knowledge base registry", () => {
  it("creates an empty KB with importedAt null and an openable corpus store", async () => {
    const home = makeHome();
    const created = await createEmptyKnowledgeBase({
      slug: "scratch",
      name: "Scratch pad",
      paseoHome: home,
      now: "2026-08-01T12:00:00.000Z",
    });

    expect(created.id).toMatch(/^kb_[0-9a-f]{16}$/);
    expect(created.slug).toBe("scratch");
    expect(created.name).toBe("Scratch pad");
    expect(created.importedAt).toBeNull();
    expect(created.lastEmbeddedAt).toBeNull();
    expect(created.importProvenance).toBeNull();

    const storeDir = docsVfsDirForKnowledgeBase(home, created.id);
    expect(existsSync(sqliteDbPath(storeDir))).toBe(true);
    const store = openDocsVectorStore(storeDir);
    try {
      expect(store.pathTree()).toEqual({});
      expect(store.pageContents()).toEqual({});
      expect(store.meta().chunkCount).toBe(0);
    } finally {
      await store.close();
    }

    expect(await getKnowledgeBase("scratch", home)).toEqual(created);
    await expect(createEmptyKnowledgeBase({ slug: "scratch", paseoHome: home })).rejects.toThrow(
      /already exists/,
    );
  });

  it("registers, lists, and deletes imported KBs under kbId dirs", async () => {
    const home = makeHome();
    const root = join(home, "runbooks");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "a.md"), "# A\n");

    const created = await registerImportedKnowledgeBase({
      slug: "runbooks",
      importProvenance: root,
      paseoHome: home,
      now: "2026-07-31T00:00:00.000Z",
    });
    expect(created.id).toMatch(/^kb_[0-9a-f]{16}$/);
    expect(created.importedAt).toBe("2026-07-31T00:00:00.000Z");
    expect(docsVfsDirForKnowledgeBase(home, created.id)).toContain(created.id);

    const listed = await listKnowledgeBases(home);
    expect(listed).toHaveLength(1);
    expect(await getKnowledgeBase("runbooks", home)).toEqual(created);

    await expect(
      registerImportedKnowledgeBase({ slug: "runbooks", paseoHome: home }),
    ).rejects.toThrow(/already exists/);

    await deleteKnowledgeBase({ idOrSlug: "runbooks", paseoHome: home });
    expect(await listKnowledgeBases(home)).toEqual([]);
  });

  it("refuses delete while mounted and enforces mount slug uniqueness", async () => {
    const home = makeHome();
    const kb = await registerImportedKnowledgeBase({
      slug: "docs",
      paseoHome: home,
    });

    const workspaceId = "wks_test0000000001";
    await writeJsonFileAtomic(join(home, "projects", "workspaces.json"), [
      {
        workspaceId,
        projectId: "prj_test",
        cwd: home,
        kind: "directory",
        displayName: "test",
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
        createdAt: "2026-07-31T00:00:00.000Z",
        updatedAt: "2026-07-31T00:00:00.000Z",
        archivedAt: null,
      },
    ]);

    const mount = await mountKnowledgeBaseOnWorkspace({
      workspaceId,
      knowledgeBaseIdOrSlug: kb.id,
      paseoHome: home,
    });
    expect(mount.mountSlug).toBe("docs");
    expect(await knowledgeBaseHasMounts(kb.id, home)).toBe(true);

    await expect(
      mountKnowledgeBaseOnWorkspace({
        workspaceId,
        knowledgeBaseIdOrSlug: kb.id,
        paseoHome: home,
      }),
    ).rejects.toThrow(/already mounted/);

    await expect(deleteKnowledgeBase({ idOrSlug: kb.id, paseoHome: home })).rejects.toThrow(
      /still mounted/,
    );

    await unmountKnowledgeBaseFromWorkspace({
      workspaceId,
      mountSlugOrKbId: "docs",
      paseoHome: home,
    });
    expect(await knowledgeBaseHasMounts(kb.id, home)).toBe(false);
    await deleteKnowledgeBase({ idOrSlug: kb.id, paseoHome: home });
  });
});
