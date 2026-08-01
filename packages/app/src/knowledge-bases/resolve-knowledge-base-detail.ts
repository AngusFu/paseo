import type { DaemonClient } from "@getpaseo/client";
import type { KnowledgeBaseSearchMode } from "@getpaseo/protocol/knowledge-base/types";

/**
 * Resolves K2a browse/search DaemonClient methods when present.
 * Keeps detail browse gated without inventing alternate RPC names on older clients.
 */

export type KnowledgeBaseListTreeFn = DaemonClient["knowledgeBaseListTree"];
export type KnowledgeBaseGetPageFn = DaemonClient["knowledgeBaseGetPage"];
export type KnowledgeBaseSearchFn = DaemonClient["knowledgeBaseSearch"];

export type { KnowledgeBaseSearchMode };

export function resolveKnowledgeBaseListTree(
  client: DaemonClient | null | undefined,
): KnowledgeBaseListTreeFn | null {
  if (!client) return null;
  const candidate = client.knowledgeBaseListTree;
  if (typeof candidate !== "function") return null;
  return candidate.bind(client) as KnowledgeBaseListTreeFn;
}

export function resolveKnowledgeBaseGetPage(
  client: DaemonClient | null | undefined,
): KnowledgeBaseGetPageFn | null {
  if (!client) return null;
  const candidate = client.knowledgeBaseGetPage;
  if (typeof candidate !== "function") return null;
  return candidate.bind(client) as KnowledgeBaseGetPageFn;
}

export function resolveKnowledgeBaseSearch(
  client: DaemonClient | null | undefined,
): KnowledgeBaseSearchFn | null {
  if (!client) return null;
  const candidate = client.knowledgeBaseSearch;
  if (typeof candidate !== "function") return null;
  return candidate.bind(client) as KnowledgeBaseSearchFn;
}

export function resolveKnowledgeBaseDetailApis(client: DaemonClient | null | undefined): {
  listTree: KnowledgeBaseListTreeFn | null;
  getPage: KnowledgeBaseGetPageFn | null;
  search: KnowledgeBaseSearchFn | null;
  ready: boolean;
} {
  const listTree = resolveKnowledgeBaseListTree(client);
  const getPage = resolveKnowledgeBaseGetPage(client);
  const search = resolveKnowledgeBaseSearch(client);
  return {
    listTree,
    getPage,
    search,
    ready: Boolean(listTree && getPage && search),
  };
}
