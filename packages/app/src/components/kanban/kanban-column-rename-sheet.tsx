import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { KanbanColumn } from "@getpaseo/protocol/kanban/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { toErrorMessage } from "@/utils/error-messages";

export interface KanbanColumnRenameSheetProps {
  visible: boolean;
  column: KanbanColumn | null;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
}

/** Small sheet to rename a board column's title. */
export function KanbanColumnRenameSheet({
  visible,
  column,
  onClose,
  onSave,
}: KanbanColumnRenameSheetProps): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [title, setTitle] = useState(column?.title ?? "");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canSubmit = title.trim().length > 0 && !isSubmitting;

  const header = useMemo<SheetHeader>(() => ({ title: t("kanban.columnForm.renameTitle") }), [t]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      await onSave(title.trim());
      onClose();
    } catch (error) {
      setSubmitError(toErrorMessage(error));
    } finally {
      setIsSubmitting(false);
    }
  }, [canSubmit, onClose, onSave, title]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

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
          testID="kanban-column-rename-submit"
        >
          {t("kanban.form.save")}
        </Button>
      </View>
    ),
    [canSubmit, handleSubmitPress, isSubmitting, onClose, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      testID="kanban-column-rename-sheet"
    >
      <Field label={t("kanban.columnForm.titleLabel")}>
        <FormTextInput
          size={controlSize}
          testID="kanban-column-rename-input"
          accessibilityLabel={t("kanban.columnForm.titleLabel")}
          initialValue={title}
          value={title}
          onChangeText={setTitle}
          placeholder={t("kanban.columnForm.titlePlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      {submitError ? <Text style={styles.submitError}>{submitError}</Text> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
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
