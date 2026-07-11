import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { KANBAN_STATUS_ORDER, type KanbanStatus } from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";

export interface KanbanStatusPickerSheetProps {
  visible: boolean;
  currentStatus?: KanbanStatus;
  onSelect: (status: KanbanStatus) => void;
  onClose: () => void;
}

function KanbanStatusPickerRow({
  status,
  label,
  selected,
  onSelect,
}: {
  status: KanbanStatus;
  label: string;
  selected: boolean;
  onSelect: (status: KanbanStatus) => void;
}): ReactElement {
  const handlePress = useCallback(() => onSelect(status), [onSelect, status]);
  return (
    <Pressable
      style={styles.row}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={rowAccessibilityState(selected)}
      testID={`kanban-status-pick-${status}`}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      {selected ? <Check size={16} color={styles.check.color} /> : null}
    </Pressable>
  );
}

const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;
function rowAccessibilityState(selected: boolean) {
  return selected ? SELECTED_STATE : UNSELECTED_STATE;
}

/**
 * The native (and always-available) path to change a card's column: a sheet
 * listing the six statuses. Picking one moves the card. Web uses drag instead,
 * but this stays reachable so touch devices always have a way to move a card.
 */
export function KanbanStatusPickerSheet({
  visible,
  currentStatus,
  onSelect,
  onClose,
}: KanbanStatusPickerSheetProps): ReactElement {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(() => ({ title: t("kanban.status.pick") }), [t]);
  const handleSelect = useCallback(
    (status: KanbanStatus) => {
      onSelect(status);
      onClose();
    },
    [onSelect, onClose],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="kanban-status-picker-sheet"
    >
      <View style={styles.list}>
        {KANBAN_STATUS_ORDER.map((status) => (
          <KanbanStatusPickerRow
            key={status}
            status={status}
            label={t(`kanban.columns.${status}`)}
            selected={status === currentStatus}
            onSelect={handleSelect}
          />
        ))}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  check: {
    color: theme.colors.foreground,
  },
}));
