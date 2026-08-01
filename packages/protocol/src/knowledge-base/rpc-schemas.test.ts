import { describe, expect, it } from "vitest";
import { ServerInfoStatusPayloadSchema } from "../messages.js";
import {
  KnowledgeBaseCreateRequestSchema,
  KnowledgeBaseCreateResponseSchema,
  KnowledgeBaseDeleteRequestSchema,
  KnowledgeBaseDeleteResponseSchema,
  KnowledgeBaseExportRequestSchema,
  KnowledgeBaseImportRequestSchema,
  KnowledgeBaseImportResponseSchema,
  KnowledgeBaseGetPageRequestSchema,
  KnowledgeBaseGetPageResponseSchema,
  KnowledgeBaseListMountsRequestSchema,
  KnowledgeBaseListRequestSchema,
  KnowledgeBaseListResponseSchema,
  KnowledgeBaseListTreeRequestSchema,
  KnowledgeBaseListTreeResponseSchema,
  KnowledgeBaseListUsagesRequestSchema,
  KnowledgeBaseMountRequestSchema,
  KnowledgeBaseSearchRequestSchema,
  KnowledgeBaseSearchResponseSchema,
  KnowledgeBaseUnmountRequestSchema,
  KnowledgeBaseUpsertPageRequestSchema,
  KnowledgeBaseUpsertPageResponseSchema,
  KnowledgeBaseDeletePageRequestSchema,
  KnowledgeBaseDeletePageResponseSchema,
  KnowledgeBaseEmbeddingsDetectOllamaRequestSchema,
  KnowledgeBaseEmbeddingsDetectOllamaResponseSchema,
  KnowledgeBaseEmbeddingsTestRequestSchema,
  KnowledgeBaseEmbeddingsTestResponseSchema,
} from "./rpc-schemas.js";

describe("knowledge_base RPC schemas", () => {
  it("accepts optional knowledgeBases capability on server_info", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_1",
        features: { knowledgeBases: true },
      }).features?.knowledgeBases,
    ).toBe(true);

    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "srv_1",
      }).features?.knowledgeBases,
    ).toBeUndefined();
  });

  it("accepts an empty list request", () => {
    expect(
      KnowledgeBaseListRequestSchema.parse({
        type: "knowledge_base.list.request",
        requestId: "req-1",
      }),
    ).toEqual({
      type: "knowledge_base.list.request",
      requestId: "req-1",
    });
  });

  it("round-trips list response with optional mount counts", () => {
    const parsed = KnowledgeBaseListResponseSchema.parse({
      type: "knowledge_base.list.response",
      payload: {
        requestId: "req-1",
        knowledgeBases: [
          {
            id: "kb_abc",
            slug: "runbooks",
            name: "Runbooks",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
            importedAt: "2026-08-01T00:00:00.000Z",
            lastEmbeddedAt: null,
            mountedWorkspaceCount: 2,
          },
        ],
        error: null,
      },
    });
    expect(parsed.payload.knowledgeBases[0]?.mountedWorkspaceCount).toBe(2);
  });

  it("accepts blank create request and response with importedAt null", () => {
    expect(
      KnowledgeBaseCreateRequestSchema.parse({
        type: "knowledge_base.create.request",
        requestId: "req-create",
        slug: "scratch",
        name: "Scratch",
      }),
    ).toEqual({
      type: "knowledge_base.create.request",
      requestId: "req-create",
      slug: "scratch",
      name: "Scratch",
    });

    expect(
      KnowledgeBaseCreateResponseSchema.parse({
        type: "knowledge_base.create.response",
        payload: {
          requestId: "req-create",
          knowledgeBase: {
            id: "kb_abc",
            slug: "scratch",
            name: "Scratch",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
            importedAt: null,
            lastEmbeddedAt: null,
          },
          error: null,
        },
      }).payload.knowledgeBase?.importedAt,
    ).toBeNull();
  });

  it("requires sourceKind on import", () => {
    expect(
      KnowledgeBaseImportRequestSchema.parse({
        type: "knowledge_base.import.request",
        requestId: "req-2",
        slug: "runbooks",
        fromPath: "/tmp/docs",
        sourceKind: "folder",
      }).sourceKind,
    ).toBe("folder");

    expect(() =>
      KnowledgeBaseImportRequestSchema.parse({
        type: "knowledge_base.import.request",
        requestId: "req-2",
        slug: "runbooks",
        fromPath: "/tmp/docs",
      }),
    ).toThrow();
  });

  it("accepts import response with meta or error", () => {
    expect(
      KnowledgeBaseImportResponseSchema.parse({
        type: "knowledge_base.import.response",
        payload: {
          requestId: "req-2",
          knowledgeBase: null,
          meta: null,
          error: "Embeddings disabled. Set localTools.embeddings.enabled=true.",
        },
      }).payload.error,
    ).toMatch(/Embeddings disabled/);
  });

  it("accepts export / delete / mount / unmount / list_mounts / list_usages shapes", () => {
    expect(
      KnowledgeBaseExportRequestSchema.parse({
        type: "knowledge_base.export.request",
        requestId: "req-3",
        idOrSlug: "runbooks",
        outDir: "/tmp/out",
      }).outDir,
    ).toBe("/tmp/out");

    expect(
      KnowledgeBaseDeleteRequestSchema.parse({
        type: "knowledge_base.delete.request",
        requestId: "req-4",
        idOrSlug: "kb_abc",
      }).idOrSlug,
    ).toBe("kb_abc");

    expect(
      KnowledgeBaseDeleteResponseSchema.parse({
        type: "knowledge_base.delete.response",
        payload: {
          requestId: "req-4",
          deleted: null,
          error: "still mounted",
          code: "still_mounted",
          workspaces: [{ workspaceId: "wks_1", title: "feature-auth", mountSlug: "runbooks" }],
        },
      }).payload.code,
    ).toBe("still_mounted");

    expect(
      KnowledgeBaseListMountsRequestSchema.parse({
        type: "knowledge_base.list_mounts.request",
        requestId: "req-5",
        workspaceId: "wks_1",
      }).workspaceId,
    ).toBe("wks_1");

    expect(
      KnowledgeBaseMountRequestSchema.parse({
        type: "knowledge_base.mount.request",
        requestId: "req-6",
        workspaceId: "wks_1",
        idOrSlug: "runbooks",
        mountSlug: "docs",
      }).mountSlug,
    ).toBe("docs");

    expect(
      KnowledgeBaseUnmountRequestSchema.parse({
        type: "knowledge_base.unmount.request",
        requestId: "req-7",
        workspaceId: "wks_1",
        mountSlugOrKbId: "docs",
      }).mountSlugOrKbId,
    ).toBe("docs");

    expect(
      KnowledgeBaseListUsagesRequestSchema.parse({
        type: "knowledge_base.list_usages.request",
        requestId: "req-8",
        idOrSlug: "runbooks",
      }).idOrSlug,
    ).toBe("runbooks");
  });

  it("accepts list_tree / get_page / search shapes", () => {
    expect(
      KnowledgeBaseListTreeRequestSchema.parse({
        type: "knowledge_base.list_tree.request",
        requestId: "req-tree",
        idOrSlug: "runbooks",
      }).idOrSlug,
    ).toBe("runbooks");

    expect(
      KnowledgeBaseListTreeResponseSchema.parse({
        type: "knowledge_base.list_tree.response",
        payload: {
          requestId: "req-tree",
          nodes: [
            { path: "guides", name: "guides", kind: "directory", parentPath: null },
            { path: "guides/b.md", name: "b.md", kind: "file", parentPath: "guides" },
            { path: "a.md", name: "a.md", kind: "file", parentPath: null },
          ],
          error: null,
        },
      }).payload.nodes,
    ).toHaveLength(3);

    expect(
      KnowledgeBaseGetPageRequestSchema.parse({
        type: "knowledge_base.get_page.request",
        requestId: "req-page",
        idOrSlug: "runbooks",
        path: "guides/b.md",
      }).path,
    ).toBe("guides/b.md");

    expect(
      KnowledgeBaseGetPageResponseSchema.parse({
        type: "knowledge_base.get_page.response",
        payload: {
          requestId: "req-page",
          path: "guides/b.md",
          content: "# B\n",
          error: null,
        },
      }).payload.content,
    ).toBe("# B\n");

    expect(
      KnowledgeBaseSearchRequestSchema.parse({
        type: "knowledge_base.search.request",
        requestId: "req-search",
        idOrSlug: "runbooks",
        query: "Alpha",
        mode: "grep",
        limit: 10,
      }).mode,
    ).toBe("grep");

    expect(
      KnowledgeBaseSearchResponseSchema.parse({
        type: "knowledge_base.search.response",
        payload: {
          requestId: "req-search",
          mode: "vector",
          hits: [{ path: "a.md", snippet: "Alpha content.", score: 0.91 }],
          error: null,
        },
      }).payload.hits[0]?.score,
    ).toBe(0.91);
  });

  it("accepts upsert_page / delete_page shapes", () => {
    expect(
      KnowledgeBaseUpsertPageRequestSchema.parse({
        type: "knowledge_base.upsert_page.request",
        requestId: "req-upsert",
        idOrSlug: "runbooks",
        path: "guides/a.md",
        content: "# A\n",
        fromPath: "guides/old.md",
      }).fromPath,
    ).toBe("guides/old.md");

    expect(
      KnowledgeBaseUpsertPageResponseSchema.parse({
        type: "knowledge_base.upsert_page.response",
        payload: { requestId: "req-upsert", path: "guides/a.md", error: null },
      }).payload.path,
    ).toBe("guides/a.md");

    expect(
      KnowledgeBaseDeletePageRequestSchema.parse({
        type: "knowledge_base.delete_page.request",
        requestId: "req-del-page",
        idOrSlug: "runbooks",
        path: "guides/a.md",
      }).path,
    ).toBe("guides/a.md");

    expect(
      KnowledgeBaseDeletePageResponseSchema.parse({
        type: "knowledge_base.delete_page.response",
        payload: { requestId: "req-del-page", path: null, error: "missing" },
      }).payload.error,
    ).toBe("missing");
  });

  it("accepts embeddings detect_ollama / test shapes", () => {
    expect(
      KnowledgeBaseEmbeddingsDetectOllamaRequestSchema.parse({
        type: "knowledge_base.embeddings.detect_ollama.request",
        requestId: "req-detect",
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).toEqual({
      type: "knowledge_base.embeddings.detect_ollama.request",
      requestId: "req-detect",
      baseUrl: "http://127.0.0.1:11434/v1",
    });

    expect(
      KnowledgeBaseEmbeddingsDetectOllamaResponseSchema.parse({
        type: "knowledge_base.embeddings.detect_ollama.response",
        payload: {
          requestId: "req-detect",
          available: true,
          baseUrl: "http://127.0.0.1:11434/v1",
          models: ["qwen3-embedding:0.6b"],
          suggestedModel: "qwen3-embedding:0.6b",
          error: null,
        },
      }).payload.suggestedModel,
    ).toBe("qwen3-embedding:0.6b");

    expect(
      KnowledgeBaseEmbeddingsTestRequestSchema.parse({
        type: "knowledge_base.embeddings.test.request",
        requestId: "req-test",
        enabled: true,
        model: "qwen3-embedding:0.6b",
      }),
    ).toEqual({
      type: "knowledge_base.embeddings.test.request",
      requestId: "req-test",
      enabled: true,
      model: "qwen3-embedding:0.6b",
    });

    expect(
      KnowledgeBaseEmbeddingsTestResponseSchema.parse({
        type: "knowledge_base.embeddings.test.response",
        payload: {
          requestId: "req-test",
          ok: true,
          dimensions: 1024,
          error: null,
        },
      }).payload.dimensions,
    ).toBe(1024);
  });
});
