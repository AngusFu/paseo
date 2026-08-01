import type { KnowledgeBase } from "@getpaseo/protocol/knowledge-base/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import type { AggregateLoadState } from "@/schedules/aggregated-schedules";

export const knowledgeBasesQueryBaseKey = ["knowledge-bases", "list"] as const;

export function knowledgeBasesQueryKey(serverId: string) {
  return [...knowledgeBasesQueryBaseKey, serverId] as const;
}

export interface UseKnowledgeBasesResult {
  loadState: AggregateLoadState<KnowledgeBase>;
  knowledgeBases: KnowledgeBase[];
  refetch: () => void;
  isRefetching: boolean;
  supported: boolean;
  /** Set when the first fetch fails (no cached list to show). */
  error: Error | null;
}

const EMPTY: KnowledgeBase[] = [];

export function useKnowledgeBases(serverId: string | null): UseKnowledgeBasesResult {
  const normalizedServerId = serverId?.trim() ?? "";
  const supported = useHostFeature(normalizedServerId, "knowledgeBases");
  const client = useHostRuntimeClient(normalizedServerId);
  const connectionStatuses = useHostRuntimeConnectionStatuses(
    normalizedServerId ? [normalizedServerId] : [],
  );
  const connectionStatus = normalizedServerId
    ? (connectionStatuses.get(normalizedServerId) ?? "connecting")
    : "disconnected";
  const isOnline = connectionStatus === "online";
  const enabled = Boolean(supported && normalizedServerId && client && isOnline);

  const query = useFetchQuery({
    queryKey: [...knowledgeBasesQueryKey(normalizedServerId || "none"), connectionStatus],
    enabled,
    queryFn: async () => {
      if (!client) {
        throw new Error("Knowledge base host client unavailable");
      }
      const payload = await client.knowledgeBaseList();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.knowledgeBases;
    },
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  let loadState: AggregateLoadState<KnowledgeBase>;
  if (!supported || !normalizedServerId) {
    loadState = { status: "connecting" };
  } else if (!enabled) {
    loadState = { status: "connecting" };
  } else if (query.isPending) {
    loadState = { status: "loading" };
  } else if (query.isError && query.data === undefined) {
    // Never treat a failed first fetch as a loaded empty catalog.
    loadState = { status: "loading" };
  } else {
    loadState = { status: "loaded", data: query.data ?? EMPTY };
  }

  return {
    loadState,
    knowledgeBases: loadState.status === "loaded" ? loadState.data : EMPTY,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
    supported,
    error: query.isError && query.data === undefined ? query.error : null,
  };
}
