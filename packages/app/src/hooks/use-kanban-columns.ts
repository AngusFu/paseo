import type { KanbanColumn } from "@getpaseo/protocol/kanban/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";

// Single-host column query for v1, mirroring use-kanban-cards.
export const kanbanColumnsQueryBaseKey = ["kanban", "columns"] as const;

export function kanbanColumnsQueryKey(serverId: string) {
  return [...kanbanColumnsQueryBaseKey, serverId] as const;
}

export interface UseKanbanColumnsResult {
  columns: KanbanColumn[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
}

const EMPTY_COLUMNS: KanbanColumn[] = [];

export function useKanbanColumns(serverId: string | null): UseKanbanColumnsResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId
    ? (connectionStatuses.get(serverId) ?? "connecting")
    : "disconnected";
  const isOnline = connectionStatus === "online";
  const enabled = Boolean(serverId && client && isOnline);

  const query = useFetchQuery({
    queryKey: [...kanbanColumnsQueryKey(serverId ?? "none"), connectionStatus],
    enabled,
    queryFn: async () => {
      if (!client) {
        throw new Error("Kanban host client unavailable");
      }
      const payload = await client.kanbanColumnList();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return [...payload.columns].sort((a, b) => a.order - b.order);
    },
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  return {
    columns: query.data ?? EMPTY_COLUMNS,
    isLoading: enabled && query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
