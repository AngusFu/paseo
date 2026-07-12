import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { KanbanColumn } from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { toErrorMessage } from "@/utils/error-messages";

export interface KanbanColumnDeleteSheetProps {
  visible: boolean;
  column: KanbanColumn | null;
  destinations: KanbanColumn[];
  onClose: () => void;
  onConfirm: (moveCardsToColumnId: string) => Promise<void>;
}

const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;
function rowAccessibilityState(selected: boolean) {
  return selected ? SELECTED_STATE : UNSELECTED_STATE;
}

function KanbanColumnDestinationRow({
  destination,
  selected,
  onSelect,
}: {
  destination: KanbanColumn;
  selected: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => onSelect(destination.id), [onSelect, destination.id]);
  return (
    <Pressable
      style={styles.row}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={rowAccessibilityState(selected)}
      testID={`kanban-column-delete-destination-${destination.id}`}
    >
      <Text style={styles.rowLabel}>{destination.title}</Text>
      {selected ? <Check size={16} color={styles.check.color} /> : null}
    </Pressable>
  );
}

/**
 * Confirms deleting a board column. Since cards must land somewhere, the user
 * names the destination column explicitly before the delete is enabled.
 */
export function KanbanColumnDeleteSheet({
  visible,
  column,
  destinations,
  onClose,
  onConfirm,
}: KanbanColumnDeleteSheetProps): ReactElement {
  const { t } = useTranslation();
  const [destinationId, setDestinationId] = useState<string | null>(destinations[0]?.id ?? null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const header = useMemo<SheetHeader>(() => ({ title: t("kanban.columnDelete.title") }), [t]);

  const handleConfirm = useCallback(async () => {
    if (!destinationId) {
      return;
    }
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await onConfirm(destinationId);
      onClose();
    } catch (error) {
      setSubmitError(toErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [destinationId, onClose, onConfirm]);

  const handleConfirmPress = useCallback(() => {
    void handleConfirm();
  }, [handleConfirm]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isSubmitting}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="destructive"
          onPress={handleConfirmPress}
          disabled={!destinationId || isSubmitting}
          loading={isSubmitting}
          testID="kanban-column-delete-confirm"
        >
          {t("kanban.columnDelete.confirm")}
        </Button>
      </View>
    ),
    [destinationId, handleConfirmPress, isSubmitting, onClose, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      testID="kanban-column-delete-sheet"
    >
      <Text style={styles.message}>
        {column ? t("kanban.columnDelete.message", { title: column.title }) : ""}
      </Text>
      <Text style={styles.destinationLabel}>{t("kanban.columnDelete.destinationLabel")}</Text>
      <View style={styles.list}>
        {destinations.map((destination) => (
          <KanbanColumnDestinationRow
            key={destination.id}
            destination={destination}
            selected={destination.id === destinationId}
            onSelect={setDestinationId}
          />
        ))}
      </View>
      {submitError ? <Text style={styles.submitError}>{submitError}</Text> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  message: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[3],
  },
  destinationLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginBottom: theme.spacing[2],
  },
  list: {
    gap: theme.spacing[1],
    marginBottom: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  rowLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  check: {
    color: theme.colors.foreground,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  submitError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
}));
