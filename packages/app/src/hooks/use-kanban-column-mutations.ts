import { useCallback } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  DaemonClient,
  KanbanColumnCreateOptions,
  KanbanColumnReorderOptions,
  KanbanColumnUpdateOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { KanbanColumn } from "@getpaseo/protocol/kanban/types";
import { kanbanCardsQueryBaseKey } from "@/hooks/use-kanban-cards";
import { kanbanColumnsQueryBaseKey } from "@/hooks/use-kanban-columns";
import { useSessionStore } from "@/stores/session-store";

export type CreateKanbanColumnInput = Omit<KanbanColumnCreateOptions, "requestId">;
export type UpdateKanbanColumnInput = Omit<KanbanColumnUpdateOptions, "requestId">;
export type ReorderKanbanColumnInput = Omit<KanbanColumnReorderOptions, "requestId">;

export interface DeleteKanbanColumnInput {
  id: string;
  moveCardsToColumnId: string;
}

export interface UseKanbanColumnMutationsResult {
  createColumn: (input: CreateKanbanColumnInput) => Promise<void>;
  updateColumn: (input: UpdateKanbanColumnInput) => Promise<void>;
  reorderColumn: (input: ReorderKanbanColumnInput) => Promise<void>;
  deleteColumn: (input: DeleteKanbanColumnInput) => Promise<void>;
  isCreating: boolean;
  isUpdating: boolean;
  isReordering: boolean;
  isDeleting: boolean;
}

interface ColumnListSnapshot {
  previous: Array<[QueryKey, KanbanColumn[] | undefined]>;
}

function snapshotColumns(queryClient: QueryClient): ColumnListSnapshot {
  return {
    previous: queryClient.getQueriesData<KanbanColumn[]>({ queryKey: kanbanColumnsQueryBaseKey }),
  };
}

function restoreColumns(queryClient: QueryClient, snapshot: ColumnListSnapshot): void {
  for (const [queryKey, previous] of snapshot.previous) {
    queryClient.setQueryData(queryKey, previous);
  }
}

function requireClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

export function useKanbanColumnMutations({
  serverId,
}: {
  serverId: string;
}): UseKanbanColumnMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const invalidateColumns = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: kanbanColumnsQueryBaseKey });
  }, [queryClient]);

  // Deleting a column reassigns its cards to another column, so the card list
  // must refresh alongside the column list.
  const invalidateColumnsAndCards = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: kanbanColumnsQueryBaseKey });
    void queryClient.invalidateQueries({ queryKey: kanbanCardsQueryBaseKey });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateKanbanColumnInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanColumnCreate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidateColumns,
  });

  const updateMutation = useMutation({
    mutationFn: async (input: UpdateKanbanColumnInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanColumnUpdate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidateColumns,
  });

  const reorderMutation = useMutation({
    mutationFn: async (input: ReorderKanbanColumnInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanColumnReorder(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    // Column move-left/right fires two of these (swap with the neighbor) with
    // no round trip in between — optimistic update so both sides of the swap
    // reflect immediately instead of waiting on two sequential invalidations.
    onMutate: async (input): Promise<ColumnListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: kanbanColumnsQueryBaseKey });
      const snapshot = snapshotColumns(queryClient);
      queryClient.setQueriesData<KanbanColumn[]>(
        { queryKey: kanbanColumnsQueryBaseKey },
        (current) => {
          if (!current) {
            return current;
          }
          const next = [...current];
          const index = next.findIndex((column) => column.id === input.id);
          if (index !== -1) {
            next[index] = { ...next[index], order: input.order };
          }
          return next.sort((a, b) => a.order - b.order);
        },
      );
      return snapshot;
    },
    onError: (_error, _input, context) => {
      if (context) {
        restoreColumns(queryClient, context);
      }
    },
    onSettled: invalidateColumns,
  });

  const deleteMutation = useMutation({
    mutationFn: async (input: DeleteKanbanColumnInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanColumnDelete(input.id, input.moveCardsToColumnId);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidateColumnsAndCards,
  });

  const createColumn = useCallback(
    async (input: CreateKanbanColumnInput): Promise<void> => {
      await createMutation.mutateAsync(input);
    },
    [createMutation],
  );

  const updateColumn = useCallback(
    async (input: UpdateKanbanColumnInput): Promise<void> => {
      await updateMutation.mutateAsync(input);
    },
    [updateMutation],
  );

  const reorderColumn = useCallback(
    async (input: ReorderKanbanColumnInput): Promise<void> => {
      await reorderMutation.mutateAsync(input);
    },
    [reorderMutation],
  );

  const deleteColumn = useCallback(
    async (input: DeleteKanbanColumnInput): Promise<void> => {
      await deleteMutation.mutateAsync(input);
    },
    [deleteMutation],
  );

  return {
    createColumn,
    updateColumn,
    reorderColumn,
    deleteColumn,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isReordering: reorderMutation.isPending,
    isDeleting: deleteMutation.isPending,
  };
}
