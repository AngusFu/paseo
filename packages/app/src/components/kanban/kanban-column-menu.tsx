import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ChevronLeft,
  ChevronRight,
  EyeOff,
  MoreVertical,
  Pencil,
  Trash2,
} from "lucide-react-native";
import type { KanbanColumn } from "@getpaseo/protocol/kanban/types";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedEyeOff = withUnistyles(EyeOff);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedTrash2 = withUnistyles(Trash2);

const renameLeadingIcon = <ThemedPencil size={14} uniProps={foregroundMutedColorMapping} />;
const hideLeadingIcon = <ThemedEyeOff size={14} uniProps={foregroundMutedColorMapping} />;
const moveLeftLeadingIcon = <ThemedChevronLeft size={14} uniProps={foregroundMutedColorMapping} />;
const moveRightLeadingIcon = (
  <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} />
);
const deleteLeadingIcon = <ThemedTrash2 size={14} uniProps={foregroundMutedColorMapping} />;

function renderTriggerIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreVertical
      size={14}
      uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
    />
  );
}

interface KanbanColumnMenuProps {
  column: KanbanColumn;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  canDelete: boolean;
  onRename: (column: KanbanColumn) => void;
  onHide: (column: KanbanColumn) => void;
  onMoveLeft: (column: KanbanColumn) => void;
  onMoveRight: (column: KanbanColumn) => void;
  onDelete: (column: KanbanColumn) => void;
}

/** The kebab menu on a board column header: rename, hide, reorder, delete. */
export function KanbanColumnMenu({
  column,
  canMoveLeft,
  canMoveRight,
  canDelete,
  onRename,
  onHide,
  onMoveLeft,
  onMoveRight,
  onDelete,
}: KanbanColumnMenuProps) {
  const { t } = useTranslation();
  const handleRename = useCallback(() => onRename(column), [onRename, column]);
  const handleHide = useCallback(() => onHide(column), [onHide, column]);
  const handleMoveLeft = useCallback(() => onMoveLeft(column), [onMoveLeft, column]);
  const handleMoveRight = useCallback(() => onMoveRight(column), [onMoveRight, column]);
  const handleDelete = useCallback(() => onDelete(column), [onDelete, column]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        style={triggerStyle}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={t("kanban.columnMenu.menu")}
        testID={`kanban-column-menu-${column.id}`}
      >
        {renderTriggerIcon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={200}>
        <DropdownMenuItem
          testID={`kanban-column-menu-rename-${column.id}`}
          leading={renameLeadingIcon}
          onSelect={handleRename}
        >
          {t("kanban.columnMenu.rename")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID={`kanban-column-menu-hide-${column.id}`}
          leading={hideLeadingIcon}
          onSelect={handleHide}
        >
          {t("kanban.columnMenu.hide")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID={`kanban-column-menu-move-left-${column.id}`}
          leading={moveLeftLeadingIcon}
          disabled={!canMoveLeft}
          onSelect={handleMoveLeft}
        >
          {t("kanban.columnMenu.moveLeft")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID={`kanban-column-menu-move-right-${column.id}`}
          leading={moveRightLeadingIcon}
          disabled={!canMoveRight}
          onSelect={handleMoveRight}
        >
          {t("kanban.columnMenu.moveRight")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID={`kanban-column-menu-delete-${column.id}`}
          leading={deleteLeadingIcon}
          disabled={!canDelete}
          onSelect={handleDelete}
        >
          {t("kanban.columnMenu.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function triggerStyle({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.trigger, hovered && styles.triggerHovered];
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: 2,
    borderRadius: 4,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
