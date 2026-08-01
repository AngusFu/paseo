import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopDocsChromaSidecar } from "../docs-vfs/chroma-sidecar.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
  type WorkspaceRegistry,
} from "../workspace-registry.js";
import { KnowledgeBaseService } from "./service.js";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await stopDocsChromaSidecar(home);
  }
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "paseo-kb-rpc-"));
  homes.push(home);
  return home;
}

function makeDocsFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "paseo-kb-docs-"));
  mkdirSync(join(root, "guides"), { recursive: true });
  writeFileSync(join(root, "a.md"), "# A\n\nAlpha content.\n");
  writeFileSync(join(root, "guides", "b.md"), "# B\n\nBeta content.\n");
  return root;
}

function fakeEmbedFetch(): typeof fetch {
  return async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { input: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(
      JSON.stringify({
        data: inputs.map((_text, index) => ({ index, embedding: [1, 0] })),
      }),
      { status: 200 },
    );
  };
}

async function seedWorkspace(
  home: string,
  workspaceRegistry: WorkspaceRegistry,
  workspaceId: string,
  title = "feature-auth",
) {
  await workspaceRegistry.upsert(
    createPersistedWorkspaceRecord({
      workspaceId,
      projectId: "prj_test",
      cwd: home,
      kind: "directory",
      displayName: title,
      title,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    }),
  );
}

async function makeService(
  home: string,
): Promise<{ service: KnowledgeBaseService; workspaceRegistry: WorkspaceRegistry }> {
  mkdirSync(join(home, "projects"), { recursive: true });
  const workspaceRegistry = new FileBackedWorkspaceRegistry(
    join(home, "projects", "workspaces.json"),
    createTestLogger(),
  );
  await workspaceRegistry.initialize();
  return {
    service: new KnowledgeBaseService(home, workspaceRegistry, fakeEmbedFetch()),
    workspaceRegistry,
  };
}

describe("KnowledgeBaseService RPC façade", () => {
  it("creates an empty knowledge base with importedAt null", async () => {
    const home = makeHome();
    const { service } = await makeService(home);

    const created = await service.create({ slug: "scratch", name: "Scratch" });
    expect(created.slug).toBe("scratch");
    expect(created.name).toBe("Scratch");
    expect(created.importedAt).toBeNull();

    const listed = await service.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.importedAt).toBeNull();
    expect(listed[0]?.mountedWorkspaceCount).toBe(0);

    await expect(service.create({ slug: "scratch" })).rejects.toThrow(/already exists/);
  });

  it("lists, imports, exports, mounts, unmounts, and deletes against real docs-vfs", async () => {
    const home = makeHome();
    const docs = makeDocsFolder();
    const { service, workspaceRegistry } = await makeService(home);

    expect(await service.list()).toEqual([]);

    await expect(
      service.import({
        slug: "runbooks",
        fromPath: docs,
        sourceKind: "folder",
      }),
    ).rejects.toThrow(/Embeddings disabled/);

    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        localTools: {
          embeddings: {
            enabled: true,
            baseUrl: "http://example.invalid/v1",
            apiKey: "x",
            model: "qwen3-embedding:0.6b",
          },
        },
      }),
    );

    const imported = await service.import({
      slug: "runbooks",
      name: "Company runbooks",
      fromPath: docs,
      sourceKind: "folder",
    });
    expect(imported.knowledgeBase.slug).toBe("runbooks");
    expect(imported.knowledgeBase.name).toBe("Company runbooks");
    expect(imported.meta.source).toBe("folder");
    expect(imported.meta.chunkCount).toBeGreaterThan(0);

    const listed = await service.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.mountedWorkspaceCount).toBe(0);

    const out = mkdtempSync(join(tmpdir(), "paseo-kb-export-"));
    const exported = await service.export({ idOrSlug: "runbooks", outDir: out });
    expect(exported.pageCount).toBe(2);
    expect(exported.format).toBe("paseo.kb.corpus/v1");

    const workspaceId = "wks_test0000000001";
    await seedWorkspace(home, workspaceRegistry, workspaceId);

    const mount = await service.mount({
      workspaceId,
      idOrSlug: "runbooks",
    });
    expect(mount.mountSlug).toBe("runbooks");
    expect(mount.slug).toBe("runbooks");

    const mounts = await service.listMounts({ workspaceId });
    expect(mounts).toEqual([
      expect.objectContaining({
        knowledgeBaseId: imported.knowledgeBase.id,
        mountSlug: "runbooks",
        slug: "runbooks",
        name: "Company runbooks",
      }),
    ]);

    expect((await service.list())[0]?.mountedWorkspaceCount).toBe(1);

    const usages = await service.listUsages({ idOrSlug: "runbooks" });
    expect(usages).toEqual([{ workspaceId, title: "feature-auth", mountSlug: "runbooks" }]);

    const blocked = await service.delete({ idOrSlug: "runbooks" });
    expect(blocked).toEqual({
      ok: false,
      code: "still_mounted",
      error: expect.stringMatching(/still mounted/),
      workspaces: usages,
    });

    const unmounted = await service.unmount({
      workspaceId,
      mountSlugOrKbId: "runbooks",
    });
    expect(unmounted.mountSlug).toBe("runbooks");

    const deleted = await service.delete({ idOrSlug: "runbooks" });
    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.deleted.slug).toBe("runbooks");
    }
    expect(await service.list()).toEqual([]);
  });

  it("rejects sourceKind mismatch for package vs folder", async () => {
    const home = makeHome();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        localTools: {
          embeddings: {
            enabled: true,
            baseUrl: "http://example.invalid/v1",
            apiKey: "x",
            model: "qwen3-embedding:0.6b",
          },
        },
      }),
    );
    const docs = makeDocsFolder();
    const { service } = await makeService(home);

    await expect(
      service.import({
        slug: "pkg",
        fromPath: docs,
        sourceKind: "package",
      }),
    ).rejects.toThrow(/not a corpus package/);
  });

  it("lists tree, gets page, and searches within one knowledge base", async () => {
    const home = makeHome();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        localTools: {
          embeddings: {
            enabled: true,
            baseUrl: "http://example.invalid/v1",
            apiKey: "x",
            model: "qwen3-embedding:0.6b",
          },
        },
      }),
    );
    const docs = makeDocsFolder();
    const { service } = await makeService(home);

    await service.import({
      slug: "runbooks",
      fromPath: docs,
      sourceKind: "folder",
    });

    const empty = await service.create({ slug: "scratch" });
    expect(await service.listTree({ idOrSlug: empty.id })).toEqual([]);

    const nodes = await service.listTree({ idOrSlug: "runbooks" });
    expect(nodes).toEqual(
      expect.arrayContaining([
        { path: "guides", name: "guides", kind: "directory", parentPath: null },
        { path: "guides/b.md", name: "b.md", kind: "file", parentPath: "guides" },
        { path: "a.md", name: "a.md", kind: "file", parentPath: null },
      ]),
    );

    const page = await service.getPage({ idOrSlug: "runbooks", path: "guides/b.md" });
    expect(page.path).toBe("guides/b.md");
    expect(page.content).toContain("Beta content");

    await expect(service.getPage({ idOrSlug: "runbooks", path: "missing.md" })).rejects.toThrow(
      /No such document/,
    );

    const grep = await service.search({
      idOrSlug: "runbooks",
      query: "Alpha",
      mode: "grep",
    });
    expect(grep.mode).toBe("grep");
    expect(grep.hits.some((hit) => hit.path === "a.md")).toBe(true);
    expect(grep.hits.find((hit) => hit.path === "a.md")?.snippet).toMatch(/Alpha/i);

    const byPath = await service.search({
      idOrSlug: "runbooks",
      query: "guides",
      mode: "grep",
    });
    expect(byPath.hits.some((hit) => hit.path === "guides/b.md")).toBe(true);

    const vector = await service.search({
      idOrSlug: "runbooks",
      query: "Alpha content",
      mode: "vector",
      limit: 3,
    });
    expect(vector.mode).toBe("vector");
    expect(vector.hits.length).toBeGreaterThan(0);
    expect(vector.hits[0]?.path).toBeTruthy();
    expect(vector.hits[0]?.score).toEqual(expect.any(Number));
    expect(vector.hits[0]?.snippet.length).toBeGreaterThan(0);

    const usages = await service.listUsages({ idOrSlug: "runbooks" });
    expect(usages).toEqual([]);
  });

  it("upserts, renames, and deletes pages on an empty knowledge base", async () => {
    const home = makeHome();
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        localTools: {
          embeddings: {
            enabled: true,
            baseUrl: "http://example.invalid/v1",
            apiKey: "x",
            model: "qwen3-embedding:0.6b",
          },
        },
      }),
    );
    const { service } = await makeService(home);
    const created = await service.create({ slug: "scratch", name: "Scratch" });

    const written = await service.upsertPage({
      idOrSlug: created.id,
      path: "guides/first.md",
      content: "# First\n\nHello page.\n",
    });
    expect(written.path).toBe("guides/first.md");

    const page = await service.getPage({ idOrSlug: "scratch", path: "guides/first.md" });
    expect(page.content).toContain("Hello page");

    const tree = await service.listTree({ idOrSlug: "scratch" });
    expect(tree).toEqual(
      expect.arrayContaining([
        { path: "guides", name: "guides", kind: "directory", parentPath: null },
        { path: "guides/first.md", name: "first.md", kind: "file", parentPath: "guides" },
      ]),
    );

    const renamed = await service.upsertPage({
      idOrSlug: "scratch",
      path: "notes/second.md",
      content: "# Second\n\nMoved.\n",
      fromPath: "guides/first.md",
    });
    expect(renamed.path).toBe("notes/second.md");
    await expect(service.getPage({ idOrSlug: "scratch", path: "guides/first.md" })).rejects.toThrow(
      /No such document/,
    );
    expect(
      (await service.getPage({ idOrSlug: "scratch", path: "notes/second.md" })).content,
    ).toContain("Moved");

    const deleted = await service.deletePage({ idOrSlug: "scratch", path: "notes/second.md" });
    expect(deleted.path).toBe("notes/second.md");
    expect(await service.listTree({ idOrSlug: "scratch" })).toEqual([]);

    await expect(
      service.deletePage({ idOrSlug: "scratch", path: "notes/second.md" }),
    ).rejects.toThrow(/No such document/);

    await expect(
      service.upsertPage({
        idOrSlug: "scratch",
        path: "../escape.md",
        content: "nope",
      }),
    ).rejects.toThrow(/Invalid page path/);
  });

  it("upserts pages when embeddings are disabled", async () => {
    const home = makeHome();
    const { service } = await makeService(home);
    await service.create({ slug: "offline" });

    const written = await service.upsertPage({
      idOrSlug: "offline",
      path: "readme.md",
      content: "# Offline\n\nNo embeddings.\n",
    });
    expect(written.path).toBe("readme.md");
    expect((await service.getPage({ idOrSlug: "offline", path: "readme.md" })).content).toContain(
      "No embeddings",
    );

    const grep = await service.search({
      idOrSlug: "offline",
      query: "embeddings",
      mode: "grep",
    });
    expect(grep.hits.some((hit) => hit.path === "readme.md")).toBe(true);
  });
});
