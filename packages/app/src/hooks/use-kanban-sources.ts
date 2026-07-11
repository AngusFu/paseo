import type { StoredKanbanSource } from "@getpaseo/protocol/kanban/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";

// Single-host source query for v1, mirroring use-kanban-cards.
export const kanbanSourcesQueryBaseKey = ["kanban", "sources"] as const;

export function kanbanSourcesQueryKey(serverId: string) {
  return [...kanbanSourcesQueryBaseKey, serverId] as const;
}

export interface UseKanbanSourcesResult {
  sources: StoredKanbanSource[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
}

const EMPTY_SOURCES: StoredKanbanSource[] = [];

export function useKanbanSources(serverId: string | null): UseKanbanSourcesResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId
    ? (connectionStatuses.get(serverId) ?? "connecting")
    : "disconnected";
  const isOnline = connectionStatus === "online";
  const enabled = Boolean(serverId && client && isOnline);

  const query = useFetchQuery({
    queryKey: [...kanbanSourcesQueryKey(serverId ?? "none"), connectionStatus],
    enabled,
    queryFn: async () => {
      if (!client) {
        throw new Error("Kanban host client unavailable");
      }
      const payload = await client.kanbanSourceList();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.sources;
    },
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  return {
    sources: query.data ?? EMPTY_SOURCES,
    isLoading: enabled && query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
