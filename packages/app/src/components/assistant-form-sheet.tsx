import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import type { AssistantDraft, LocalAssistant } from "@/stores/assistant-store";

export interface AssistantFormSheetProps {
  visible: boolean;
  /** null creates a new assistant; otherwise the one being edited. */
  assistant: LocalAssistant | null;
  onClose: () => void;
  onSubmit: (draft: AssistantDraft) => void;
  onDelete?: (assistant: LocalAssistant) => void;
}

/**
 * Create or edit an assistant. An assistant is a name and a system prompt —
 * there is nothing else to configure, so this stays two fields rather than a
 * settings screen. Tool access is deliberately absent: only the seeded Paseo
 * assistant can act on the user's data, and a prompt typed here should not be
 * able to grant itself that.
 */
export function AssistantFormSheet({
  visible,
  assistant,
  onClose,
  onSubmit,
  onDelete,
}: AssistantFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");

  // Reset whenever the sheet opens so a previous edit never leaks into the
  // next one; keyed on the assistant so switching targets refills the fields.
  useEffect(() => {
    if (!visible) {
      return;
    }
    setName(assistant?.name ?? "");
    setSystemPrompt(assistant?.systemPrompt ?? "");
  }, [assistant, visible]);

  const canSubmit = name.trim().length > 0 && systemPrompt.trim().length > 0;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) {
      return;
    }
    onSubmit({ name, systemPrompt });
    onClose();
  }, [canSubmit, name, onClose, onSubmit, systemPrompt]);

  const handleDelete = useCallback(() => {
    if (!assistant || !onDelete) {
      return;
    }
    onDelete(assistant);
    onClose();
  }, [assistant, onClose, onDelete]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: assistant ? t("assistant.form.editTitle") : t("assistant.form.createTitle"),
    }),
    [assistant, t],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        {/* Delete sits left, away from the confirming action (docs/forms.md). */}
        <View style={styles.footerStart}>
          {assistant && onDelete ? (
            <Button variant="destructive" onPress={handleDelete} testID="assistant-form-delete">
              {t("common.actions.delete")}
            </Button>
          ) : null}
        </View>
        <Button variant="outline" onPress={onClose} testID="assistant-form-cancel">
          {t("common.actions.cancel")}
        </Button>
        <Button onPress={handleSubmit} disabled={!canSubmit} testID="assistant-form-submit">
          {t("common.actions.save")}
        </Button>
      </View>
    ),
    [assistant, canSubmit, handleDelete, handleSubmit, onClose, onDelete, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      webScrollbar
      testID="assistant-form-sheet"
    >
      <Field label={t("assistant.form.name")}>
        <FormTextInput
          testID="assistant-form-name"
          accessibilityLabel={t("assistant.form.name")}
          initialValue={name}
          value={name}
          onChangeText={setName}
          placeholder={t("assistant.form.namePlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <Field label={t("assistant.form.prompt")} hint={t("assistant.form.promptHint")}>
        <FormTextInput
          testID="assistant-form-prompt"
          accessibilityLabel={t("assistant.form.prompt")}
          initialValue={systemPrompt}
          value={systemPrompt}
          onChangeText={setSystemPrompt}
          placeholder={t("assistant.form.promptPlaceholder")}
          multiline
          numberOfLines={8}
          style={styles.promptInput}
        />
      </Field>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  footerStart: {
    flex: 1,
    flexDirection: "row",
  },
  promptInput: {
    minHeight: 160,
    textAlignVertical: "top",
  },
}));
