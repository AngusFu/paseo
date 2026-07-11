import type { StoredKanbanConnection } from "@getpaseo/protocol/kanban/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";

// Auth connections (Jira / GitLab instances + credentials). Sources reference
// one by id. Single-host query for v1, mirroring use-kanban-sources.
export const kanbanConnectionsQueryBaseKey = ["kanban", "connections"] as const;

export function kanbanConnectionsQueryKey(serverId: string) {
  return [...kanbanConnectionsQueryBaseKey, serverId] as const;
}

export interface UseKanbanConnectionsResult {
  connections: StoredKanbanConnection[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
}

const EMPTY_CONNECTIONS: StoredKanbanConnection[] = [];

export function useKanbanConnections(serverId: string | null): UseKanbanConnectionsResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId
    ? (connectionStatuses.get(serverId) ?? "connecting")
    : "disconnected";
  const isOnline = connectionStatus === "online";
  const enabled = Boolean(serverId && client && isOnline);

  const query = useFetchQuery({
    queryKey: [...kanbanConnectionsQueryKey(serverId ?? "none"), connectionStatus],
    enabled,
    queryFn: async () => {
      if (!client) {
        throw new Error("Kanban host client unavailable");
      }
      const payload = await client.kanbanConnectionList();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.connections;
    },
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  return {
    connections: query.data ?? EMPTY_CONNECTIONS,
    isLoading: enabled && query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
