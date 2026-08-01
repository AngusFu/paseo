import type { DaemonClient } from "@getpaseo/client";
import type { KnowledgeBase } from "@getpaseo/protocol/knowledge-base/types";

/**
 * Resolves `DaemonClient.knowledgeBaseCreate` when present (K1a).
 * Keeps Empty-create gated without inventing alternate RPC names on older clients.
 */
export type KnowledgeBaseCreateFn = (options: {
  slug: string;
  name?: string;
  requestId?: string;
}) => Promise<{
  knowledgeBase: KnowledgeBase | null;
  error: string | null;
}>;

export function resolveKnowledgeBaseCreate(
  client: DaemonClient | null | undefined,
): KnowledgeBaseCreateFn | null {
  if (!client) return null;
  const candidate = client.knowledgeBaseCreate;
  if (typeof candidate !== "function") return null;
  return candidate.bind(client) as KnowledgeBaseCreateFn;
}
