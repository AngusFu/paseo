/**
 * Thin façade over docs-vfs for Knowledge base WebSocket RPCs.
 * Session handlers call this; do not reimplement the content plane here.
 */

import { resolve } from "node:path";
import type {
  KnowledgeBase,
  KnowledgeBaseImportMeta,
  KnowledgeBaseImportSourceKind,
  KnowledgeBaseMount,
  KnowledgeBaseUsage,
} from "@getpaseo/protocol/knowledge-base/types";
import {
  countKnowledgeBaseMountsById,
  deleteKnowledgeBase,
  exportKnowledgeBase,
  getKnowledgeBase,
  importKnowledgeBase,
  isCorpusPackageDir,
  listKnowledgeBases,
  listKnowledgeBaseUsages,
  listWorkspaceKnowledgeBaseMounts,
  loadEmbeddingsConfig,
  mountKnowledgeBaseOnWorkspace,
  unmountKnowledgeBaseFromWorkspace,
  type KnowledgeBaseRecord,
} from "../docs-vfs/index.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

function toWireKnowledgeBase(
  record: KnowledgeBaseRecord,
  mountedWorkspaceCount?: number,
): KnowledgeBase {
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.importedAt !== undefined ? { importedAt: record.importedAt } : {}),
    ...(record.lastEmbeddedAt !== undefined ? { lastEmbeddedAt: record.lastEmbeddedAt } : {}),
    ...(record.importProvenance !== undefined ? { importProvenance: record.importProvenance } : {}),
    ...(mountedWorkspaceCount !== undefined ? { mountedWorkspaceCount } : {}),
  };
}

export class KnowledgeBaseService {
  constructor(
    private readonly paseoHome: string,
    private readonly workspaceRegistry: WorkspaceRegistry,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async list(): Promise<KnowledgeBase[]> {
    const [records, mountCounts] = await Promise.all([
      listKnowledgeBases(this.paseoHome),
      countKnowledgeBaseMountsById(this.paseoHome, this.workspaceRegistry),
    ]);
    return records.map((record) => toWireKnowledgeBase(record, mountCounts.get(record.id) ?? 0));
  }

  async import(input: {
    slug: string;
    name?: string;
    fromPath: string;
    sourceKind: KnowledgeBaseImportSourceKind;
  }): Promise<{ knowledgeBase: KnowledgeBase; meta: KnowledgeBaseImportMeta }> {
    const fromPath = resolve(input.fromPath);
    const isPackage = isCorpusPackageDir(fromPath);
    if (input.sourceKind === "package" && !isPackage) {
      throw new Error(
        `sourceKind is "package" but ${fromPath} is not a corpus package (expected manifest.json with format paseo.kb.corpus/v1).`,
      );
    }
    if (input.sourceKind === "folder" && isPackage) {
      throw new Error(
        `sourceKind is "folder" but ${fromPath} looks like a corpus package; use sourceKind "package".`,
      );
    }

    const config = loadEmbeddingsConfig({ paseoHome: this.paseoHome });
    if (!config?.enabled) {
      throw new Error(
        "Embeddings disabled. Set localTools.embeddings.enabled=true or PASEO_EMBEDDINGS_ENABLED=1 before importing a Knowledge base.",
      );
    }

    const result = await importKnowledgeBase({
      slug: input.slug,
      name: input.name,
      from: fromPath,
      paseoHome: this.paseoHome,
      config,
      fetchImpl: this.fetchImpl,
    });

    return {
      knowledgeBase: toWireKnowledgeBase(result.knowledgeBase, 0),
      meta: {
        source: result.source,
        dir: result.dir,
        dbPath: result.dbPath,
        chunkCount: result.meta.chunkCount,
        embeddingDims: result.meta.embeddingDims,
        model: result.meta.model,
      },
    };
  }

  async export(input: {
    idOrSlug: string;
    outDir: string;
  }): Promise<{ outDir: string; pageCount: number; format: string }> {
    const result = await exportKnowledgeBase({
      idOrSlug: input.idOrSlug,
      outDir: input.outDir,
      paseoHome: this.paseoHome,
    });
    return {
      outDir: result.outDir,
      pageCount: result.manifest.pageCount,
      format: result.manifest.format,
    };
  }

  async delete(input: {
    idOrSlug: string;
  }): Promise<
    | { ok: true; deleted: KnowledgeBase }
    | { ok: false; code: "still_mounted"; error: string; workspaces: KnowledgeBaseUsage[] }
  > {
    const record = await getKnowledgeBase(input.idOrSlug, this.paseoHome);
    if (!record) {
      throw new Error(`Knowledge base not found: ${input.idOrSlug}`);
    }

    const workspaces = await listKnowledgeBaseUsages(
      record.id,
      this.paseoHome,
      this.workspaceRegistry,
    );
    if (workspaces.length > 0) {
      return {
        ok: false,
        code: "still_mounted",
        error: `Knowledge base ${record.slug} is still mounted on ${workspaces.length} workspace(s). Unmount first.`,
        workspaces,
      };
    }

    const deleted = await deleteKnowledgeBase({
      idOrSlug: record.id,
      paseoHome: this.paseoHome,
    });
    return { ok: true, deleted: toWireKnowledgeBase(deleted, 0) };
  }

  async listMounts(input: { workspaceId: string }): Promise<KnowledgeBaseMount[]> {
    const mounts = await listWorkspaceKnowledgeBaseMounts({
      workspaceId: input.workspaceId,
      paseoHome: this.paseoHome,
      workspaceRegistry: this.workspaceRegistry,
    });
    const enriched: KnowledgeBaseMount[] = [];
    for (const mount of mounts) {
      const kb = await getKnowledgeBase(mount.knowledgeBaseId, this.paseoHome);
      enriched.push({
        knowledgeBaseId: mount.knowledgeBaseId,
        mountSlug: mount.mountSlug,
        ...(kb ? { slug: kb.slug, name: kb.name } : {}),
      });
    }
    return enriched;
  }

  async mount(input: {
    workspaceId: string;
    idOrSlug: string;
    mountSlug?: string;
  }): Promise<KnowledgeBaseMount> {
    const mount = await mountKnowledgeBaseOnWorkspace({
      workspaceId: input.workspaceId,
      knowledgeBaseIdOrSlug: input.idOrSlug,
      mountSlug: input.mountSlug,
      paseoHome: this.paseoHome,
      workspaceRegistry: this.workspaceRegistry,
    });
    const kb = await getKnowledgeBase(mount.knowledgeBaseId, this.paseoHome);
    return {
      knowledgeBaseId: mount.knowledgeBaseId,
      mountSlug: mount.mountSlug,
      ...(kb ? { slug: kb.slug, name: kb.name } : {}),
    };
  }

  async unmount(input: {
    workspaceId: string;
    mountSlugOrKbId: string;
  }): Promise<KnowledgeBaseMount> {
    const mount = await unmountKnowledgeBaseFromWorkspace({
      workspaceId: input.workspaceId,
      mountSlugOrKbId: input.mountSlugOrKbId,
      paseoHome: this.paseoHome,
      workspaceRegistry: this.workspaceRegistry,
    });
    const kb = await getKnowledgeBase(mount.knowledgeBaseId, this.paseoHome);
    return {
      knowledgeBaseId: mount.knowledgeBaseId,
      mountSlug: mount.mountSlug,
      ...(kb ? { slug: kb.slug, name: kb.name } : {}),
    };
  }

  async listUsages(input: { idOrSlug: string }): Promise<KnowledgeBaseUsage[]> {
    const record = await getKnowledgeBase(input.idOrSlug, this.paseoHome);
    if (!record) {
      throw new Error(`Knowledge base not found: ${input.idOrSlug}`);
    }
    return listKnowledgeBaseUsages(record.id, this.paseoHome, this.workspaceRegistry);
  }
}
