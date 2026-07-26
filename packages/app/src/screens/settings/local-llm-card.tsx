import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { LlmLocalModelState } from "@getpaseo/protocol/llm/rpc-schemas";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useLocalLlmModel } from "@/hooks/use-local-llm-model";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  DEFAULT_LOCAL_LLM_BASE_URL,
  LOCAL_LLM_PROSE_CHECK_MODEL,
  createLocalLlmPatch,
  localLlmDraftHasChanges,
  readLocalLlmDraft,
} from "@/screens/settings/local-llm-config";
import { settingsStyles } from "@/styles/settings";

function resolveLocalLlmErrorText(args: {
  model: LlmLocalModelState | null | undefined;
  saveError: unknown;
  testError: unknown;
  useOllamaError: unknown;
}): string | null {
  if (args.model?.status === "error") {
    return args.model.message;
  }
  if (args.saveError) {
    return String(args.saveError);
  }
  if (args.testError) {
    return String(args.testError);
  }
  if (args.useOllamaError) {
    return String(args.useOllamaError);
  }
  return null;
}

/**
 * Local AI (Ollama) fields nested under the prose-stop settings card.
 * Model is fixed to {@link LOCAL_LLM_PROSE_CHECK_MODEL}; only base URL / API key
 * are editable. Renders nothing when the host lacks the localLlm capability.
 */
export function ProseStopLocalLlmSection({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const client = useHostRuntimeClient(serverId);
  const { supported, model, refreshStatus } = useLocalLlmModel(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const persisted = useMemo(() => readLocalLlmDraft(config), [config]);
  const [draft, setDraft] = useState(persisted);

  useEffect(() => {
    setDraft(persisted);
  }, [persisted]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const result = await patchConfig(createLocalLlmPatch(draft));
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return result;
    },
    onSuccess: () => {
      void refreshStatus();
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      if (localLlmDraftHasChanges(draft, persisted)) {
        await saveMutation.mutateAsync();
      }
      const payload = await client.llmLocalGenerate({
        prompt: "Reply with exactly: ok",
        maxTokens: 16,
      });
      if (payload.error || !payload.text?.trim()) {
        throw new Error(payload.error ?? t("settings.host.localLlm.testFailed"));
      }
      await refreshStatus();
    },
  });

  const useOllamaMutation = useMutation({
    mutationFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const baseUrl = DEFAULT_LOCAL_LLM_BASE_URL;
      setDraft((prev) => ({ ...prev, baseUrl }));
      const payload = await client.llmLocalOllamaListModels({
        baseUrl,
        apiKey: draft.apiKey.trim() || undefined,
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
      // Listing is a connectivity probe; model stays fixed for prose check.
      return payload;
    },
  });

  const handleSave = useCallback(() => {
    saveMutation.mutate();
  }, [saveMutation]);

  const handleTest = useCallback(() => {
    testMutation.mutate();
  }, [testMutation]);

  const handleUseOllama = useCallback(() => {
    useOllamaMutation.mutate();
  }, [useOllamaMutation]);

  const handleBaseUrlChange = useCallback((baseUrl: string) => {
    setDraft((prev) => ({ ...prev, baseUrl }));
  }, []);

  const handleApiKeyChange = useCallback((apiKey: string) => {
    setDraft((prev) => ({ ...prev, apiKey }));
  }, []);

  if (!supported || !isConnected) return null;

  const hasChanges = localLlmDraftHasChanges(draft, persisted);
  const isBusy = saveMutation.isPending || testMutation.isPending || useOllamaMutation.isPending;
  const errorText = resolveLocalLlmErrorText({
    model,
    saveError: saveMutation.error,
    testError: testMutation.error,
    useOllamaError: useOllamaMutation.error,
  });

  let badge: React.ReactNode = null;
  if (model?.status === "ready") {
    badge = <StatusBadge label={t("settings.host.localLlm.ready")} variant="success" />;
  } else if (model?.status === "error") {
    badge = <StatusBadge label={t("settings.host.localLlm.error")} variant="error" />;
  }

  return (
    <View style={styles.section} testID="host-page-local-llm-section">
      <View style={[settingsStyles.row, styles.headerRow]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.host.localLlm.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("settings.host.localLlm.hint")}</Text>
          {errorText ? (
            <Text style={settingsStyles.rowError} testID="host-page-local-llm-error">
              {errorText}
            </Text>
          ) : null}
        </View>
        {badge}
      </View>

      <View style={styles.formBody}>
        <Field label={t("settings.host.localLlm.baseUrl")} testID="host-page-local-llm-base-url">
          <FormTextInput
            size="sm"
            value={draft.baseUrl}
            onChangeText={handleBaseUrlChange}
            placeholder={t("settings.host.localLlm.baseUrlPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isBusy}
            testID="host-page-local-llm-base-url-input"
          />
        </Field>

        <Field label={t("settings.host.localLlm.apiKey")} testID="host-page-local-llm-api-key">
          <FormTextInput
            size="sm"
            value={draft.apiKey}
            onChangeText={handleApiKeyChange}
            placeholder={t("settings.host.localLlm.apiKeyPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            editable={!isBusy}
            testID="host-page-local-llm-api-key-input"
          />
        </Field>

        <Field label={t("settings.host.localLlm.model")} testID="host-page-local-llm-model">
          <Text style={styles.fixedModel} testID="host-page-local-llm-model-fixed">
            {LOCAL_LLM_PROSE_CHECK_MODEL}
          </Text>
          <Text style={settingsStyles.rowHint}>{t("settings.host.localLlm.modelFixedHint")}</Text>
          <View style={styles.fetchRow}>
            <Button
              size="sm"
              variant="secondary"
              disabled={isBusy}
              loading={useOllamaMutation.isPending}
              onPress={handleUseOllama}
              testID="host-page-local-llm-use-ollama"
            >
              {t("settings.host.localLlm.useOllama")}
            </Button>
          </View>
        </Field>
      </View>

      <View style={[settingsStyles.row, styles.footerRow]}>
        <Button
          size="sm"
          variant="outline"
          disabled={!hasChanges || isBusy}
          loading={saveMutation.isPending}
          onPress={handleSave}
          testID="host-page-local-llm-save"
        >
          {t("settings.host.localLlm.save")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={isBusy || !draft.baseUrl.trim()}
          loading={testMutation.isPending}
          onPress={handleTest}
          testID="host-page-local-llm-test"
        >
          {t("settings.host.localLlm.test")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  headerRow: {
    alignItems: "flex-start",
  },
  formBody: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  fixedModel: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  fetchRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  footerRow: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: theme.spacing[2],
    justifyContent: "flex-end",
  },
}));
