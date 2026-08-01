import { z } from "zod";
import {
  KnowledgeBaseDeleteErrorCodeSchema,
  KnowledgeBaseImportMetaSchema,
  KnowledgeBaseImportSourceKindSchema,
  KnowledgeBaseMountSchema,
  KnowledgeBaseSchema,
  KnowledgeBaseUsageSchema,
} from "./types.js";

// Knowledge base manage RPCs (docs/rpc-namespacing.md + docs/knowledge-bases-desktop.md).

export const KnowledgeBaseListRequestSchema = z.object({
  type: z.literal("knowledge_base.list.request"),
  requestId: z.string(),
});

export const KnowledgeBaseImportRequestSchema = z.object({
  type: z.literal("knowledge_base.import.request"),
  requestId: z.string(),
  slug: z.string().min(1),
  name: z.string().optional(),
  fromPath: z.string().min(1),
  sourceKind: KnowledgeBaseImportSourceKindSchema,
});

export const KnowledgeBaseExportRequestSchema = z.object({
  type: z.literal("knowledge_base.export.request"),
  requestId: z.string(),
  idOrSlug: z.string().min(1),
  outDir: z.string().min(1),
});

export const KnowledgeBaseDeleteRequestSchema = z.object({
  type: z.literal("knowledge_base.delete.request"),
  requestId: z.string(),
  idOrSlug: z.string().min(1),
});

export const KnowledgeBaseListMountsRequestSchema = z.object({
  type: z.literal("knowledge_base.list_mounts.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
});

export const KnowledgeBaseMountRequestSchema = z.object({
  type: z.literal("knowledge_base.mount.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  idOrSlug: z.string().min(1),
  mountSlug: z.string().optional(),
});

export const KnowledgeBaseUnmountRequestSchema = z.object({
  type: z.literal("knowledge_base.unmount.request"),
  requestId: z.string(),
  workspaceId: z.string().min(1),
  mountSlugOrKbId: z.string().min(1),
});

export const KnowledgeBaseListUsagesRequestSchema = z.object({
  type: z.literal("knowledge_base.list_usages.request"),
  requestId: z.string(),
  idOrSlug: z.string().min(1),
});

export const KnowledgeBaseListResponseSchema = z.object({
  type: z.literal("knowledge_base.list.response"),
  payload: z.object({
    requestId: z.string(),
    knowledgeBases: z.array(KnowledgeBaseSchema),
    error: z.string().nullable(),
  }),
});

export const KnowledgeBaseImportResponseSchema = z.object({
  type: z.literal("knowledge_base.import.response"),
  payload: z.object({
    requestId: z.string(),
    knowledgeBase: KnowledgeBaseSchema.nullable(),
    meta: KnowledgeBaseImportMetaSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KnowledgeBaseExportResponseSchema = z.object({
  type: z.literal("knowledge_base.export.response"),
  payload: z.object({
    requestId: z.string(),
    outDir: z.string().nullable(),
    pageCount: z.number().int().nonnegative().nullable(),
    format: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const KnowledgeBaseDeleteResponseSchema = z.object({
  type: z.literal("knowledge_base.delete.response"),
  payload: z.object({
    requestId: z.string(),
    deleted: KnowledgeBaseSchema.nullable(),
    error: z.string().nullable(),
    /** Structured code when delete is refused because mounts remain. */
    code: KnowledgeBaseDeleteErrorCodeSchema.nullable().optional(),
    workspaces: z.array(KnowledgeBaseUsageSchema).optional(),
  }),
});

export const KnowledgeBaseListMountsResponseSchema = z.object({
  type: z.literal("knowledge_base.list_mounts.response"),
  payload: z.object({
    requestId: z.string(),
    mounts: z.array(KnowledgeBaseMountSchema),
    error: z.string().nullable(),
  }),
});

export const KnowledgeBaseMountResponseSchema = z.object({
  type: z.literal("knowledge_base.mount.response"),
  payload: z.object({
    requestId: z.string(),
    mount: KnowledgeBaseMountSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KnowledgeBaseUnmountResponseSchema = z.object({
  type: z.literal("knowledge_base.unmount.response"),
  payload: z.object({
    requestId: z.string(),
    unmounted: KnowledgeBaseMountSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const KnowledgeBaseListUsagesResponseSchema = z.object({
  type: z.literal("knowledge_base.list_usages.response"),
  payload: z.object({
    requestId: z.string(),
    workspaces: z.array(KnowledgeBaseUsageSchema),
    error: z.string().nullable(),
  }),
});
