import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  DaemonClient,
  KanbanColumnCreateOptions,
  KanbanColumnReorderOptions,
  KanbanColumnUpdateOptions,
} from "@getpaseo/client/internal/daemon-client";
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
