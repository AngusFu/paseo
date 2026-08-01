import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopDocsChromaSidecar } from "./chroma-sidecar.js";
import { CORPUS_PACKAGE_FORMAT } from "./corpus-package.js";
import { exportKnowledgeBase, importKnowledgeBase } from "./knowledge-base-import-export.js";
import { getKnowledgeBase, listKnowledgeBases } from "./knowledge-base-registry.js";
import { openDocsVectorStore } from "./vector-store.js";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await stopDocsChromaSidecar(home);
  }
});

function makeDocsFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "paseo-import-docs-"));
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

const embedConfig = {
  enabled: true,
  baseUrl: "http://example.invalid/v1",
  apiKey: "x",
  model: "qwen3-embedding:0.6b",
};

describe("knowledge base import/export", () => {
  it("imports a folder into a self-contained KB and round-trips export", async () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-home-import-"));
    homes.push(home);
    const docs = makeDocsFolder();

    const imported = await importKnowledgeBase({
      slug: "runbooks",
      from: docs,
      paseoHome: home,
      config: embedConfig,
      fetchImpl: fakeEmbedFetch(),
      now: "2026-08-01T00:00:00.000Z",
    });

    expect(imported.source).toBe("folder");
    expect(imported.knowledgeBase.importedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(imported.knowledgeBase.lastEmbeddedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(imported.knowledgeBase.importProvenance).toBe(docs);

    const store = openDocsVectorStore(imported.dir);
    expect(await store.cat("a.md")).toEqual({
      slug: "a.md",
      content: "# A\n\nAlpha content.\n",
    });
    expect(store.pageContents()["guides/b.md"]).toContain("Beta content");
    await store.close();

    const out = mkdtempSync(join(tmpdir(), "paseo-export-"));
    const exported = await exportKnowledgeBase({
      idOrSlug: "runbooks",
      outDir: out,
      paseoHome: home,
      exportedAt: "2026-08-01T01:00:00.000Z",
    });
    expect(exported.manifest.format).toBe(CORPUS_PACKAGE_FORMAT);
    expect(exported.manifest.pageCount).toBe(2);
    expect(readFileSync(join(out, "pages", "a.md"), "utf8")).toBe("# A\n\nAlpha content.\n");

    const reimported = await importKnowledgeBase({
      slug: "runbooks-copy",
      from: out,
      paseoHome: home,
      config: embedConfig,
      fetchImpl: fakeEmbedFetch(),
      now: "2026-08-01T02:00:00.000Z",
    });
    expect(reimported.source).toBe("package");
    expect(reimported.knowledgeBase.id).not.toBe(imported.knowledgeBase.id);
    expect((await getKnowledgeBase("runbooks-copy", home))?.importedAt).toBe(
      "2026-08-01T02:00:00.000Z",
    );

    const copyStore = openDocsVectorStore(reimported.dir);
    expect((await copyStore.cat("guides/b.md")).content).toContain("Beta content");
    await copyStore.close();

    expect(await listKnowledgeBases(home)).toHaveLength(2);
  });

  it("refuses duplicate slug on import (no replace into existing KB)", async () => {
    const home = mkdtempSync(join(tmpdir(), "paseo-home-dup-"));
    homes.push(home);
    const docs = makeDocsFolder();
    await importKnowledgeBase({
      slug: "once",
      from: docs,
      paseoHome: home,
      config: embedConfig,
      fetchImpl: fakeEmbedFetch(),
    });
    await expect(
      importKnowledgeBase({
        slug: "once",
        from: docs,
        paseoHome: home,
        config: embedConfig,
        fetchImpl: fakeEmbedFetch(),
      }),
    ).rejects.toThrow(/already exists/);
  });
});
