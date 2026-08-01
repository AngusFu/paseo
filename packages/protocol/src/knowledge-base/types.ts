import { z } from "zod";

/** Wire shape for a daemon Knowledge base registry row. */
export const KnowledgeBaseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  importedAt: z.string().nullable().optional(),
  lastEmbeddedAt: z.string().nullable().optional(),
  importProvenance: z.string().nullable().optional(),
  /** Present on list when the daemon can count mounts cheaply. */
  mountedWorkspaceCount: z.number().int().nonnegative().optional(),
});

export type KnowledgeBase = z.infer<typeof KnowledgeBaseSchema>;

export const KnowledgeBaseMountSchema = z.object({
  knowledgeBaseId: z.string(),
  mountSlug: z.string(),
  /** Registry slug when known (list_mounts enrichment). */
  slug: z.string().optional(),
  /** Registry display name when known. */
  name: z.string().optional(),
});

export type KnowledgeBaseMount = z.infer<typeof KnowledgeBaseMountSchema>;

export const KnowledgeBaseImportSourceKindSchema = z.enum(["folder", "package"]);

export type KnowledgeBaseImportSourceKind = z.infer<typeof KnowledgeBaseImportSourceKindSchema>;

/** Import result meta (corpus location + embed stats). */
export const KnowledgeBaseImportMetaSchema = z.object({
  source: KnowledgeBaseImportSourceKindSchema,
  dir: z.string(),
  dbPath: z.string(),
  chunkCount: z.number().int().nonnegative(),
  embeddingDims: z.number().int().nonnegative(),
  model: z.string().optional(),
});

export type KnowledgeBaseImportMeta = z.infer<typeof KnowledgeBaseImportMetaSchema>;

/** Workspace that still mounts a KB (delete-blocked UX). */
export const KnowledgeBaseUsageSchema = z.object({
  workspaceId: z.string(),
  title: z.string().nullable().optional(),
  mountSlug: z.string(),
});

export type KnowledgeBaseUsage = z.infer<typeof KnowledgeBaseUsageSchema>;

export const KnowledgeBaseDeleteErrorCodeSchema = z.enum(["still_mounted"]);

export type KnowledgeBaseDeleteErrorCode = z.infer<typeof KnowledgeBaseDeleteErrorCodeSchema>;

/**
 * Flat tree node for Knowledge base detail browse.
 * UI builds a hierarchy from `parentPath` (null = root).
 */
export const KnowledgeBaseTreeNodeSchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(["file", "directory"]),
  parentPath: z.string().nullable(),
});

export type KnowledgeBaseTreeNode = z.infer<typeof KnowledgeBaseTreeNodeSchema>;

/** In-KB search mode: text grep or vector ANN (not cross-KB). */
export const KnowledgeBaseSearchModeSchema = z.enum(["grep", "vector"]);

export type KnowledgeBaseSearchMode = z.infer<typeof KnowledgeBaseSearchModeSchema>;

/** One hit inside a single Knowledge base (path + snippet for detail UI). */
export const KnowledgeBaseSearchHitSchema = z.object({
  path: z.string(),
  snippet: z.string(),
  /** Present for vector mode (higher is better / closer). */
  score: z.number().optional(),
  /** Present for grep mode (1-based line of the snippet). */
  line: z.number().int().positive().optional(),
});

export type KnowledgeBaseSearchHit = z.infer<typeof KnowledgeBaseSearchHitSchema>;
