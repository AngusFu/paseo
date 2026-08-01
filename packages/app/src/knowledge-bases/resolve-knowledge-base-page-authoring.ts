import type { DaemonClient } from "@getpaseo/client";

/**
 * Resolves K3a page authoring DaemonClient methods when present.
 * Keeps in-product edit gated without inventing alternate RPC names on older clients.
 */

export type KnowledgeBaseUpsertPageFn = DaemonClient["knowledgeBaseUpsertPage"];
export type KnowledgeBaseDeletePageFn = DaemonClient["knowledgeBaseDeletePage"];

export function resolveKnowledgeBaseUpsertPage(
  client: DaemonClient | null | undefined,
): KnowledgeBaseUpsertPageFn | null {
  if (!client) return null;
  const candidate = client.knowledgeBaseUpsertPage;
  if (typeof candidate !== "function") return null;
  return candidate.bind(client) as KnowledgeBaseUpsertPageFn;
}

export function resolveKnowledgeBaseDeletePage(
  client: DaemonClient | null | undefined,
): KnowledgeBaseDeletePageFn | null {
  if (!client) return null;
  const candidate = client.knowledgeBaseDeletePage;
  if (typeof candidate !== "function") return null;
  return candidate.bind(client) as KnowledgeBaseDeletePageFn;
}

export function resolveKnowledgeBasePageAuthoringApis(client: DaemonClient | null | undefined): {
  upsertPage: KnowledgeBaseUpsertPageFn | null;
  deletePage: KnowledgeBaseDeletePageFn | null;
  ready: boolean;
} {
  const upsertPage = resolveKnowledgeBaseUpsertPage(client);
  const deletePage = resolveKnowledgeBaseDeletePage(client);
  return {
    upsertPage,
    deletePage,
    ready: Boolean(upsertPage && deletePage),
  };
}
