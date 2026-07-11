import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  DaemonClient,
  KanbanConnectionCreateOptions,
  KanbanConnectionUpdateOptions,
} from "@getpaseo/client/internal/daemon-client";
import { kanbanConnectionsQueryBaseKey } from "@/hooks/use-kanban-connections";
import { kanbanSourcesQueryBaseKey } from "@/hooks/use-kanban-sources";
import { useSessionStore } from "@/stores/session-store";

export type CreateKanbanConnectionInput = Omit<KanbanConnectionCreateOptions, "requestId">;
export type UpdateKanbanConnectionInput = Omit<KanbanConnectionUpdateOptions, "requestId">;

export interface UseKanbanConnectionMutationsResult {
  createConnection: (input: CreateKanbanConnectionInput) => Promise<void>;
  updateConnection: (input: UpdateKanbanConnectionInput) => Promise<void>;
  deleteConnection: (id: string) => Promise<void>;
  /** Starts the OAuth flow and returns the authorize URL to open (or null). */
  connect: (id: string) => Promise<string | null>;
  isCreating: boolean;
  isUpdating: boolean;
  isDeleting: boolean;
  isConnecting: boolean;
}

function requireClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

export function useKanbanConnectionMutations({
  serverId,
}: {
  serverId: string;
}): UseKanbanConnectionMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: kanbanConnectionsQueryBaseKey });
    // Sources render their connection's status, so refresh them too.
    void queryClient.invalidateQueries({ queryKey: kanbanSourcesQueryBaseKey });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateKanbanConnectionInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanConnectionCreate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: async (input: UpdateKanbanConnectionInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanConnectionUpdate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanConnectionDelete(id);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const connectMutation = useMutation({
    mutationFn: async (id: string): Promise<string | null> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanConnectionOauthStart(id);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.authorizeUrl;
    },
    onSettled: invalidate,
  });

  const createConnection = useCallback(
    async (input: CreateKanbanConnectionInput): Promise<void> => {
      await createMutation.mutateAsync(input);
    },
    [createMutation],
  );

  const updateConnection = useCallback(
    async (input: UpdateKanbanConnectionInput): Promise<void> => {
      await updateMutation.mutateAsync(input);
    },
    [updateMutation],
  );

  const deleteConnection = useCallback(
    async (id: string): Promise<void> => {
      await deleteMutation.mutateAsync(id);
    },
    [deleteMutation],
  );

  const connect = useCallback(
    async (id: string): Promise<string | null> => {
      return connectMutation.mutateAsync(id);
    },
    [connectMutation],
  );

  return {
    createConnection,
    updateConnection,
    deleteConnection,
    connect,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isConnecting: connectMutation.isPending,
  };
}
