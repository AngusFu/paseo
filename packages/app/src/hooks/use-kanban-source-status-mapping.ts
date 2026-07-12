import type { KanbanColumn, KanbanExternalStatus } from "@getpaseo/protocol/kanban/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";

// Data for the kanban source form's status-mapping section: the host's
// configurable columns, and the external tracker's live status list for one
// source. Both are read-only lookups scoped to that form section.

export const kanbanColumnsQueryBaseKey = ["kanban", "columns"] as const;
export const kanbanExternalStatusesQueryBaseKey = ["kanban", "externalStatuses"] as const;

export interface UseKanbanColumnsResult {
  columns: KanbanColumn[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
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
    queryKey: [...kanbanColumnsQueryBaseKey, serverId ?? "none", connectionStatus],
    enabled,
    queryFn: async () => {
      if (!client) {
        throw new Error("Kanban host client unavailable");
      }
      const payload = await client.kanbanColumnList();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.columns;
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
  };
}

export interface UseKanbanExternalStatusesResult {
  statuses: KanbanExternalStatus[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

const EMPTY_STATUSES: KanbanExternalStatus[] = [];

export function useKanbanExternalStatuses(
  serverId: string | null,
  sourceId: string,
  projectKey: string,
): UseKanbanExternalStatusesResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId
    ? (connectionStatuses.get(serverId) ?? "connecting")
    : "disconnected";
  const isOnline = connectionStatus === "online";
  const enabled = Boolean(serverId && client && isOnline);

  const query = useFetchQuery({
    queryKey: [
      ...kanbanExternalStatusesQueryBaseKey,
      serverId ?? "none",
      sourceId,
      projectKey,
      connectionStatus,
    ],
    enabled,
    queryFn: async () => {
      if (!client) {
        throw new Error("Kanban host client unavailable");
      }
      const payload = await client.kanbanSourceListExternalStatuses(
        sourceId,
        projectKey || undefined,
      );
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.statuses;
    },
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  return {
    statuses: query.data ?? EMPTY_STATUSES,
    isLoading: enabled && query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}
