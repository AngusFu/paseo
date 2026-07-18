import { useCallback } from "react";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  KanbanCardDetailComment,
  KanbanCardTransition,
  StoredKanbanCard,
} from "@getpaseo/protocol/kanban/types";
import { kanbanCardsQueryBaseKey } from "@/hooks/use-kanban-cards";
import { useSessionStore } from "@/stores/session-store";

// Jira write-back (docs request: drag → real transition, detail sheet → real
// comment/status change). Every RPC here is Jira-only server-side and
// rejects non-jira cards with an explicit error.

function requireClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

interface CardListSnapshot {
  previous: Array<[QueryKey, StoredKanbanCard[] | undefined]>;
}

function snapshotCards(queryClient: QueryClient): CardListSnapshot {
  return {
    previous: queryClient.getQueriesData<StoredKanbanCard[]>({ queryKey: kanbanCardsQueryBaseKey }),
  };
}

function restoreCards(queryClient: QueryClient, snapshot: CardListSnapshot): void {
  for (const [queryKey, previous] of snapshot.previous) {
    queryClient.setQueryData(queryKey, previous);
  }
}

function patchCard(
  queryClient: QueryClient,
  cardId: string,
  patch: (card: StoredKanbanCard) => StoredKanbanCard,
): void {
  queryClient.setQueriesData<StoredKanbanCard[]>({ queryKey: kanbanCardsQueryBaseKey }, (current) =>
    current ? current.map((card) => (card.id === cardId ? patch(card) : card)) : current,
  );
}

// The transition RPC updates the card's Paseo status/columnId server-side but
// — by design (see writeback.ts doc comment) — never touches the card's raw
// `metadata.status` blob, which is what the Jira-kind board buckets cards by.
// Without this patch a successful transition would leave the card visually
// stuck in its old lane until the next source sync re-polls Jira. `toStatus`
// only ever carries a name (from the transition list) and, when the caller
// has it (kanbanSourceStatuses), a statusCategory key for correct sort order;
// omitting the category just means the card sorts last within its lane set,
// never that it lands in the wrong lane.
export function patchCardMetadataStatus(
  card: StoredKanbanCard,
  toStatusName: string,
  categoryKey: string | null | undefined,
): StoredKanbanCard {
  if (card.source.kind !== "jira") {
    return card;
  }
  const metadata: Record<string, unknown> = { ...card.metadata };
  const prevStatus =
    typeof metadata.status === "object" &&
    metadata.status !== null &&
    !Array.isArray(metadata.status)
      ? (metadata.status as Record<string, unknown>)
      : {};
  metadata.status = {
    ...prevStatus,
    name: toStatusName,
    statusCategory: categoryKey ? { key: categoryKey } : prevStatus.statusCategory,
  };
  return { ...card, metadata };
}

export interface TransitionCardInput {
  cardId: string;
  transition: KanbanCardTransition;
  // Resolved by the caller from kanbanSourceStatuses when available (see
  // patchCardMetadataStatus doc) — undefined is fine, just less precise
  // ordering until the next sync.
  categoryKey?: string | null;
}

export interface UseKanbanWritebackResult {
  listTransitions: (cardId: string) => Promise<KanbanCardTransition[]>;
  transitionCard: (input: TransitionCardInput) => Promise<void>;
  addComment: (cardId: string, body: string) => Promise<KanbanCardDetailComment>;
  isTransitioning: boolean;
  isAddingComment: boolean;
}

export function useKanbanWriteback({ serverId }: { serverId: string }): UseKanbanWritebackResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const listTransitions = useCallback(
    async (cardId: string): Promise<KanbanCardTransition[]> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanCardListTransitions(cardId);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.transitions ?? [];
    },
    [serverId, t],
  );

  const transitionMutation = useMutation({
    mutationFn: async ({ cardId, transition }: TransitionCardInput): Promise<StoredKanbanCard> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanCardTransition(cardId, transition.id);
      if (payload.error) {
        throw new Error(payload.error);
      }
      if (!payload.card) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return payload.card;
    },
    onMutate: async ({ cardId, transition, categoryKey }): Promise<CardListSnapshot> => {
      await queryClient.cancelQueries({ queryKey: kanbanCardsQueryBaseKey });
      const snapshot = snapshotCards(queryClient);
      if (transition.toStatusName) {
        patchCard(queryClient, cardId, (card) =>
          patchCardMetadataStatus(card, transition.toStatusName as string, categoryKey),
        );
      }
      return snapshot;
    },
    onError: (_error, _input, context) => {
      if (context) {
        restoreCards(queryClient, context);
      }
    },
    onSuccess: (card, { transition, categoryKey }) => {
      // The server response is authoritative for status/columnId but (see
      // patchCardMetadataStatus doc) not metadata — merge, don't replace.
      patchCard(queryClient, card.id, (current) => {
        const merged = { ...current, ...card };
        return transition.toStatusName
          ? patchCardMetadataStatus(merged, transition.toStatusName, categoryKey)
          : merged;
      });
    },
    // No onSettled invalidate: refetching kanban.card.list here would pull
    // back the server's stale metadata and undo the patch above before the
    // next real source sync has a chance to refresh it for real.
  });

  const addCommentMutation = useMutation({
    mutationFn: async ({
      cardId,
      body,
    }: {
      cardId: string;
      body: string;
    }): Promise<KanbanCardDetailComment> => {
      const client = requireClient(serverId, t("common.errors.daemonClientUnavailable"));
      const payload = await client.kanbanCardAddComment(cardId, body);
      if (payload.error) {
        throw new Error(payload.error);
      }
      if (!payload.comment) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return payload.comment;
    },
  });

  const transitionCard = useCallback(
    async (input: TransitionCardInput): Promise<void> => {
      await transitionMutation.mutateAsync(input);
    },
    [transitionMutation],
  );

  const addComment = useCallback(
    async (cardId: string, body: string): Promise<KanbanCardDetailComment> =>
      addCommentMutation.mutateAsync({ cardId, body }),
    [addCommentMutation],
  );

  return {
    listTransitions,
    transitionCard,
    addComment,
    isTransitioning: transitionMutation.isPending,
    isAddingComment: addCommentMutation.isPending,
  };
}
