import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  KANBAN_STATUS_ORDER,
  type KanbanStatus,
  type StoredKanbanCard,
} from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { resolveKanbanCardTheme } from "@/components/kanban/kanban-card-theme";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import type { CreateKanbanCardInput, UpdateKanbanCardInput } from "@/hooks/use-kanban-mutations";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";

// Built-in theme presets. "none" stores an empty string (default grey); the
// others map to the icon+color pairs resolveKanbanCardTheme already understands.
const THEME_PRESETS = [
  { key: "none", value: "" },
  { key: "jira", value: "jira" },
  { key: "gitlab", value: "gitlab-mr" },
] as const;

// Color-tag palette. Selecting one stores "#RRGGBB" as the theme.
const THEME_COLORS = [
  "#EF4444",
  "#F97316",
  "#EAB308",
  "#22C55E",
  "#3B82F6",
  "#8B5CF6",
  "#EC4899",
  "#6B7280",
] as const;

const SWATCH_CHECK_COLOR = "#FFFFFF";

export interface KanbanCardSheetProps {
  visible: boolean;
  mode: "create" | "edit";
  card?: StoredKanbanCard;
  onClose: () => void;
  onCreate: (input: CreateKanbanCardInput) => Promise<void>;
  onUpdate: (input: UpdateKanbanCardInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function KanbanStatusPill({
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
  const pillStyle = useMemo(
    () => [styles.statusPill, selected && styles.statusPillSelected],
    [selected],
  );
  const textStyle = useMemo(
    () => [styles.statusPillText, selected && styles.statusPillTextSelected],
    [selected],
  );
  return (
    <Pressable
      style={pillStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={selected ? PILL_SELECTED_STATE : PILL_UNSELECTED_STATE}
      testID={`kanban-status-option-${status}`}
    >
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

const PILL_SELECTED_STATE = { selected: true } as const;
const PILL_UNSELECTED_STATE = { selected: false } as const;

function KanbanThemePreset({
  presetKey,
  value,
  label,
  selected,
  onSelect,
}: {
  presetKey: string;
  value: string;
  label: string;
  selected: boolean;
  onSelect: (value: string) => void;
}): ReactElement {
  const visual = resolveKanbanCardTheme(value);
  const iconColor = visual.color ?? styles.presetDefaultGlyph.color;
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  const chipStyle = useMemo(
    () => [styles.presetChip, selected && styles.presetChipSelected],
    [selected],
  );
  return (
    <Pressable
      style={chipStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityState={selected ? PILL_SELECTED_STATE : PILL_UNSELECTED_STATE}
      testID={`kanban-theme-preset-${presetKey}`}
    >
      <visual.icon size={14} color={iconColor} />
      <Text style={styles.presetLabel}>{label}</Text>
    </Pressable>
  );
}

function KanbanColorSwatch({
  color,
  label,
  selected,
  onSelect,
}: {
  color: string;
  label: string;
  selected: boolean;
  onSelect: (value: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => onSelect(color), [onSelect, color]);
  const swatchStyle = useMemo(
    () => [styles.swatch, { backgroundColor: color }, selected && styles.swatchSelected],
    [color, selected],
  );
  return (
    <Pressable
      style={swatchStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected ? PILL_SELECTED_STATE : PILL_UNSELECTED_STATE}
      testID={`kanban-theme-color-${color}`}
    >
      {selected ? <Check size={14} color={SWATCH_CHECK_COLOR} /> : null}
    </Pressable>
  );
}

/**
 * Create / edit / delete a Kanban card. A simplified sibling of the schedule
 * form sheet: title + url + theme text fields and a status picker, plus a
 * destructive delete in edit mode.
 */
export function KanbanCardSheet({
  visible,
  mode,
  card,
  onClose,
  onCreate,
  onUpdate,
  onDelete,
}: KanbanCardSheetProps): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";

  const [title, setTitle] = useState(card?.title ?? "");
  const [url, setUrl] = useState(card?.url ?? "");
  const [theme, setTheme] = useState(card?.theme ?? "");
  const [status, setStatus] = useState<KanbanStatus>(card?.status ?? "pending");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit = title.trim().length > 0 && !isSubmitting;

  const header = useMemo<SheetHeader>(
    () => ({
      title: mode === "edit" ? t("kanban.form.editTitle") : t("kanban.form.createTitle"),
    }),
    [mode, t],
  );

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const trimmedTheme = theme.trim();
      const trimmedUrl = url.trim();
      if (mode === "edit" && card) {
        await onUpdate({
          id: card.id,
          title: title.trim(),
          url: trimmedUrl || null,
          status,
          // Always send theme on edit (empty string clears it) so the user can
          // reset a card back to the default grey. The update RPC accepts an
          // empty string (protocol theme has no min length).
          theme: trimmedTheme,
        });
      } else {
        await onCreate({
          title: title.trim(),
          url: trimmedUrl || null,
          status,
          ...(trimmedTheme ? { theme: trimmedTheme } : {}),
        });
      }
      onClose();
    } catch (error) {
      setSubmitError(toErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [canSubmit, card, mode, onClose, onCreate, onUpdate, status, theme, title, url]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const handleDelete = useCallback(() => {
    if (!card) {
      return;
    }
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("kanban.card.delete"),
        message: t("kanban.confirmDelete", { title: card.title }),
        confirmLabel: t("kanban.card.delete"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      try {
        await onDelete(card.id);
        onClose();
      } catch (error) {
        setSubmitError(toErrorMessage(error));
      }
    })();
  }, [card, onClose, onDelete, t]);

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
          variant="default"
          onPress={handleSubmitPress}
          disabled={!canSubmit}
          loading={isSubmitting}
          testID="kanban-card-submit"
        >
          {mode === "edit" ? t("kanban.form.save") : t("kanban.form.create")}
        </Button>
      </View>
    ),
    [canSubmit, handleSubmitPress, isSubmitting, mode, onClose, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      webScrollbar
      testID="kanban-card-sheet"
    >
      <Field label={t("kanban.form.title")}>
        <FormTextInput
          size={controlSize}
          testID="kanban-title-input"
          accessibilityLabel={t("kanban.form.title")}
          initialValue={title}
          value={title}
          onChangeText={setTitle}
          placeholder={t("kanban.form.titlePlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <Field label={t("kanban.form.url")}>
        <FormTextInput
          size={controlSize}
          testID="kanban-url-input"
          accessibilityLabel={t("kanban.form.url")}
          initialValue={url}
          value={url}
          onChangeText={setUrl}
          placeholder={t("kanban.form.urlPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
      </Field>

      <Field label={t("kanban.form.theme")}>
        <View style={styles.themeGroup}>
          <View style={styles.presetRow}>
            {THEME_PRESETS.map((preset) => (
              <KanbanThemePreset
                key={preset.key}
                presetKey={preset.key}
                value={preset.value}
                label={t(`kanban.theme.${preset.key}`)}
                selected={theme === preset.value}
                onSelect={setTheme}
              />
            ))}
          </View>
          <View style={styles.swatchRow}>
            {THEME_COLORS.map((color) => (
              <KanbanColorSwatch
                key={color}
                color={color}
                label={`${t("kanban.theme.color")} ${color}`}
                selected={theme.toLowerCase() === color.toLowerCase()}
                onSelect={setTheme}
              />
            ))}
          </View>
        </View>
      </Field>

      <Field label={t("kanban.form.status")}>
        <View style={styles.statusRow}>
          {KANBAN_STATUS_ORDER.map((option) => (
            <KanbanStatusPill
              key={option}
              status={option}
              label={t(`kanban.columns.${option}`)}
              selected={option === status}
              onSelect={setStatus}
            />
          ))}
        </View>
      </Field>

      {mode === "edit" && card ? (
        <Button
          variant="ghost"
          onPress={handleDelete}
          disabled={isSubmitting}
          testID="kanban-card-delete"
        >
          {t("kanban.card.delete")}
        </Button>
      ) : null}

      {submitError ? <Text style={styles.submitError}>{submitError}</Text> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  statusRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  statusPill: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
  },
  statusPillSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface3,
  },
  statusPillText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  statusPillTextSelected: {
    color: theme.colors.foreground,
  },
  themeGroup: {
    gap: theme.spacing[3],
  },
  presetRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  presetChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface2,
  },
  presetChipSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface3,
  },
  presetLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  // Static color holder for the "none" preset glyph (default grey).
  presetDefaultGlyph: {
    color: theme.colors.foregroundMuted,
  },
  swatchRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  swatch: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "transparent",
  },
  swatchSelected: {
    borderColor: theme.colors.foreground,
  },
  submitError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
}));
