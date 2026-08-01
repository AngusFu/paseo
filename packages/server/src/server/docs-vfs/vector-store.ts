/**
 * ChromaFs-shaped content plane.
 *
 * Mintlify: UNIX ops → Chroma queries (path_tree + chunks by slug + coarse grep).
 * Paseo: corpus in SQLite (`docs.sqlite`) + chunk vectors in local Chroma
 * (`$PASEO_HOME/docs-vfs/_chroma/`, collection per store key).
 * MemoryDocsVectorStore remains for unit tests / ingest staging (in-memory cosine).
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  assertEmbeddingDimCount,
  cosineSimilarity,
  embedTexts,
  type EmbeddingsConfig,
} from "./embeddings.js";
import {
  buildDocsStore,
  chunkDoc,
  listAllFileSlugs,
  DEFAULT_DOCS_MOUNT_SLUG,
  normalizeSlug,
  readDoc,
  toVirtualPath,
  type DocsStore,
  type GrepHit,
} from "./store.js";
import { docsVfsDirForKnowledgeBase } from "./knowledge-base-registry.js";
import {
  chromaCollectionNameForStoreKey,
  replaceDocsChromaIndex,
  storeKeyFromStoreDir,
} from "./chroma-vector-index.js";
import { docsChromaDataDir } from "./chroma-sidecar.js";
import { SqliteDocsVectorStore, sqliteDbPath } from "./vector-store-sqlite.js";

export const PATH_TREE_DOC_ID = "__path_tree__";

export interface PathTreeNode {
  isPublic?: boolean;
  groups?: string[];
}

/** Mintlify-style path tree: slug → ACL metadata (we store empty ACL for dogfood). */
export type PathTree = Record<string, PathTreeNode>;

export interface DocsChunkRow {
  id: string;
  slug: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
}

export interface DocsVectorStoreMeta {
  rootDir: string;
  model: string;
  createdAt: string;
  chunkCount: number;
  /** Length of each chunk embedding; search rejects mismatched query vectors. */
  embeddingDims: number;
}

export interface DocsVectorStore {
  meta(): DocsVectorStoreMeta;
  pathTree(): PathTree;
  /** Original page text by slug (export / self-contained corpus). */
  pageContents(): Record<string, string>;
  list(pathInput?: string): string[];
  cat(pathInput: string): Promise<{ slug: string; content: string }>;
  grep(
    pattern: string,
    options?: {
      paths?: string[];
      ignoreCase?: boolean;
      fixedStrings?: boolean;
      maxHits?: number;
    },
  ): Promise<GrepHit[]>;
  search(
    queryEmbedding: number[],
    options?: { limit?: number },
  ): Promise<Array<{ slug: string; chunkIndex: number; score: number; text: string }>>;
  close(): Promise<void>;
}

/** Dogfood `--root` index dir (hash of root+model). Prefer `docsVfsDirForKnowledgeBase` for registered KBs. */
export function docsVfsDir(paseoHome: string, rootDir: string, model: string): string {
  const key = createHash("sha256").update(`${rootDir}\0${model}`).digest("hex").slice(0, 16);
  return join(paseoHome, "docs-vfs", key);
}

export function buildPathTreeFromStore(store: DocsStore): PathTree {
  const tree: PathTree = {};
  for (const slug of listAllFileSlugs(store)) {
    tree[slug] = { isPublic: true, groups: [] };
  }
  return tree;
}

export function listFromPathTree(
  tree: PathTree,
  pathInput = "",
  mountSlug = DEFAULT_DOCS_MOUNT_SLUG,
): string[] {
  const slug = normalizeSlug(pathInput);
  const fileSlugs = Object.keys(tree).sort((a, b) => a.localeCompare(b));
  if (slug && tree[slug]) {
    return [toVirtualPath(slug, mountSlug)];
  }

  const children = new Set<string>();
  const prefix = slug ? `${slug}/` : "";
  for (const fileSlug of fileSlugs) {
    if (slug && !fileSlug.startsWith(prefix) && fileSlug !== slug) continue;
    const rest = slug ? fileSlug.slice(prefix.length) : fileSlug;
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      children.add(rest);
    } else {
      children.add(`${rest.slice(0, slash)}/`);
    }
  }
  if (children.size === 0 && slug) {
    throw new Error(`No such path in virtual docs: ${toVirtualPath(slug, mountSlug)}`);
  }
  return [...children].sort((a, b) => a.localeCompare(b));
}

function escapeRegex(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compilePattern(pattern: string, ignoreCase: boolean, fixedStrings: boolean): RegExp {
  const source = fixedStrings ? escapeRegex(pattern) : pattern;
  try {
    return new RegExp(source, ignoreCase ? "i" : "");
  } catch (error) {
    throw new Error(
      `Invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function slugInPaths(slug: string, paths: string[] | undefined): boolean {
  if (!paths || paths.length === 0) return true;
  for (const raw of paths) {
    const prefix = normalizeSlug(raw);
    if (!prefix) return true;
    if (slug === prefix || slug.startsWith(`${prefix}/`)) return true;
  }
  return false;
}

/** In-memory staging store — same query model; used for ingest + unit tests. */
export class MemoryDocsVectorStore implements DocsVectorStore {
  private constructor(
    private readonly metaValue: DocsVectorStoreMeta,
    private readonly tree: PathTree,
    private readonly chunks: DocsChunkRow[],
    private readonly pages: Record<string, string>,
    private readonly mountSlug: string,
  ) {}

  static fromChunks(
    meta: DocsVectorStoreMeta,
    tree: PathTree,
    chunks: DocsChunkRow[],
    mountSlug = DEFAULT_DOCS_MOUNT_SLUG,
    pages: Record<string, string> = {},
  ): MemoryDocsVectorStore {
    return new MemoryDocsVectorStore(meta, tree, chunks, pages, mountSlug);
  }

  rows(): DocsChunkRow[] {
    return this.chunks;
  }

  pageMap(): Record<string, string> {
    return this.pages;
  }

  meta(): DocsVectorStoreMeta {
    return this.metaValue;
  }

  pathTree(): PathTree {
    return this.tree;
  }

  pageContents(): Record<string, string> {
    if (Object.keys(this.pages).length > 0) return { ...this.pages };
    const pages: Record<string, string> = {};
    const bySlug = new Map<string, DocsChunkRow[]>();
    for (const row of this.chunks) {
      const list = bySlug.get(row.slug) ?? [];
      list.push(row);
      bySlug.set(row.slug, list);
    }
    for (const [slug, rows] of bySlug) {
      pages[slug] = rows
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map((row) => row.text)
        .join("\n\n");
    }
    return pages;
  }

  list(pathInput = ""): string[] {
    return listFromPathTree(this.tree, pathInput, this.mountSlug);
  }

  async cat(pathInput: string): Promise<{ slug: string; content: string }> {
    const slug = normalizeSlug(pathInput);
    if (this.pages[slug] !== undefined) {
      return { slug, content: this.pages[slug]! };
    }
    const rows = this.chunks
      .filter((row) => row.slug === slug)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
    if (rows.length === 0) {
      // stem match like FS store
      const stems = [
        ...new Set([...Object.keys(this.pages), ...this.chunks.map((row) => row.slug)]),
      ].filter((key) => {
        const base = key.split("/").pop() ?? key;
        const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
        return base === slug || stem === slug || key === slug;
      });
      if (stems.length === 1) {
        return this.cat(stems[0]!);
      }
      throw new Error(`No such document in vector store: ${toVirtualPath(slug, this.mountSlug)}`);
    }
    return { slug: rows[0]!.slug, content: rows.map((row) => row.text).join("\n\n") };
  }

  async grep(
    pattern: string,
    options: {
      paths?: string[];
      ignoreCase?: boolean;
      fixedStrings?: boolean;
      maxHits?: number;
    } = {},
  ): Promise<GrepHit[]> {
    const ignoreCase = Boolean(options.ignoreCase);
    const fixedStrings = Boolean(options.fixedStrings);
    const regex = compilePattern(pattern, ignoreCase, fixedStrings);
    const maxHits = options.maxHits ?? 200;
    const hits: GrepHit[] = [];

    // Coarse filter (Mintlify $contains / chunk prefilter): which pages might hit.
    const candidateSlugs = new Set<string>();
    for (const row of this.chunks) {
      if (!slugInPaths(row.slug, options.paths)) continue;
      if (fixedStrings) {
        const hay = ignoreCase ? row.text.toLowerCase() : row.text;
        const needle = ignoreCase ? pattern.toLowerCase() : pattern;
        if (hay.includes(needle)) candidateSlugs.add(row.slug);
        continue;
      }
      if (regex.test(row.text)) candidateSlugs.add(row.slug);
      regex.lastIndex = 0;
    }

    // Fine filter: reassemble page (chunk_index order) and line-grep.
    const slugs = [...candidateSlugs].sort((a, b) => a.localeCompare(b));
    for (const slug of slugs) {
      const { content } = await this.cat(slug);
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!regex.test(line)) {
          regex.lastIndex = 0;
          continue;
        }
        regex.lastIndex = 0;
        hits.push({ slug, line: i + 1, text: line });
        if (hits.length >= maxHits) return hits;
      }
    }
    return hits;
  }

  async search(
    queryEmbedding: number[],
    options: { limit?: number } = {},
  ): Promise<Array<{ slug: string; chunkIndex: number; score: number; text: string }>> {
    const dims = this.metaValue.embeddingDims || this.chunks[0]?.embedding.length || 0;
    if (dims > 0) assertEmbeddingDimCount(queryEmbedding, dims, "query vs index");
    const ranked = this.chunks
      .map((chunk) => ({
        slug: chunk.slug,
        chunkIndex: chunk.chunkIndex,
        score: cosineSimilarity(queryEmbedding, chunk.embedding),
        text: chunk.text,
      }))
      .sort((a, b) => b.score - a.score);
    return ranked.slice(0, options.limit ?? 8);
  }

  async close(): Promise<void> {
    // no-op
  }
}

async function embedPendingChunks(options: {
  pending: Array<{ slug: string; chunkIndex: number; text: string }>;
  config: EmbeddingsConfig;
  fetchImpl?: typeof fetch;
  batchSize?: number;
}): Promise<DocsChunkRow[]> {
  const batchSize = options.batchSize ?? 16;
  const fetchImpl = options.fetchImpl ?? fetch;
  const chunks: DocsChunkRow[] = [];
  for (let i = 0; i < options.pending.length; i += batchSize) {
    const batch = options.pending.slice(i, i + batchSize);
    const vectors = await embedTexts(
      options.config,
      batch.map((item) => item.text),
      fetchImpl,
    );
    for (let j = 0; j < batch.length; j++) {
      const item = batch[j]!;
      chunks.push({
        id: `${item.slug}#${item.chunkIndex}`,
        slug: item.slug,
        chunkIndex: item.chunkIndex,
        text: item.text,
        embedding: vectors[j]!,
      });
    }
  }
  return chunks;
}

export async function ingestDocsToMemoryStore(options: {
  store: DocsStore;
  config: EmbeddingsConfig;
  fetchImpl?: typeof fetch;
  batchSize?: number;
}): Promise<MemoryDocsVectorStore> {
  const pending: Array<{ slug: string; chunkIndex: number; text: string }> = [];
  const pages: Record<string, string> = {};
  for (const slug of listAllFileSlugs(options.store)) {
    const content = readDoc(options.store, slug).content;
    pages[slug] = content;
    pending.push(...chunkDoc(content, slug));
  }

  const chunks = await embedPendingChunks({
    pending,
    config: options.config,
    fetchImpl: options.fetchImpl,
    batchSize: options.batchSize,
  });

  const embeddingDims = chunks[0]?.embedding.length ?? 0;
  for (const chunk of chunks) {
    assertEmbeddingDimCount(chunk.embedding, embeddingDims, `chunk ${chunk.id}`);
  }
  const meta: DocsVectorStoreMeta = {
    rootDir: options.store.rootDir,
    model: options.config.model,
    createdAt: new Date().toISOString(),
    chunkCount: chunks.length,
    embeddingDims,
  };
  return MemoryDocsVectorStore.fromChunks(
    meta,
    buildPathTreeFromStore(options.store),
    chunks,
    DEFAULT_DOCS_MOUNT_SLUG,
    pages,
  );
}

/** Ingest an in-memory page map (corpus package / imported corpus) into a staging store. */
export async function ingestPagesToMemoryStore(options: {
  pages: Record<string, string>;
  pathTree?: PathTree;
  config: EmbeddingsConfig;
  rootDirLabel?: string;
  fetchImpl?: typeof fetch;
  batchSize?: number;
}): Promise<MemoryDocsVectorStore> {
  const slugs = Object.keys(options.pages).sort((a, b) => a.localeCompare(b));
  const pending: Array<{ slug: string; chunkIndex: number; text: string }> = [];
  for (const slug of slugs) {
    pending.push(...chunkDoc(options.pages[slug]!, slug));
  }

  const chunks = await embedPendingChunks({
    pending,
    config: options.config,
    fetchImpl: options.fetchImpl,
    batchSize: options.batchSize,
  });

  const embeddingDims = chunks[0]?.embedding.length ?? 0;
  for (const chunk of chunks) {
    assertEmbeddingDimCount(chunk.embedding, embeddingDims, `chunk ${chunk.id}`);
  }

  const tree: PathTree =
    options.pathTree ??
    Object.fromEntries(slugs.map((slug) => [slug, { isPublic: true, groups: [] as string[] }]));

  const meta: DocsVectorStoreMeta = {
    rootDir: options.rootDirLabel ?? "imported-corpus",
    model: options.config.model,
    createdAt: new Date().toISOString(),
    chunkCount: chunks.length,
    embeddingDims,
  };
  return MemoryDocsVectorStore.fromChunks(
    meta,
    tree,
    chunks,
    DEFAULT_DOCS_MOUNT_SLUG,
    options.pages,
  );
}

export function openDocsVectorStore(
  dir: string,
  options?: { mountSlug?: string },
): DocsVectorStore {
  return SqliteDocsVectorStore.open(dir, options?.mountSlug ?? DEFAULT_DOCS_MOUNT_SLUG);
}

export interface RebuildDocsVectorStoreResult {
  dir: string;
  meta: DocsVectorStoreMeta;
  /** Corpus SQLite path (pages / path_tree / chunk text). */
  dbPath: string;
  /** Shared Chroma persistence dir for this Paseo home. */
  chromaPath: string;
  /** Chroma collection name for this store key. */
  chromaCollection: string;
}

async function persistMemoryStore(options: {
  dir: string;
  paseoHome: string;
  memory: MemoryDocsVectorStore;
}): Promise<RebuildDocsVectorStoreResult> {
  const store = SqliteDocsVectorStore.create(
    options.dir,
    options.memory.meta(),
    options.memory.pathTree(),
    options.memory.rows(),
    DEFAULT_DOCS_MOUNT_SLUG,
    options.memory.pageMap(),
  );
  await store.close();
  const chroma = await replaceDocsChromaIndex({
    storeDir: options.dir,
    chunks: options.memory.rows(),
  });
  return {
    dir: options.dir,
    meta: options.memory.meta(),
    dbPath: sqliteDbPath(options.dir),
    chromaPath: docsChromaDataDir(options.paseoHome),
    chromaCollection: chroma.collectionName,
  };
}

export async function rebuildDocsVectorStore(options: {
  docsRoot: string;
  paseoHome: string;
  config: EmbeddingsConfig;
  /** When set, write under `docs-vfs/<kbId>/` instead of the dogfood hash key. */
  knowledgeBaseId?: string;
  fetchImpl?: typeof fetch;
}): Promise<RebuildDocsVectorStoreResult> {
  const fsStore = buildDocsStore(options.docsRoot);
  const memory = await ingestDocsToMemoryStore({
    store: fsStore,
    config: options.config,
    fetchImpl: options.fetchImpl,
  });
  const dir = options.knowledgeBaseId
    ? docsVfsDirForKnowledgeBase(options.paseoHome, options.knowledgeBaseId)
    : docsVfsDir(options.paseoHome, fsStore.rootDir, options.config.model);
  return persistMemoryStore({ dir, paseoHome: options.paseoHome, memory });
}

export async function rebuildDocsVectorStoreFromPages(options: {
  pages: Record<string, string>;
  pathTree?: PathTree;
  paseoHome: string;
  knowledgeBaseId: string;
  config: EmbeddingsConfig;
  rootDirLabel?: string;
  fetchImpl?: typeof fetch;
}): Promise<RebuildDocsVectorStoreResult> {
  const memory = await ingestPagesToMemoryStore({
    pages: options.pages,
    pathTree: options.pathTree,
    config: options.config,
    rootDirLabel: options.rootDirLabel,
    fetchImpl: options.fetchImpl,
  });
  const dir = docsVfsDirForKnowledgeBase(options.paseoHome, options.knowledgeBaseId);
  return persistMemoryStore({ dir, paseoHome: options.paseoHome, memory });
}

export function chromaCollectionForStoreDir(storeDir: string): string {
  return chromaCollectionNameForStoreKey(storeKeyFromStoreDir(storeDir));
}
