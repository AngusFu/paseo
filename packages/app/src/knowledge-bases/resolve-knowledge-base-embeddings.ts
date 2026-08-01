import type { DaemonClient } from "@getpaseo/client";

/**
 * Resolves E1 embeddings RPCs when present on the client.
 * Missing methods mean an older client/host — show upgrade messaging;
 * do not invent a local fake embeddings path.
 */

export type KnowledgeBaseEmbeddingsDetectOllamaFn =
  DaemonClient["knowledgeBaseEmbeddingsDetectOllama"];
export type KnowledgeBaseEmbeddingsTestFn = DaemonClient["knowledgeBaseEmbeddingsTest"];

export function resolveKnowledgeBaseEmbeddingsDetectOllama(
  client: DaemonClient | null | undefined,
): KnowledgeBaseEmbeddingsDetectOllamaFn | null {
  if (!client) return null;
  const candidate = client.knowledgeBaseEmbeddingsDetectOllama;
  if (typeof candidate !== "function") return null;
  return candidate.bind(client) as KnowledgeBaseEmbeddingsDetectOllamaFn;
}

export function resolveKnowledgeBaseEmbeddingsTest(
  client: DaemonClient | null | undefined,
): KnowledgeBaseEmbeddingsTestFn | null {
  if (!client) return null;
  const candidate = client.knowledgeBaseEmbeddingsTest;
  if (typeof candidate !== "function") return null;
  return candidate.bind(client) as KnowledgeBaseEmbeddingsTestFn;
}

export function resolveKnowledgeBaseEmbeddingsRpcs(client: DaemonClient | null | undefined): {
  detectOllama: KnowledgeBaseEmbeddingsDetectOllamaFn;
  test: KnowledgeBaseEmbeddingsTestFn;
} | null {
  const detectOllama = resolveKnowledgeBaseEmbeddingsDetectOllama(client);
  const test = resolveKnowledgeBaseEmbeddingsTest(client);
  if (!detectOllama || !test) return null;
  return { detectOllama, test };
}
