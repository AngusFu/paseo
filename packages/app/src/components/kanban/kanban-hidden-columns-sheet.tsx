import { useCallback, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { KanbanColumn } from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";

export interface KanbanHiddenColumnsSheetProps {
  visible: boolean;
  columns: KanbanColumn[];
  onClose: () => void;
  onRestore: (columnId: string) => void;
}

function KanbanHiddenColumnRow({
  column,
  onRestore,
}: {
  column: KanbanColumn;
  onRestore: (columnId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleRestore = useCallback(() => onRestore(column.id), [onRestore, column.id]);
  return (
    <View style={styles.row} testID={`kanban-hidden-column-${column.id}`}>
      <Text style={styles.rowLabel} numberOfLines={1}>
        {column.title}
      </Text>
      <Pressable
        style={styles.restoreButton}
        onPress={handleRestore}
        accessibilityRole="button"
        accessibilityLabel={t("kanban.hiddenColumns.restore")}
        testID={`kanban-hidden-column-restore-${column.id}`}
      >
        <Text style={styles.restoreLabel}>{t("kanban.hiddenColumns.restore")}</Text>
      </Pressable>
    </View>
  );
}

/** Lists hidden board columns with a one-tap restore. */
export function KanbanHiddenColumnsSheet({
  visible,
  columns,
  onClose,
  onRestore,
}: KanbanHiddenColumnsSheetProps): ReactElement {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(() => ({ title: t("kanban.hiddenColumns.title") }), [t]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="kanban-hidden-columns-sheet"
    >
      {columns.length === 0 ? (
        <Text style={styles.emptyText} testID="kanban-hidden-columns-empty">
          {t("kanban.hiddenColumns.empty")}
        </Text>
      ) : (
        <View style={styles.list}>
          {columns.map((column) => (
            <KanbanHiddenColumnRow key={column.id} column={column} onRestore={onRestore} />
          ))}
        </View>
      )}
      <Button variant="secondary" onPress={onClose}>
        {t("common.actions.close")}
      </Button>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[3],
  },
  list: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  restoreButton: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface3,
  },
  restoreLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
}));
