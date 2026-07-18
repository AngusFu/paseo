import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { KanbanCardTransition } from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

export interface KanbanTransitionPickerSheetProps {
  visible: boolean;
  transitions: KanbanCardTransition[] | null;
  isLoading: boolean;
  isError: boolean;
  onSelect: (transition: KanbanCardTransition) => void;
  onClose: () => void;
}

function KanbanTransitionRow({
  transition,
  onSelect,
}: {
  transition: KanbanCardTransition;
  onSelect: (transition: KanbanCardTransition) => void;
}): ReactElement {
  const handlePress = useCallback(() => onSelect(transition), [onSelect, transition]);
  return (
    <Pressable
      style={styles.row}
      onPress={handlePress}
      accessibilityRole="button"
      testID={`kanban-transition-pick-${transition.id}`}
    >
      <Text style={styles.rowLabel}>{transition.name}</Text>
    </Pressable>
  );
}

/**
 * Native (long-press) path to a real Jira transition — the write-back
 * equivalent of KanbanStatusPickerSheet. Lists the issue's CURRENT legal
 * transitions (fetched live on open, not the board's lane set) since Jira
 * workflows only allow specific next moves from the current status.
 */
export function KanbanTransitionPickerSheet({
  visible,
  transitions,
  isLoading,
  isError,
  onSelect,
  onClose,
}: KanbanTransitionPickerSheetProps): ReactElement {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(() => ({ title: t("kanban.transitions.pick") }), [t]);
  const handleSelect = useCallback(
    (transition: KanbanCardTransition) => {
      onSelect(transition);
      onClose();
    },
    [onSelect, onClose],
  );

  let body: ReactElement;
  if (isLoading) {
    body = (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  } else if (isError) {
    body = <Text style={styles.message}>{t("kanban.transitions.loadError")}</Text>;
  } else if (!transitions || transitions.length === 0) {
    body = <Text style={styles.message}>{t("kanban.transitions.empty")}</Text>;
  } else {
    body = (
      <View style={styles.list}>
        {transitions.map((transition) => (
          <KanbanTransitionRow
            key={transition.id}
            transition={transition}
            onSelect={handleSelect}
          />
        ))}
      </View>
    );
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="kanban-transition-picker-sheet"
    >
      {body}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[1],
  },
  row: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  rowLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  centered: {
    alignItems: "center",
    paddingVertical: theme.spacing[6],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[4],
    textAlign: "center",
  },
}));
