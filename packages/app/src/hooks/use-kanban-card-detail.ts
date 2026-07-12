import type { KanbanCardDetail } from "@getpaseo/protocol/kanban/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

export const kanbanCardDetailQueryBaseKey = ["kanban", "card-detail"] as const;

export function kanbanCardDetailQueryKey(serverId: string, cardId: string) {
  return [...kanbanCardDetailQueryBaseKey, serverId, cardId] as const;
}

export interface UseKanbanCardDetailResult {
  detail: KanbanCardDetail | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

// Fetches the tracker-sourced detail (description, comments, external status)
// for a single card. Scoped by cardId so the query key changes — and the
// fetch refires — whenever the sheet is pointed at a different card.
export function useKanbanCardDetail(
  serverId: string | null,
  cardId: string | null,
  enabled: boolean,
): UseKanbanCardDetailResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const queryEnabled = Boolean(serverId && cardId && client && enabled);

  const query = useFetchQuery({
    queryKey: kanbanCardDetailQueryKey(serverId ?? "none", cardId ?? "none"),
    enabled: queryEnabled,
    queryFn: async () => {
      if (!client || !cardId) {
        throw new Error("Kanban host client unavailable");
      }
      const payload = await client.kanbanCardDetail(cardId);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.detail;
    },
    dataShape: "value",
    // Always refetch on (re)open rather than serving a stale cached detail —
    // the tracker is the source of truth and this is a low-frequency, on-demand
    // fetch, not a polled list.
    staleTimeMs: 0,
  });

  return {
    detail: query.data ?? null,
    isLoading: queryEnabled && query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}
