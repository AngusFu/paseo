import type { StoredKanbanCard } from "@getpaseo/protocol/kanban/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";

// Single-host card query for v1. The Kanban board scopes to one active host, so
// there is no multi-host aggregation here (unlike schedules).
export const kanbanCardsQueryBaseKey = ["kanban", "cards"] as const;

export function kanbanCardsQueryKey(serverId: string) {
  return [...kanbanCardsQueryBaseKey, serverId] as const;
}

export interface UseKanbanCardsResult {
  cards: StoredKanbanCard[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  isRefetching: boolean;
}

const EMPTY_CARDS: StoredKanbanCard[] = [];

export function useKanbanCards(serverId: string | null): UseKanbanCardsResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId
    ? (connectionStatuses.get(serverId) ?? "connecting")
    : "disconnected";
  const isOnline = connectionStatus === "online";
  const enabled = Boolean(serverId && client && isOnline);

  const query = useFetchQuery({
    queryKey: [...kanbanCardsQueryKey(serverId ?? "none"), connectionStatus],
    enabled,
    queryFn: async () => {
      if (!client) {
        throw new Error("Kanban host client unavailable");
      }
      const payload = await client.kanbanCardList();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.cards;
    },
    dataShape: "list",
    staleTimeMs: 5_000,
    // Daemon polls the source (e.g. Jira) in the background and writes cards to
    // disk without pushing an event to the client, so poll here too. Only while
    // the window is focused (react-query's refetchIntervalInBackground default
    // is false).
    refetchInterval: 30_000,
  });

  return {
    cards: query.data ?? EMPTY_CARDS,
    // Only "loading" when the query is actually enabled and pending. When
    // disabled (no host / offline) we are NOT loading — the screen decides
    // between a connecting spinner and an offline/empty state, so a
    // permanently-disabled query never spins forever.
    isLoading: enabled && query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
