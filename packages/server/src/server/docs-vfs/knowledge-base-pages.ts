/**
 * In-KB page authoring (upsert / rename-move / delete) against the SQLite corpus
 * + optional Chroma embedding refresh. Agents remain read-only via VFS.
 */

import { assertValidPageSlug, chunkDoc } from "./store.js";
import { deleteDocsChromaChunkIds, upsertDocsChromaChunks } from "./chroma-vector-index.js";
import { embedTexts, loadEmbeddingsConfig, type EmbeddingsConfig } from "./embeddings.js";
import {
  docsVfsDirForKnowledgeBase,
  getKnowledgeBase,
  markKnowledgeBaseEmbedded,
  touchKnowledgeBase,
  type KnowledgeBaseRecord,
} from "./knowledge-base-registry.js";
import { SqliteDocsVectorStore } from "./vector-store-sqlite.js";
import type { DocsChunkRow } from "./vector-store.js";

async function embedPageChunks(options: {
  pending: Array<{ slug: string; chunkIndex: number; text: string }>;
  config: EmbeddingsConfig;
  fetchImpl: typeof fetch;
}): Promise<DocsChunkRow[]> {
  if (options.pending.length === 0) return [];
  const vectors = await embedTexts(
    options.config,
    options.pending.map((item) => item.text),
    options.fetchImpl,
  );
  return options.pending.map((item, index) => ({
    id: `${item.slug}#${item.chunkIndex}`,
    slug: item.slug,
    chunkIndex: item.chunkIndex,
    text: item.text,
    embedding: vectors[index]!,
  }));
}

function chunksWithoutEmbeddings(
  pending: Array<{ slug: string; chunkIndex: number; text: string }>,
): DocsChunkRow[] {
  return pending.map((item) => ({
    id: `${item.slug}#${item.chunkIndex}`,
    slug: item.slug,
    chunkIndex: item.chunkIndex,
    text: item.text,
    embedding: [],
  }));
}

async function openStoreForKb(
  idOrSlug: string,
  paseoHome: string,
): Promise<{ record: KnowledgeBaseRecord; store: SqliteDocsVectorStore }> {
  const record = await getKnowledgeBase(idOrSlug, paseoHome);
  if (!record) {
    throw new Error(`Knowledge base not found: ${idOrSlug}`);
  }
  const store = SqliteDocsVectorStore.open(
    docsVfsDirForKnowledgeBase(paseoHome, record.id),
    record.slug,
  );
  return { record, store };
}

export async function upsertKnowledgeBasePage(input: {
  idOrSlug: string;
  path: string;
  content: string;
  fromPath?: string;
  paseoHome: string;
  fetchImpl?: typeof fetch;
}): Promise<{ path: string }> {
  const path = assertValidPageSlug(input.path);
  const fromPath =
    input.fromPath !== undefined && input.fromPath.trim() !== ""
      ? assertValidPageSlug(input.fromPath)
      : undefined;
  const rename = fromPath !== undefined && fromPath !== path;
  const fetchImpl = input.fetchImpl ?? fetch;

  const { record, store } = await openStoreForKb(input.idOrSlug, input.paseoHome);
  try {
    if (rename && !store.hasPage(fromPath)) {
      throw new Error(`No such document in vector store: ${fromPath}`);
    }

    const pending = chunkDoc(input.content, path);
    const config = loadEmbeddingsConfig({ paseoHome: input.paseoHome });
    const embedEnabled = Boolean(config?.enabled);

    let chunks: DocsChunkRow[];
    if (embedEnabled && config && pending.length > 0) {
      chunks = await embedPageChunks({ pending, config, fetchImpl });
    } else {
      chunks = chunksWithoutEmbeddings(pending);
    }

    const staleIds = new Set<string>(store.listChunkIdsForSlug(path));
    if (rename) {
      for (const id of store.listChunkIdsForSlug(fromPath)) staleIds.add(id);
    }

    store.upsertPageCorpus({ slug: path, content: input.content, chunks });
    if (rename) {
      store.deletePageCorpus(fromPath);
    }

    const newIds = new Set(chunks.map((chunk) => chunk.id));
    const removeIds = [...staleIds].filter((id) => !newIds.has(id));

    if (embedEnabled && config && chunks.length > 0 && chunks[0]!.embedding.length > 0) {
      store.setEmbeddingMeta({
        model: config.model,
        embeddingDims: chunks[0]!.embedding.length,
      });
      await upsertDocsChromaChunks({ storeDir: store.storeDir(), chunks });
      await deleteDocsChromaChunkIds({ storeDir: store.storeDir(), ids: removeIds });
      await markKnowledgeBaseEmbedded({ id: record.id, paseoHome: input.paseoHome });
    } else {
      if (removeIds.length > 0) {
        await deleteDocsChromaChunkIds({ storeDir: store.storeDir(), ids: removeIds });
      }
      await touchKnowledgeBase({ id: record.id, paseoHome: input.paseoHome });
    }

    return { path };
  } finally {
    await store.close();
  }
}

export async function deleteKnowledgeBasePage(input: {
  idOrSlug: string;
  path: string;
  paseoHome: string;
}): Promise<{ path: string }> {
  const path = assertValidPageSlug(input.path);
  const { record, store } = await openStoreForKb(input.idOrSlug, input.paseoHome);
  try {
    const { chunkIds } = store.deletePageCorpus(path);
    await deleteDocsChromaChunkIds({ storeDir: store.storeDir(), ids: chunkIds });
    await touchKnowledgeBase({ id: record.id, paseoHome: input.paseoHome });
    return { path };
  } finally {
    await store.close();
  }
}
