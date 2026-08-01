import { useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";

export type KnowledgeBasePagePathSheetMode = "add" | "rename";

export function KnowledgeBasePagePathSheet({
  visible,
  mode,
  submitting,
  path,
  content,
  formError,
  showContentField,
  onClose,
  onPathChange,
  onContentChange,
  onSubmit,
}: {
  visible: boolean;
  mode: KnowledgeBasePagePathSheetMode;
  submitting: boolean;
  path: string;
  content: string;
  formError: string | null;
  showContentField: boolean;
  onClose: () => void;
  onPathChange: (value: string) => void;
  onContentChange: (value: string) => void;
  onSubmit: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(
    () => ({
      title:
        mode === "rename"
          ? t("knowledgeBases.detail.renamePageTitle")
          : t("knowledgeBases.detail.addPageTitle"),
    }),
    [mode, t],
  );

  const footer = useMemo(
    () => (
      <View style={styles.sheetFooter}>
        <Button
          variant="secondary"
          onPress={onClose}
          disabled={submitting}
          style={styles.footerButton}
          textStyle={styles.footerButtonText}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          onPress={onSubmit}
          loading={submitting}
          disabled={submitting}
          style={styles.footerButton}
          textStyle={styles.footerButtonText}
          testID="kb-page-path-submit"
        >
          {mode === "rename"
            ? t("knowledgeBases.detail.renameSubmit")
            : // Prefer short idle CTA so Button's numberOfLines={1} + footer
              // flex:1 cannot ellipsize「创建页面」→「创建...」.
              t("knowledgeBases.createSubmit")}
        </Button>
      </View>
    ),
    [mode, onClose, onSubmit, submitting, t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="kb-page-path-sheet"
      footer={footer}
    >
      <Field label={t("knowledgeBases.detail.pagePath")}>
        <FormTextInput
          size="sm"
          value={path}
          onChangeText={onPathChange}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!submitting}
          placeholder={t("knowledgeBases.detail.pagePathPlaceholder")}
          testID="kb-page-path-input"
        />
      </Field>

      {showContentField ? (
        <Field label={t("knowledgeBases.detail.optionalContent")}>
          <FormTextInput
            size="sm"
            value={content}
            onChangeText={onContentChange}
            editable={!submitting}
            placeholder={t("knowledgeBases.detail.markdownPlaceholder")}
            style={styles.multilineInput}
            multiline
            numberOfLines={8}
            textAlignVertical="top"
            testID="kb-page-content-input"
          />
        </Field>
      ) : null}

      {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  sheetFooter: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  footerButton: {
    flex: 1,
  },
  // Button label defaults to flexShrink:1 + numberOfLines:1; keep full idle
  // copy (e.g. zh-CN「创建页面」) from truncating to「创建...」.
  footerButtonText: {
    flexShrink: 0,
  },
  multilineInput: {
    minHeight: 160,
    paddingTop: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
  },
}));
