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
import { kanbanSourcesQueryBaseKey } from "@/hooks/use-kanban-sources";
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

  // A board-wide sync also updates each source's lastSyncAt / lastSyncError, so
  // refresh the sources list too — otherwise the sources sheet shows stale sync
  // status (and swallowed per-source errors) until it happens to refetch.
  const invalidateCardsAndSources = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: kanbanCardsQueryBaseKey });
    void queryClient.invalidateQueries({ queryKey: kanbanSourcesQueryBaseKey });
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
      updateCardsData(queryClient, (cards) => {
        // Group by columnId when the caller knows it (columns capability
        // present); otherwise fall back to status, matching the pre-columns
        // behavior. Append to the end of the target group to match the
        // server's append semantics (max(order)+1), so the card doesn't jump
        // when the fetch reconciles. An explicit order (drop between cards)
        // wins.
        const isSameGroup = (card: StoredKanbanCard) =>
          input.columnId !== undefined
            ? card.columnId === input.columnId
            : card.status === input.status;
        const maxOrder = cards.reduce(
          (max, card) =>
            isSameGroup(card) && card.id !== input.id ? Math.max(max, card.order) : max,
          Number.NEGATIVE_INFINITY,
        );
        const nextOrder = input.order ?? (Number.isFinite(maxOrder) ? maxOrder + 1 : 0);
        return cards.map((card) =>
          card.id === input.id
            ? {
                ...card,
                status: input.status,
                ...(input.columnId !== undefined ? { columnId: input.columnId } : {}),
                statusPinnedByUser: true,
                order: nextOrder,
              }
            : card,
        );
      });
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
      // Sync every enabled source; one bad source must not block the rest — and
      // a per-source failure must NOT reject this mutation. The daemon records
      // each failure in that source's `lastSyncError`, which the sources list
      // surfaces per-row after the invalidate below. Rejecting here would bubble
      // up as an uncaught error and crash the app.
      for (const source of listPayload.sources) {
        if (!source.enabled) {
          continue;
        }
        try {
          await client.kanbanSourceSync(source.id);
        } catch {
          // Ignored: recorded server-side, shown per-row after invalidation.
        }
      }
    },
    onSettled: invalidateCardsAndSources,
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
