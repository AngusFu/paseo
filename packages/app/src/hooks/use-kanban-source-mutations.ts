import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  DaemonClient,
  KanbanSourceCreateOptions,
  KanbanSourceUpdateOptions,
} from "@getpaseo/client/internal/daemon-client";
import { kanbanCardsQueryBaseKey } from "@/hooks/use-kanban-cards";
import { kanbanSourcesQueryBaseKey } from "@/hooks/use-kanban-sources";
import { useSessionStore } from "@/stores/session-store";

// A source holds the query + poll config and references an auth connection by
// id; credentials/OAuth live on the connection (use-kanban-connection-mutations).
export type CreateKanbanSourceInput = Omit<KanbanSourceCreateOptions, "requestId">;
export type UpdateKanbanSourceInput = Omit<KanbanSourceUpdateOptions, "requestId">;

export interface UseKanbanSourceMutationsResult {
  createSource: (input: CreateKanbanSourceInput) => Promise<void>;
  updateSource: (input: UpdateKanbanSourceInput) => Promise<void>;
  deleteSource: (id: string) => Promise<void>;
  syncSource: (id: string) => Promise<void>;
  isCreating: boolean;
  isUpdating: boolean;
  isDeleting: boolean;
  isSyncing: boolean;
}

function requireClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

export function useKanbanSourceMutations({
  serverId,
}: {
  serverId: string;
}): UseKanbanSourceMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const invalidateSources = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: kanbanSourcesQueryBaseKey });
  }, [queryClient]);

  const invalidateSourcesAndCards = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: kanbanSourcesQueryBaseKey });
    void queryClient.invalidateQueries({ queryKey: kanbanCardsQueryBaseKey });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateKanbanSourceInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanSourceCreate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidateSources,
  });

  const updateMutation = useMutation({
    mutationFn: async (input: UpdateKanbanSourceInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanSourceUpdate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidateSources,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanSourceDelete(id);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidateSourcesAndCards,
  });

  const syncMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanSourceSync(id);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidateSourcesAndCards,
  });

  const createSource = useCallback(
    async (input: CreateKanbanSourceInput): Promise<void> => {
      await createMutation.mutateAsync(input);
    },
    [createMutation],
  );

  const updateSource = useCallback(
    async (input: UpdateKanbanSourceInput): Promise<void> => {
      await updateMutation.mutateAsync(input);
    },
    [updateMutation],
  );

  const deleteSource = useCallback(
    async (id: string): Promise<void> => {
      await deleteMutation.mutateAsync(id);
    },
    [deleteMutation],
  );

  const syncSource = useCallback(
    async (id: string): Promise<void> => {
      await syncMutation.mutateAsync(id);
    },
    [syncMutation],
  );

  return {
    createSource,
    updateSource,
    deleteSource,
    syncSource,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isSyncing: syncMutation.isPending,
  };
}
