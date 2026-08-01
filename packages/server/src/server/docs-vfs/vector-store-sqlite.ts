/**
 * SQLite corpus plane for DocsVectorStore (ChromaFs-shaped).
 *
 * Durable pages / path_tree / chunk text live in `docs.sqlite` via `node:sqlite`.
 * Chunk embeddings are indexed in Chroma (see chroma-vector-index.ts).
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertEmbeddingDimCount } from "./embeddings.js";
import { docsChromaIndexCount, queryDocsChromaIndex } from "./chroma-vector-index.js";
import { DEFAULT_DOCS_MOUNT_SLUG, normalizeSlug, toVirtualPath, type GrepHit } from "./store.js";
import {
  listFromPathTree,
  type DocsChunkRow,
  type DocsVectorStore,
  type DocsVectorStoreMeta,
  type PathTree,
} from "./vector-store.js";

const DB_FILENAME = "docs.sqlite";

function compilePattern(pattern: string, ignoreCase: boolean, fixedStrings: boolean): RegExp {
  const source = fixedStrings ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
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

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS path_tree (
      slug TEXT PRIMARY KEY NOT NULL,
      is_public INTEGER NOT NULL DEFAULT 1,
      groups_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS pages (
      slug TEXT PRIMARY KEY NOT NULL,
      content TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY NOT NULL,
      slug TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      UNIQUE (slug, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS chunks_slug_idx ON chunks(slug);
  `);
}

export function sqliteDbPath(dir: string): string {
  return join(dir, DB_FILENAME);
}

export class SqliteDocsVectorStore implements DocsVectorStore {
  private treeCache: PathTree | null = null;
  private chromaReady = false;

  private constructor(
    private readonly dir: string,
    private readonly db: DatabaseSync,
    private readonly mountSlug: string,
  ) {}

  static open(dir: string, mountSlug = DEFAULT_DOCS_MOUNT_SLUG): SqliteDocsVectorStore {
    const path = sqliteDbPath(dir);
    if (!existsSync(path)) {
      throw new Error(
        `No docs SQLite index at ${path}. Run \`paseo kb index\` or \`paseo kb import\` to ingest.`,
      );
    }
    const db = new DatabaseSync(path);
    ensureSchema(db);
    return new SqliteDocsVectorStore(dir, db, mountSlug);
  }

  static create(
    dir: string,
    meta: DocsVectorStoreMeta,
    tree: PathTree,
    chunks: DocsChunkRow[],
    mountSlug = DEFAULT_DOCS_MOUNT_SLUG,
    pages: Record<string, string> = {},
  ): SqliteDocsVectorStore {
    mkdirSync(dir, { recursive: true });
    const path = sqliteDbPath(dir);
    const db = new DatabaseSync(path);
    ensureSchema(db);

    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM meta; DELETE FROM path_tree; DELETE FROM pages; DELETE FROM chunks;");
      const putMeta = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
      putMeta.run("rootDir", meta.rootDir);
      putMeta.run("model", meta.model);
      putMeta.run("createdAt", meta.createdAt);
      putMeta.run("chunkCount", String(meta.chunkCount));
      putMeta.run("embeddingDims", String(meta.embeddingDims));
      putMeta.run("vectorBackend", "chroma");

      const putTree = db.prepare(
        "INSERT INTO path_tree(slug, is_public, groups_json) VALUES (?, ?, ?)",
      );
      for (const [slug, node] of Object.entries(tree)) {
        putTree.run(slug, node.isPublic === false ? 0 : 1, JSON.stringify(node.groups ?? []));
      }

      const putPage = db.prepare("INSERT INTO pages(slug, content) VALUES (?, ?)");
      for (const [slug, content] of Object.entries(pages)) {
        putPage.run(slug, content);
      }

      // Corpus-only: empty embedding BLOB. Vectors are written to Chroma by rebuild*.
      const putChunk = db.prepare(
        "INSERT INTO chunks(id, slug, chunk_index, text, embedding) VALUES (?, ?, ?, ?, ?)",
      );
      const empty = Buffer.alloc(0);
      for (const chunk of chunks) {
        putChunk.run(chunk.id, chunk.slug, chunk.chunkIndex, chunk.text, empty);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }

    return new SqliteDocsVectorStore(dir, db, mountSlug);
  }

  storeDir(): string {
    return this.dir;
  }

  meta(): DocsVectorStoreMeta {
    const rows = this.db.prepare("SELECT key, value FROM meta").all() as Array<{
      key: string;
      value: string;
    }>;
    const map = new Map(rows.map((row) => [row.key, row.value]));
    const embeddingDims = Number(map.get("embeddingDims") ?? 0);
    return {
      rootDir: map.get("rootDir") ?? "",
      model: map.get("model") ?? "",
      createdAt: map.get("createdAt") ?? "",
      chunkCount: Number(map.get("chunkCount") ?? 0),
      embeddingDims: Number.isFinite(embeddingDims) ? embeddingDims : 0,
    };
  }

  pathTree(): PathTree {
    if (this.treeCache) return this.treeCache;
    const rows = this.db
      .prepare("SELECT slug, is_public, groups_json FROM path_tree")
      .all() as Array<{ slug: string; is_public: number; groups_json: string }>;
    const tree: PathTree = {};
    for (const row of rows) {
      tree[row.slug] = {
        isPublic: row.is_public !== 0,
        groups: JSON.parse(row.groups_json) as string[],
      };
    }
    this.treeCache = tree;
    return tree;
  }

  list(pathInput = ""): string[] {
    return listFromPathTree(this.pathTree(), pathInput, this.mountSlug);
  }

  pageContents(): Record<string, string> {
    const pageRows = this.db.prepare("SELECT slug, content FROM pages").all() as Array<{
      slug: string;
      content: string;
    }>;
    const pages: Record<string, string> = {};
    for (const row of pageRows) pages[row.slug] = row.content;
    return pages;
  }

  async cat(pathInput: string): Promise<{ slug: string; content: string }> {
    const slug = normalizeSlug(pathInput);
    const page = this.db.prepare("SELECT slug, content FROM pages WHERE slug = ?").get(slug) as
      | { slug: string; content: string }
      | undefined;
    if (page) return { slug: page.slug, content: page.content };

    const allSlugs = (
      this.db.prepare("SELECT slug FROM pages").all() as Array<{ slug: string }>
    ).map((row) => row.slug);
    const stems = allSlugs.filter((key) => {
      const base = key.split("/").pop() ?? key;
      const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
      return base === slug || stem === slug || key === slug;
    });
    if (stems.length === 1) return this.cat(stems[0]!);
    throw new Error(`No such document in vector store: ${toVirtualPath(slug, this.mountSlug)}`);
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

    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    const useLike = fixedStrings || !/[.\\+*?()[\]{}^$|]/.test(pattern);
    let candidateSlugs: string[];

    if (useLike) {
      const like = `%${needle.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      const rows = this.db
        .prepare(
          ignoreCase
            ? "SELECT DISTINCT slug FROM chunks WHERE lower(text) LIKE ? ESCAPE '\\'"
            : "SELECT DISTINCT slug FROM chunks WHERE text LIKE ? ESCAPE '\\'",
        )
        .all(like) as Array<{ slug: string }>;
      candidateSlugs = rows
        .map((row) => row.slug)
        .filter((slug) => slugInPaths(slug, options.paths));
    } else {
      const rows = this.db.prepare("SELECT slug, text FROM chunks").all() as Array<{
        slug: string;
        text: string;
      }>;
      const set = new Set<string>();
      for (const row of rows) {
        if (!slugInPaths(row.slug, options.paths)) continue;
        if (regex.test(row.text)) set.add(row.slug);
        regex.lastIndex = 0;
      }
      candidateSlugs = [...set];
    }

    const hits: GrepHit[] = [];
    for (const slug of candidateSlugs.sort((a, b) => a.localeCompare(b))) {
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

  private async ensureChromaIndex(): Promise<void> {
    if (this.chromaReady) return;
    const count = await docsChromaIndexCount(this.dir);
    if (count <= 0) {
      throw new Error(
        `No Chroma vector index for ${this.dir}. Re-run \`paseo kb index\` / \`paseo kb import\` to rebuild embeddings.`,
      );
    }
    this.chromaReady = true;
  }

  async search(
    queryEmbedding: number[],
    options: { limit?: number } = {},
  ): Promise<Array<{ slug: string; chunkIndex: number; score: number; text: string }>> {
    const dims = this.meta().embeddingDims;
    if (dims > 0) assertEmbeddingDimCount(queryEmbedding, dims, "query vs index");
    await this.ensureChromaIndex();
    return queryDocsChromaIndex({
      storeDir: this.dir,
      queryEmbedding,
      limit: options.limit,
      expectedDims: dims > 0 ? dims : undefined,
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
