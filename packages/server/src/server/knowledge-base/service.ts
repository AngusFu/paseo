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
  KnowledgeBaseSearchHit,
  KnowledgeBaseSearchMode,
  KnowledgeBaseTreeNode,
  KnowledgeBaseUsage,
} from "@getpaseo/protocol/knowledge-base/types";
import {
  countKnowledgeBaseMountsById,
  createEmptyKnowledgeBase,
  deleteKnowledgeBase,
  deleteKnowledgeBasePage,
  docsVfsDirForKnowledgeBase,
  embedTexts,
  exportKnowledgeBase,
  getKnowledgeBase,
  importKnowledgeBase,
  isCorpusPackageDir,
  listKnowledgeBases,
  listKnowledgeBaseUsages,
  listWorkspaceKnowledgeBaseMounts,
  loadEmbeddingsConfig,
  mountKnowledgeBaseOnWorkspace,
  openDocsVectorStore,
  unmountKnowledgeBaseFromWorkspace,
  upsertKnowledgeBasePage,
  type DocsVectorStore,
  type KnowledgeBaseRecord,
  type PathTree,
} from "../docs-vfs/index.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

const DEFAULT_GREP_SEARCH_LIMIT = 50;
const DEFAULT_VECTOR_SEARCH_LIMIT = 8;
const SNIPPET_MAX_CHARS = 240;

function basenameOfPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Build flat UI tree nodes from path_tree page slugs (files + intermediate dirs). */
export function treeNodesFromPathTree(pathTree: PathTree): KnowledgeBaseTreeNode[] {
  const pages = Object.keys(pathTree).sort((a, b) => a.localeCompare(b));
  const dirPaths = new Set<string>();
  for (const page of pages) {
    const parts = page.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirPaths.add(parts.slice(0, i).join("/"));
    }
  }

  const nodes: KnowledgeBaseTreeNode[] = [];
  for (const dir of [...dirPaths].sort((a, b) => a.localeCompare(b))) {
    const slash = dir.lastIndexOf("/");
    nodes.push({
      path: dir,
      name: slash === -1 ? dir : dir.slice(slash + 1),
      kind: "directory",
      parentPath: slash === -1 ? null : dir.slice(0, slash),
    });
  }
  for (const page of pages) {
    const slash = page.lastIndexOf("/");
    nodes.push({
      path: page,
      name: slash === -1 ? page : page.slice(slash + 1),
      kind: "file",
      parentPath: slash === -1 ? null : page.slice(0, slash),
    });
  }
  return nodes;
}

function clipSnippet(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= SNIPPET_MAX_CHARS) return compact;
  return `${compact.slice(0, SNIPPET_MAX_CHARS - 1)}…`;
}

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

  async create(input: { slug: string; name?: string }): Promise<KnowledgeBase> {
    const record = await createEmptyKnowledgeBase({
      slug: input.slug,
      name: input.name,
      paseoHome: this.paseoHome,
    });
    return toWireKnowledgeBase(record, 0);
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
        "Embeddings disabled. Enable embeddings in Host settings → Knowledge bases before importing a Knowledge base.",
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

  private async openStore(idOrSlug: string): Promise<{
    record: KnowledgeBaseRecord;
    store: DocsVectorStore;
  }> {
    const record = await getKnowledgeBase(idOrSlug, this.paseoHome);
    if (!record) {
      throw new Error(`Knowledge base not found: ${idOrSlug}`);
    }
    const store = openDocsVectorStore(docsVfsDirForKnowledgeBase(this.paseoHome, record.id), {
      mountSlug: record.slug,
    });
    return { record, store };
  }

  async listTree(input: { idOrSlug: string }): Promise<KnowledgeBaseTreeNode[]> {
    const { store } = await this.openStore(input.idOrSlug);
    try {
      return treeNodesFromPathTree(store.pathTree());
    } finally {
      await store.close();
    }
  }

  async getPage(input: {
    idOrSlug: string;
    path: string;
  }): Promise<{ path: string; content: string }> {
    const { store } = await this.openStore(input.idOrSlug);
    try {
      const page = await store.cat(input.path);
      return { path: page.slug, content: page.content };
    } finally {
      await store.close();
    }
  }

  async upsertPage(input: {
    idOrSlug: string;
    path: string;
    content: string;
    fromPath?: string;
  }): Promise<{ path: string }> {
    return upsertKnowledgeBasePage({
      idOrSlug: input.idOrSlug,
      path: input.path,
      content: input.content,
      ...(input.fromPath !== undefined ? { fromPath: input.fromPath } : {}),
      paseoHome: this.paseoHome,
      fetchImpl: this.fetchImpl,
    });
  }

  async deletePage(input: { idOrSlug: string; path: string }): Promise<{ path: string }> {
    return deleteKnowledgeBasePage({
      idOrSlug: input.idOrSlug,
      path: input.path,
      paseoHome: this.paseoHome,
    });
  }

  async search(input: {
    idOrSlug: string;
    query: string;
    mode: KnowledgeBaseSearchMode;
    limit?: number;
  }): Promise<{ mode: KnowledgeBaseSearchMode; hits: KnowledgeBaseSearchHit[] }> {
    const query = input.query.trim();
    if (!query) {
      throw new Error("Search query must not be empty");
    }

    const { store } = await this.openStore(input.idOrSlug);
    try {
      if (input.mode === "grep") {
        const limit = input.limit ?? DEFAULT_GREP_SEARCH_LIMIT;
        const hits = await this.searchGrep(store, query, limit);
        return { mode: "grep", hits };
      }

      const limit = input.limit ?? DEFAULT_VECTOR_SEARCH_LIMIT;
      const hits = await this.searchVector(store, query, limit);
      return { mode: "vector", hits };
    } finally {
      await store.close();
    }
  }

  private async searchGrep(
    store: DocsVectorStore,
    query: string,
    limit: number,
  ): Promise<KnowledgeBaseSearchHit[]> {
    const hits: KnowledgeBaseSearchHit[] = [];
    const seen = new Set<string>();
    const needle = query.toLowerCase();

    // Prefer path/title matches so empty-content path hits still surface.
    for (const slug of Object.keys(store.pathTree()).sort((a, b) => a.localeCompare(b))) {
      if (hits.length >= limit) break;
      const name = basenameOfPath(slug).toLowerCase();
      if (!slug.toLowerCase().includes(needle) && !name.includes(needle)) continue;
      seen.add(slug);
      hits.push({
        path: slug,
        snippet: slug,
      });
    }

    if (hits.length >= limit) return hits;

    const grepHits = await store.grep(query, {
      ignoreCase: true,
      fixedStrings: true,
      maxHits: limit * 4,
    });
    for (const hit of grepHits) {
      if (seen.has(hit.slug)) continue;
      seen.add(hit.slug);
      hits.push({
        path: hit.slug,
        snippet: clipSnippet(hit.text),
        line: hit.line,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  private async searchVector(
    store: DocsVectorStore,
    query: string,
    limit: number,
  ): Promise<KnowledgeBaseSearchHit[]> {
    const config = loadEmbeddingsConfig({ paseoHome: this.paseoHome });
    if (!config?.enabled) {
      throw new Error(
        "Embeddings disabled. Enable embeddings in Host settings → Knowledge bases before vector search.",
      );
    }
    const [queryVec] = await embedTexts(config, [query], this.fetchImpl);
    if (!queryVec) {
      throw new Error("Empty embedding for query");
    }
    const results = await store.search(queryVec, { limit: Math.max(limit * 3, limit) });
    const bestByPath = new Map<string, KnowledgeBaseSearchHit>();
    for (const row of results) {
      const existing = bestByPath.get(row.slug);
      if (existing?.score !== undefined && existing.score >= row.score) continue;
      bestByPath.set(row.slug, {
        path: row.slug,
        snippet: clipSnippet(row.text),
        score: row.score,
      });
    }
    return [...bestByPath.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  }
}
