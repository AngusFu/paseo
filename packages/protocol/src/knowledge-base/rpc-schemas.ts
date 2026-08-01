import { z } from "zod";
import {
  KnowledgeBaseDeleteErrorCodeSchema,
  KnowledgeBaseImportMetaSchema,
  KnowledgeBaseImportSourceKindSchema,
  KnowledgeBaseMountSchema,
  KnowledgeBaseSchema,
  KnowledgeBaseSearchHitSchema,
  KnowledgeBaseSearchModeSchema,
  KnowledgeBaseTreeNodeSchema,
  KnowledgeBaseUsageSchema,
} from "./types.js";

// Knowledge base manage RPCs (docs/rpc-namespacing.md + docs/knowledge-bases-desktop.md).

export const KnowledgeBaseListRequestSchema = z.object({
  type: z.literal("knowledge_base.list.request"),
  requestId: z.string(),
});

export const KnowledgeBaseCreateRequestSchema = z.object({
  type: z.literal("knowledge_base.create.request"),
  requestId: z.string(),
  slug: z.string().min(1),
  name: z.string().optional(),
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

export const KnowledgeBaseListTreeRequestSchema = z.object({
  type: z.literal("knowledge_base.list_tree.request"),
  requestId: z.string(),
  idOrSlug: z.string().min(1),
});

export const KnowledgeBaseGetPageRequestSchema = z.object({
  type: z.literal("knowledge_base.get_page.request"),
  requestId: z.string(),
  idOrSlug: z.string().min(1),
  path: z.string().min(1),
});

export const KnowledgeBaseSearchRequestSchema = z.object({
  type: z.literal("knowledge_base.search.request"),
  requestId: z.string(),
  idOrSlug: z.string().min(1),
  query: z.string().min(1),
  mode: KnowledgeBaseSearchModeSchema,
  /** Optional max hits (grep default 50, vector default 8). */
  limit: z.number().int().positive().optional(),
});

export const KnowledgeBaseUpsertPageRequestSchema = z.object({
  type: z.literal("knowledge_base.upsert_page.request"),
  requestId: z.string(),
  idOrSlug: z.string().min(1),
  /** Destination page path (posix-style; normalized like get_page). */
  path: z.string().min(1),
  /** Full markdown body. */
  content: z.string(),
  /** When set and different from `path`, rename/move: write `path`, remove `fromPath`. */
  fromPath: z.string().min(1).optional(),
});

export const KnowledgeBaseDeletePageRequestSchema = z.object({
  type: z.literal("knowledge_base.delete_page.request"),
  requestId: z.string(),
  idOrSlug: z.string().min(1),
  path: z.string().min(1),
});

/** Probe host Ollama for embedding models (Settings → Host → Knowledge bases). */
export const KnowledgeBaseEmbeddingsDetectOllamaRequestSchema = z.object({
  type: z.literal("knowledge_base.embeddings.detect_ollama.request"),
  requestId: z.string(),
  /** Optional OpenAI-compat or Ollama origin override (default 127.0.0.1:11434). */
  baseUrl: z.string().optional(),
});

/**
 * Tiny embedTexts probe. Omitted fields use effective config
 * (`loadEmbeddingsConfig` = `$PASEO_HOME/config.json` `localTools.embeddings` only).
 */
export const KnowledgeBaseEmbeddingsTestRequestSchema = z.object({
  type: z.literal("knowledge_base.embeddings.test.request"),
  requestId: z.string(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
});

export const KnowledgeBaseListResponseSchema = z.object({
  type: z.literal("knowledge_base.list.response"),
  payload: z.object({
    requestId: z.string(),
    knowledgeBases: z.array(KnowledgeBaseSchema),
    error: z.string().nullable(),
  }),
});

export const KnowledgeBaseCreateResponseSchema = z.object({
  type: z.literal("knowledge_base.create.response"),
  payload: z.object({
    requestId: z.string(),
    knowledgeBase: KnowledgeBaseSchema.nullable(),
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

export const KnowledgeBaseListTreeResponseSchema = z.object({
  type: z.literal("knowledge_base.list_tree.response"),
  payload: z.object({
    requestId: z.string(),
    nodes: z.array(KnowledgeBaseTreeNodeSchema),
    error: z.string().nullable(),
  }),
});

export const KnowledgeBaseGetPageResponseSchema = z.object({
  type: z.literal("knowledge_base.get_page.response"),
  payload: z.object({
    requestId: z.string(),
    path: z.string().nullable(),
    content: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const KnowledgeBaseSearchResponseSchema = z.object({
  type: z.literal("knowledge_base.search.response"),
  payload: z.object({
    requestId: z.string(),
    mode: KnowledgeBaseSearchModeSchema.nullable(),
    hits: z.array(KnowledgeBaseSearchHitSchema),
    error: z.string().nullable(),
  }),
});

export const KnowledgeBaseUpsertPageResponseSchema = z.object({
  type: z.literal("knowledge_base.upsert_page.response"),
  payload: z.object({
    requestId: z.string(),
    path: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const KnowledgeBaseDeletePageResponseSchema = z.object({
  type: z.literal("knowledge_base.delete_page.response"),
  payload: z.object({
    requestId: z.string(),
    path: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const KnowledgeBaseEmbeddingsDetectOllamaResponseSchema = z.object({
  type: z.literal("knowledge_base.embeddings.detect_ollama.response"),
  payload: z.object({
    requestId: z.string(),
    available: z.boolean(),
    /** Suggested OpenAI-compatible `/v1` base URL for the form, or null when unavailable. */
    baseUrl: z.string().nullable(),
    models: z.array(z.string()),
    suggestedModel: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const KnowledgeBaseEmbeddingsTestResponseSchema = z.object({
  type: z.literal("knowledge_base.embeddings.test.response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    dimensions: z.number().int().positive().nullable(),
    error: z.string().nullable(),
  }),
});
