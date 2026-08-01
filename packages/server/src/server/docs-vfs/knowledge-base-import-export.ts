/**
 * One-shot Knowledge base import / export (Phase 1.6).
 *
 * Import creates a **new** KB id every time — no wipe/replace into an existing kbId.
 * Disk paths and corpus packages are import inputs only (no durable sync link).
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  isCorpusPackageDir,
  readCorpusPackage,
  writeCorpusPackage,
  type CorpusPackageManifest,
} from "./corpus-package.js";
import type { EmbeddingsConfig } from "./embeddings.js";
import { resolvePaseoHomeForDocs } from "./embeddings.js";
import {
  deleteKnowledgeBase,
  docsVfsDirForKnowledgeBase,
  getKnowledgeBase,
  markKnowledgeBaseEmbedded,
  registerImportedKnowledgeBase,
  type KnowledgeBaseRecord,
} from "./knowledge-base-registry.js";
import { buildDocsStore, listAllFileSlugs, readDoc } from "./store.js";
import {
  openDocsVectorStore,
  rebuildDocsVectorStore,
  rebuildDocsVectorStoreFromPages,
  type DocsVectorStoreMeta,
} from "./vector-store.js";

export interface ImportKnowledgeBaseResult {
  knowledgeBase: KnowledgeBaseRecord;
  source: "folder" | "package";
  dir: string;
  dbPath: string;
  meta: DocsVectorStoreMeta;
}

export interface ExportKnowledgeBaseResult {
  knowledgeBase: KnowledgeBaseRecord;
  outDir: string;
  manifest: CorpusPackageManifest;
}

function assertEmbeddingsEnabled(config: EmbeddingsConfig | null | undefined): EmbeddingsConfig {
  if (!config?.enabled) {
    throw new Error("Embeddings disabled. Enable embeddings in Host settings → Knowledge bases.");
  }
  return config;
}

export async function importKnowledgeBase(input: {
  slug: string;
  name?: string;
  from: string;
  paseoHome?: string;
  config: EmbeddingsConfig;
  fetchImpl?: typeof fetch;
  now?: string;
}): Promise<ImportKnowledgeBaseResult> {
  const paseoHome = input.paseoHome ?? resolvePaseoHomeForDocs();
  const config = assertEmbeddingsEnabled(input.config);
  const from = resolve(input.from);
  if (!existsSync(from) || !statSync(from).isDirectory()) {
    throw new Error(`Import source is not a directory: ${from}`);
  }

  // Always new KB — never replace an existing kbId / slug.
  const record = await registerImportedKnowledgeBase({
    slug: input.slug,
    name: input.name,
    importProvenance: from,
    paseoHome,
    now: input.now,
  });

  try {
    if (isCorpusPackageDir(from)) {
      const pack = readCorpusPackage(from);
      const built = await rebuildDocsVectorStoreFromPages({
        pages: pack.pages,
        pathTree: pack.manifest.pathTree,
        paseoHome,
        knowledgeBaseId: record.id,
        config,
        rootDirLabel: `package:${from}`,
        fetchImpl: input.fetchImpl,
      });
      const updated = await markKnowledgeBaseEmbedded({
        id: record.id,
        paseoHome,
        embeddedAt: input.now,
      });
      return {
        knowledgeBase: updated,
        source: "package",
        dir: built.dir,
        dbPath: built.dbPath,
        meta: built.meta,
      };
    }

    const built = await rebuildDocsVectorStore({
      docsRoot: from,
      paseoHome,
      config,
      knowledgeBaseId: record.id,
      fetchImpl: input.fetchImpl,
    });
    const updated = await markKnowledgeBaseEmbedded({
      id: record.id,
      paseoHome,
      embeddedAt: input.now,
    });
    return {
      knowledgeBase: updated,
      source: "folder",
      dir: built.dir,
      dbPath: built.dbPath,
      meta: built.meta,
    };
  } catch (error) {
    // Best-effort cleanup of the registry row if ingest fails mid-way.
    await deleteKnowledgeBase({ idOrSlug: record.id, paseoHome }).catch(() => undefined);
    throw error;
  }
}

export async function exportKnowledgeBase(input: {
  idOrSlug: string;
  outDir: string;
  paseoHome?: string;
  exportedAt?: string;
}): Promise<ExportKnowledgeBaseResult> {
  const paseoHome = input.paseoHome ?? resolvePaseoHomeForDocs();
  const record = await getKnowledgeBase(input.idOrSlug, paseoHome);
  if (!record) throw new Error(`Knowledge base not found: ${input.idOrSlug}`);

  const storeDir = docsVfsDirForKnowledgeBase(paseoHome, record.id);
  const store = openDocsVectorStore(storeDir);
  try {
    const pages = store.pageContents();
    const pathTree = store.pathTree();
    if (Object.keys(pathTree).length === 0 && Object.keys(pages).length === 0) {
      throw new Error(
        `Knowledge base ${record.slug} has no corpus to export. Import or index first.`,
      );
    }
    const manifest = writeCorpusPackage({
      dir: input.outDir,
      slug: record.slug,
      name: record.name,
      knowledgeBaseId: record.id,
      pathTree,
      pages,
      importProvenance: record.importProvenance ?? null,
      exportedAt: input.exportedAt,
    });
    return {
      knowledgeBase: record,
      outDir: resolve(input.outDir),
      manifest,
    };
  } finally {
    await store.close();
  }
}

/** Helper for tests: materialize a docs folder into a page map without embeddings. */
export function readDocsFolderPages(docsRoot: string): Record<string, string> {
  const store = buildDocsStore(docsRoot);
  const pages: Record<string, string> = {};
  for (const slug of listAllFileSlugs(store)) {
    pages[slug] = readDoc(store, slug).content;
  }
  return pages;
}
