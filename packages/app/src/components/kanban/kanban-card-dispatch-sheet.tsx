import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { StoredKanbanCard } from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { DispatchSection } from "@/components/kanban/kanban-card-detail-sheet";
import { useFrozenWhileHidden } from "@/hooks/use-frozen-while-hidden";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export interface KanbanCardDispatchSheetProps {
  visible: boolean;
  card: StoredKanbanCard | null;
  serverId: string | null;
  onClose: () => void;
}

/**
 * Quick-launch dispatch panel, opened straight from a card's hover button so the
 * user can dispatch an agent without first loading the full detail sheet. The
 * dispatch panel works from the base card alone (detail is optional), so this
 * passes detail={null}.
 */
export function KanbanCardDispatchSheet({
  visible,
  card,
  serverId,
  onClose,
}: KanbanCardDispatchSheetProps): ReactElement {
  const { t } = useTranslation();
  // Keep the card during the close animation so the panel doesn't blank out.
  const frozenCard = useFrozenWhileHidden(visible, card);
  const header = useMemo<SheetHeader>(
    () => ({ title: frozenCard?.title ?? t("kanban.cardDetail.dispatch") }),
    [frozenCard?.title, t],
  );

  // On dispatch, close this panel and jump the user to the new agent.
  const handleDispatched = useCallback(
    (agentId: string) => {
      onClose();
      if (serverId) {
        navigateToAgent({ serverId, agentId, pin: true });
      }
    },
    [onClose, serverId],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      webScrollbar
      testID="kanban-card-dispatch-sheet"
    >
      {frozenCard ? (
        <DispatchSection
          card={frozenCard}
          detail={null}
          serverId={serverId}
          onDispatched={handleDispatched}
        />
      ) : null}
    </AdaptiveModalSheet>
  );
}
