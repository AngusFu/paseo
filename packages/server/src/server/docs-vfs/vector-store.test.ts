import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopDocsChromaSidecar } from "./chroma-sidecar.js";
import { docsChromaIndexCount } from "./chroma-vector-index.js";
import { buildDocsStore } from "./store.js";
import {
  ingestDocsToMemoryStore,
  listFromPathTree,
  openDocsVectorStore,
  PATH_TREE_DOC_ID,
  rebuildDocsVectorStore,
} from "./vector-store.js";
import { sqliteDbPath } from "./vector-store-sqlite.js";

const homes: string[] = [];

function trackHome(): string {
  const home = mkdtempSync(join(tmpdir(), "paseo-home-"));
  homes.push(home);
  return home;
}

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await stopDocsChromaSidecar(home);
  }
});

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "paseo-docs-vdb-"));
  const docs = join(root, "docs");
  mkdirSync(join(docs, "guides"), { recursive: true });
  writeFileSync(join(docs, "architecture.md"), "# Architecture\n\nHooks and agents.\n");
  writeFileSync(join(docs, "guides", "start.md"), "# Start\n\nRun npm run dev.\n");
  return docs;
}

describe("Chroma DocsVectorStore (ChromaFs-shaped)", () => {
  it("indexes into SQLite corpus + Chroma vectors and serves ls/cat/grep/search", async () => {
    const docsRoot = makeFixture();
    const paseoHome = trackHome();
    const vectors = new Map<string, number[]>([
      ["# Architecture\n\nHooks and agents.", [1, 0]],
      ["# Start\n\nRun npm run dev.", [0, 1]],
    ]);
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(
        JSON.stringify({
          data: inputs.map((text, index) => ({
            index,
            embedding: vectors.get(text) ?? [0, 0],
          })),
        }),
        { status: 200 },
      );
    };

    const config = {
      enabled: true,
      baseUrl: "http://example.invalid/v1",
      apiKey: "x",
      model: "qwen3-embedding:0.6b",
    };

    const built = await rebuildDocsVectorStore({
      docsRoot,
      paseoHome,
      config,
      fetchImpl,
    });
    expect(built.dbPath).toBe(sqliteDbPath(built.dir));
    expect(built.chromaPath).toContain(join("docs-vfs", "_chroma"));
    expect(built.chromaCollection).toMatch(/^docs_/);
    expect(PATH_TREE_DOC_ID).toBe("__path_tree__");
    expect(await docsChromaIndexCount(built.dir)).toBe(built.meta.chunkCount);

    const store = openDocsVectorStore(built.dir);
    expect(listFromPathTree(store.pathTree())).toEqual(
      expect.arrayContaining(["architecture.md", "guides/"]),
    );
    expect(store.list("guides")).toEqual(["start.md"]);

    const page = await store.cat("/paseo-vfs/docs/architecture.md");
    expect(page.content).toContain("Hooks and agents");

    const hits = await store.grep("hooks", { ignoreCase: true });
    expect(hits.some((hit) => hit.slug === "architecture.md")).toBe(true);

    const semantic = await store.search([0.9, 0.1], { limit: 1 });
    expect(semantic[0]?.slug).toBe("architecture.md");
    expect(semantic[0]?.score).toBeGreaterThan(0.5);
    expect(store.meta().embeddingDims).toBe(2);
    await expect(store.search([0.9, 0.1, 0], { limit: 1 })).rejects.toThrow(/dimension mismatch/i);

    await store.close();
  });

  it("stages ingest in memory before durable write", async () => {
    const docsRoot = makeFixture();
    const fsStore = buildDocsStore(docsRoot);
    const store = await ingestDocsToMemoryStore({
      store: fsStore,
      config: {
        enabled: true,
        baseUrl: "http://example.invalid/v1",
        apiKey: "x",
        model: "qwen3-embedding:0.6b",
      },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { input: string | string[] };
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return new Response(
          JSON.stringify({
            data: inputs.map((_text, index) => ({ index, embedding: [1, 0] })),
          }),
          { status: 200 },
        );
      },
    });
    expect(store.rows().length).toBeGreaterThan(0);
  });

  it("rejects open when docs.sqlite is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-docs-missing-"));
    expect(() => openDocsVectorStore(dir)).toThrow(/paseo kb index/);
  });

  it("rebuild overwrites corpus and Chroma index", async () => {
    const docsRoot = makeFixture();
    const paseoHome = trackHome();
    const config = {
      enabled: true,
      baseUrl: "http://example.invalid/v1",
      apiKey: "x",
      model: "qwen3-embedding:0.6b",
    };
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(
        JSON.stringify({
          data: inputs.map((_text, index) => ({ index, embedding: [1, 0] })),
        }),
        { status: 200 },
      );
    };

    const first = await rebuildDocsVectorStore({ docsRoot, paseoHome, config, fetchImpl });
    writeFileSync(join(docsRoot, "new.md"), "# New\n\nExtra page after first index.\n");
    const second = await rebuildDocsVectorStore({ docsRoot, paseoHome, config, fetchImpl });
    expect(second.dbPath).toBe(first.dbPath);
    expect(second.chromaCollection).toBe(first.chromaCollection);
    expect(second.meta.chunkCount).toBeGreaterThan(first.meta.chunkCount);
    expect(await docsChromaIndexCount(second.dir)).toBe(second.meta.chunkCount);

    const store = openDocsVectorStore(second.dir);
    expect(store.list()).toEqual(expect.arrayContaining(["new.md"]));
    const page = await store.cat("new.md");
    expect(page.content).toContain("Extra page");
    await store.close();
  });
});
