import type { KanbanExternalStatus } from "@getpaseo/protocol/kanban/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

export const kanbanSourceStatusesQueryBaseKey = ["kanban", "source-statuses"] as const;

export function kanbanSourceStatusesQueryKey(serverId: string, sourceId: string) {
  return [...kanbanSourceStatusesQueryBaseKey, serverId, sourceId] as const;
}

export interface UseKanbanSourceStatusesResult {
  statuses: KanbanExternalStatus[] | null;
  isLoading: boolean;
  isError: boolean;
}

// Full workflow status list for a Jira source (every status the workflow
// defines, including ones with zero cards right now) — see
// kanbanSourceStatuses in daemon-client.ts. `enabled` gates on both the
// server_info.features.kanbanSourceStatuses capability (caller passes it)
// and having a real sourceId to ask about.
export function useKanbanSourceStatuses(
  serverId: string | null,
  sourceId: string | null,
  enabled: boolean,
): UseKanbanSourceStatusesResult {
  const client = useHostRuntimeClient(serverId ?? "");
  const queryEnabled = Boolean(serverId && sourceId && client && enabled);

  const query = useFetchQuery({
    queryKey: kanbanSourceStatusesQueryKey(serverId ?? "none", sourceId ?? "none"),
    enabled: queryEnabled,
    queryFn: async () => {
      if (!client || !sourceId) {
        throw new Error("Kanban host client unavailable");
      }
      const payload = await client.kanbanSourceStatuses(sourceId);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.statuses ?? [];
    },
    dataShape: "list",
    staleTimeMs: 60_000,
  });

  return {
    statuses: query.data ?? null,
    isLoading: queryEnabled && query.isPending,
    isError: query.isError,
  };
}
