import { describe, expect, it } from "vitest";
import { ServerInfoStatusPayloadSchema } from "../messages.js";
import {
  KnowledgeBaseDeleteRequestSchema,
  KnowledgeBaseDeleteResponseSchema,
  KnowledgeBaseExportRequestSchema,
  KnowledgeBaseImportRequestSchema,
  KnowledgeBaseImportResponseSchema,
  KnowledgeBaseListMountsRequestSchema,
  KnowledgeBaseListRequestSchema,
  KnowledgeBaseListResponseSchema,
  KnowledgeBaseListUsagesRequestSchema,
  KnowledgeBaseMountRequestSchema,
  KnowledgeBaseUnmountRequestSchema,
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
});
