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
  KanbanCardCreateOptions,
  KanbanCardMoveOptions,
  KanbanCardUpdateOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { StoredKanbanCard } from "@getpaseo/protocol/kanban/types";
import { kanbanCardsQueryBaseKey } from "@/hooks/use-kanban-cards";
import { useSessionStore } from "@/stores/session-store";

export type CreateKanbanCardInput = Omit<KanbanCardCreateOptions, "requestId">;
export type UpdateKanbanCardInput = Omit<KanbanCardUpdateOptions, "requestId">;
export type MoveKanbanCardInput = Omit<KanbanCardMoveOptions, "requestId">;

export interface UseKanbanMutationsResult {
  createCard: (input: CreateKanbanCardInput) => Promise<void>;
  updateCard: (input: UpdateKanbanCardInput) => Promise<void>;
  moveCard: (input: MoveKanbanCardInput) => Promise<void>;
  deleteCard: (id: string) => Promise<void>;
  syncSources: () => Promise<void>;
  isCreating: boolean;
  isUpdating: boolean;
  isMoving: boolean;
  isDeleting: boolean;
  isSyncing: boolean;
}

interface CardListSnapshot {
  previous: Array<[QueryKey, StoredKanbanCard[] | undefined]>;
}

function requireClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

function snapshotCards(queryClient: QueryClient): CardListSnapshot {
  return {
    previous: queryClient.getQueriesData<StoredKanbanCard[]>({
      queryKey: kanbanCardsQueryBaseKey,
    }),
  };
}

function restoreCards(queryClient: QueryClient, snapshot: CardListSnapshot): void {
  for (const [queryKey, previous] of snapshot.previous) {
    queryClient.setQueryData(queryKey, previous);
  }
}

function updateCardsData(
  queryClient: QueryClient,
  updater: (cards: StoredKanbanCard[]) => StoredKanbanCard[],
): void {
  queryClient.setQueriesData<StoredKanbanCard[]>({ queryKey: kanbanCardsQueryBaseKey }, (current) =>
    current ? updater(current) : current,
  );
}

export function useKanbanMutations({ serverId }: { serverId: string }): UseKanbanMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: kanbanCardsQueryBaseKey });
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: async (input: CreateKanbanCardInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanCardCreate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: async (input: UpdateKanbanCardInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanCardUpdate(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onSettled: invalidate,
  });

  const moveMutation = useMutation({
    mutationFn: async (input: MoveKanbanCardInput): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanCardMove(input);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onMutate: async (input): Promise<CardListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: kanbanCardsQueryBaseKey });
      const snapshot = snapshotCards(queryClient);
      updateCardsData(queryClient, (cards) =>
        cards.map((card) =>
          card.id === input.id
            ? {
                ...card,
                status: input.status,
                statusPinnedByUser: true,
                // Append to the end of the target column to match the server's
                // append semantics, so the card doesn't jump when the fetch
                // reconciles. An explicit order (drop between cards) wins.
                order: input.order ?? Number.MAX_SAFE_INTEGER,
              }
            : card,
        ),
      );
      return snapshot;
    },
    onError: (_error, _input, context) => {
      if (context) {
        restoreCards(queryClient, context);
      }
    },
    onSettled: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanCardDelete(id);
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    onMutate: async (id): Promise<CardListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: kanbanCardsQueryBaseKey });
      const snapshot = snapshotCards(queryClient);
      updateCardsData(queryClient, (cards) => cards.filter((card) => card.id !== id));
      return snapshot;
    },
    onError: (_error, _id, context) => {
      if (context) {
        restoreCards(queryClient, context);
      }
    },
    onSettled: invalidate,
  });

  const syncMutation = useMutation({
    mutationFn: async (): Promise<void> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const listPayload = await client.kanbanSourceList();
      if (listPayload.error) {
        throw new Error(listPayload.error);
      }
      // Sync every enabled source; one bad source must not block the rest.
      // Collect failures and surface them together after all have run.
      const failures: string[] = [];
      for (const source of listPayload.sources) {
        if (!source.enabled) {
          continue;
        }
        try {
          const syncPayload = await client.kanbanSourceSync(source.id);
          if (syncPayload.error) {
            failures.push(`${source.name}: ${syncPayload.error}`);
          }
        } catch (error) {
          failures.push(
            `${source.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (failures.length > 0) {
        throw new Error(failures.join("\n"));
      }
    },
    onSettled: invalidate,
  });

  const createCard = useCallback(
    async (input: CreateKanbanCardInput): Promise<void> => {
      await createMutation.mutateAsync(input);
    },
    [createMutation],
  );

  const updateCard = useCallback(
    async (input: UpdateKanbanCardInput): Promise<void> => {
      await updateMutation.mutateAsync(input);
    },
    [updateMutation],
  );

  const moveCard = useCallback(
    async (input: MoveKanbanCardInput): Promise<void> => {
      await moveMutation.mutateAsync(input);
    },
    [moveMutation],
  );

  const deleteCard = useCallback(
    async (id: string): Promise<void> => {
      await deleteMutation.mutateAsync(id);
    },
    [deleteMutation],
  );

  const syncSources = useCallback(async (): Promise<void> => {
    await syncMutation.mutateAsync();
  }, [syncMutation]);

  return {
    createCard,
    updateCard,
    moveCard,
    deleteCard,
    syncSources,
    isCreating: createMutation.isPending,
    isUpdating: updateMutation.isPending,
    isMoving: moveMutation.isPending,
    isDeleting: deleteMutation.isPending,
    isSyncing: syncMutation.isPending,
  };
}
