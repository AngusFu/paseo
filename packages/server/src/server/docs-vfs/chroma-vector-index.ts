/**
 * Chroma collection helpers for Docs VFS chunk embeddings.
 * Corpus (pages / path_tree / chunk text) stays in SQLite; vectors live here.
 */

import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { Collection } from "chromadb";

import { createDocsChromaClient, docsChromaDataDir, docsChromaRoot } from "./chroma-sidecar.js";
import { assertEmbeddingDimCount } from "./embeddings.js";
import type { DocsChunkRow } from "./vector-store.js";

const COLLECTION_PREFIX = "docs_";

/** Derive $PASEO_HOME from a store dir (`$PASEO_HOME/docs-vfs/<key>`). */
export function paseoHomeFromStoreDir(storeDir: string): string {
  return dirname(dirname(storeDir));
}

export function storeKeyFromStoreDir(storeDir: string): string {
  return basename(storeDir);
}

/** Chroma collection names: [a-zA-Z0-9][a-zA-Z0-9._-]{1,62} */
export function chromaCollectionNameForStoreKey(storeKey: string): string {
  const raw = `${COLLECTION_PREFIX}${storeKey}`.toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  const trimmed = raw.slice(0, 63);
  if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(trimmed)) {
    throw new Error(`Invalid Chroma collection name derived from store key: ${storeKey}`);
  }
  return trimmed;
}

function distanceToScore(distance: number | null | undefined): number {
  if (distance == null || !Number.isFinite(distance)) return 0;
  // Cosine space: Chroma distance ≈ 1 - cosine_similarity
  return Math.max(0, Math.min(1, 1 - distance));
}

function hitFromChromaRow(options: {
  metadata: { slug?: unknown; chunk_index?: unknown } | null;
  document: string | null | undefined;
  distance: number | null | undefined;
}): { slug: string; chunkIndex: number; score: number; text: string } {
  const slug = typeof options.metadata?.slug === "string" ? options.metadata.slug : "";
  let chunkIndex = 0;
  if (typeof options.metadata?.chunk_index === "number") {
    chunkIndex = options.metadata.chunk_index;
  } else if (options.metadata?.chunk_index != null) {
    chunkIndex = Number.parseInt(String(options.metadata.chunk_index), 10) || 0;
  }
  return {
    slug,
    chunkIndex,
    score: distanceToScore(options.distance),
    text: typeof options.document === "string" ? options.document : "",
  };
}

async function getCollection(
  storeDir: string,
  options?: { create?: boolean },
): Promise<{ collection: Collection; name: string }> {
  const paseoHome = paseoHomeFromStoreDir(storeDir);
  const name = chromaCollectionNameForStoreKey(storeKeyFromStoreDir(storeDir));
  const { client } = await createDocsChromaClient(paseoHome);
  if (options?.create) {
    try {
      await client.deleteCollection({ name });
    } catch {
      // Collection may not exist yet.
    }
    const collection = await client.createCollection({
      name,
      embeddingFunction: null,
      configuration: { hnsw: { space: "cosine" } },
      metadata: { paseo: "docs-vfs", storeKey: storeKeyFromStoreDir(storeDir) },
    });
    return { collection, name };
  }
  const collection = await client.getOrCreateCollection({
    name,
    embeddingFunction: null,
    configuration: { hnsw: { space: "cosine" } },
    metadata: { paseo: "docs-vfs", storeKey: storeKeyFromStoreDir(storeDir) },
  });
  return { collection, name };
}

export async function replaceDocsChromaIndex(options: {
  storeDir: string;
  chunks: DocsChunkRow[];
  batchSize?: number;
}): Promise<{ collectionName: string; chunkCount: number }> {
  const { collection, name } = await getCollection(options.storeDir, { create: true });
  if (options.chunks.length === 0) {
    return { collectionName: name, chunkCount: 0 };
  }

  const dims = options.chunks[0]!.embedding.length;
  for (const chunk of options.chunks) {
    assertEmbeddingDimCount(chunk.embedding, dims, `chunk ${chunk.id}`);
  }

  const { client } = await createDocsChromaClient(paseoHomeFromStoreDir(options.storeDir));
  const maxBatch = Math.min(options.batchSize ?? 100, await client.getMaxBatchSize());

  for (let i = 0; i < options.chunks.length; i += maxBatch) {
    const batch = options.chunks.slice(i, i + maxBatch);
    await collection.upsert({
      ids: batch.map((chunk) => chunk.id),
      embeddings: batch.map((chunk) => chunk.embedding),
      documents: batch.map((chunk) => chunk.text),
      metadatas: batch.map((chunk) => ({
        slug: chunk.slug,
        chunk_index: chunk.chunkIndex,
      })),
    });
  }

  return { collectionName: name, chunkCount: options.chunks.length };
}

/** Incremental upsert into an existing (or new) collection — does not wipe other pages. */
export async function upsertDocsChromaChunks(options: {
  storeDir: string;
  chunks: DocsChunkRow[];
  batchSize?: number;
}): Promise<{ collectionName: string; chunkCount: number }> {
  if (options.chunks.length === 0) {
    const name = chromaCollectionNameForStoreKey(storeKeyFromStoreDir(options.storeDir));
    return { collectionName: name, chunkCount: 0 };
  }

  const dims = options.chunks[0]!.embedding.length;
  for (const chunk of options.chunks) {
    assertEmbeddingDimCount(chunk.embedding, dims, `chunk ${chunk.id}`);
  }

  const { collection, name } = await getCollection(options.storeDir, { create: false });
  const { client } = await createDocsChromaClient(paseoHomeFromStoreDir(options.storeDir));
  const maxBatch = Math.min(options.batchSize ?? 100, await client.getMaxBatchSize());

  for (let i = 0; i < options.chunks.length; i += maxBatch) {
    const batch = options.chunks.slice(i, i + maxBatch);
    await collection.upsert({
      ids: batch.map((chunk) => chunk.id),
      embeddings: batch.map((chunk) => chunk.embedding),
      documents: batch.map((chunk) => chunk.text),
      metadatas: batch.map((chunk) => ({
        slug: chunk.slug,
        chunk_index: chunk.chunkIndex,
      })),
    });
  }

  return { collectionName: name, chunkCount: options.chunks.length };
}

/** Best-effort delete of chunk ids (missing collection / ids are ignored). */
export async function deleteDocsChromaChunkIds(options: {
  storeDir: string;
  ids: string[];
}): Promise<void> {
  if (options.ids.length === 0) return;
  const paseoHome = paseoHomeFromStoreDir(options.storeDir);
  if (!chromaDataExists(paseoHome)) return;
  const name = chromaCollectionNameForStoreKey(storeKeyFromStoreDir(options.storeDir));
  const { client } = await createDocsChromaClient(paseoHome);
  let collection: Collection;
  try {
    collection = await client.getCollection({ name });
  } catch {
    return;
  }
  try {
    await collection.delete({ ids: options.ids });
  } catch {
    // ignore missing ids
  }
}

export async function queryDocsChromaIndex(options: {
  storeDir: string;
  queryEmbedding: number[];
  limit?: number;
  expectedDims?: number;
}): Promise<Array<{ slug: string; chunkIndex: number; score: number; text: string }>> {
  if (options.expectedDims && options.expectedDims > 0) {
    assertEmbeddingDimCount(options.queryEmbedding, options.expectedDims, "query vs index");
  }

  const paseoHome = paseoHomeFromStoreDir(options.storeDir);
  const name = chromaCollectionNameForStoreKey(storeKeyFromStoreDir(options.storeDir));
  const { client } = await createDocsChromaClient(paseoHome);

  let collection: Collection;
  try {
    collection = await client.getCollection({ name });
  } catch {
    return [];
  }

  const count = await collection.count();
  if (count === 0) return [];

  const nResults = Math.min(options.limit ?? 8, count);
  const result = await collection.query({
    queryEmbeddings: [options.queryEmbedding],
    nResults,
    include: ["documents", "metadatas", "distances"],
  });

  const ids = result.ids[0] ?? [];
  const documents = result.documents?.[0] ?? [];
  const metadatas = result.metadatas?.[0] ?? [];
  const distances = result.distances?.[0] ?? [];

  return ids.map((_id, i) =>
    hitFromChromaRow({
      metadata: (metadatas[i] ?? null) as { slug?: unknown; chunk_index?: unknown } | null,
      document: documents[i],
      distance: distances[i],
    }),
  );
}

function chromaDataExists(paseoHome: string): boolean {
  return existsSync(docsChromaDataDir(paseoHome)) || existsSync(docsChromaRoot(paseoHome));
}

export async function docsChromaIndexCount(storeDir: string): Promise<number> {
  const paseoHome = paseoHomeFromStoreDir(storeDir);
  if (!chromaDataExists(paseoHome)) return 0;
  const name = chromaCollectionNameForStoreKey(storeKeyFromStoreDir(storeDir));
  const { client } = await createDocsChromaClient(paseoHome);
  try {
    const collection = await client.getCollection({ name });
    return await collection.count();
  } catch {
    return 0;
  }
}

export async function deleteDocsChromaIndex(storeDir: string): Promise<void> {
  const paseoHome = paseoHomeFromStoreDir(storeDir);
  if (!chromaDataExists(paseoHome)) return;
  const name = chromaCollectionNameForStoreKey(storeKeyFromStoreDir(storeDir));
  const { client } = await createDocsChromaClient(paseoHome);
  try {
    await client.deleteCollection({ name });
  } catch {
    // ignore missing collection
  }
}
