import { useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { toErrorMessage } from "@/utils/error-messages";

export interface KanbanAddColumnProps {
  onCreate: (title: string) => Promise<void>;
}

/** Ghost "column" at the end of the board row: click to reveal a title input. */
export function KanbanAddColumn({ onCreate }: KanbanAddColumnProps): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const startEditing = useCallback(() => setEditing(true), []);
  const cancelEditing = useCallback(() => {
    setEditing(false);
    setTitle("");
    setSubmitError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || isSubmitting) {
      return;
    }
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await onCreate(trimmed);
      setTitle("");
      setEditing(false);
    } catch (error) {
      setSubmitError(toErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [isSubmitting, onCreate, title]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  if (!editing) {
    return (
      <Pressable
        style={styles.ghost}
        onPress={startEditing}
        accessibilityRole="button"
        accessibilityLabel={t("kanban.columnForm.addColumn")}
        testID="kanban-add-column"
      >
        <Plus size={16} color={styles.ghostIcon.color} />
        <Text style={styles.ghostLabel}>{t("kanban.columnForm.addColumn")}</Text>
      </Pressable>
    );
  }

  return (
    <View style={styles.editing} testID="kanban-add-column-form">
      <FormTextInput
        size={controlSize}
        testID="kanban-add-column-input"
        accessibilityLabel={t("kanban.columnForm.titleLabel")}
        initialValue={title}
        value={title}
        onChangeText={setTitle}
        placeholder={t("kanban.columnForm.newColumnPlaceholder")}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
      />
      {submitError ? <Text style={styles.submitError}>{submitError}</Text> : null}
      <View style={styles.editingActions}>
        <Button
          style={styles.editingButton}
          variant="secondary"
          size="sm"
          onPress={cancelEditing}
          disabled={isSubmitting}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.editingButton}
          variant="default"
          size="sm"
          onPress={handleSubmitPress}
          disabled={title.trim().length === 0 || isSubmitting}
          loading={isSubmitting}
          testID="kanban-add-column-submit"
        >
          {t("kanban.columnForm.create")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  ghost: {
    width: 260,
    flexShrink: 0,
    alignSelf: "stretch",
    minHeight: 200,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
  },
  ghostIcon: {
    color: theme.colors.foregroundMuted,
  },
  ghostLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  editing: {
    width: 260,
    flexShrink: 0,
    alignSelf: "flex-start",
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  editingActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  editingButton: {
    flex: 1,
  },
  submitError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
}));
