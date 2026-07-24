import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useLocalLlmModel } from "@/hooks/use-local-llm-model";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import {
  createLocalLlmPatch,
  localLlmDraftHasChanges,
  readLocalLlmDraft,
} from "@/screens/settings/local-llm-config";
import { settingsStyles } from "@/styles/settings";

// Host-settings card for the daemon's OpenAI-compatible local LLM backend.
export function LocalLlmCard({ serverId }: { serverId: string }) {
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

  const handleSave = useCallback(() => {
    saveMutation.mutate();
  }, [saveMutation]);

  const handleTest = useCallback(() => {
    testMutation.mutate();
  }, [testMutation]);

  const handleBaseUrlChange = useCallback((baseUrl: string) => {
    setDraft((prev) => ({ ...prev, baseUrl }));
  }, []);

  const handleApiKeyChange = useCallback((apiKey: string) => {
    setDraft((prev) => ({ ...prev, apiKey }));
  }, []);

  const handleModelChange = useCallback((modelName: string) => {
    setDraft((prev) => ({ ...prev, model: modelName }));
  }, []);

  if (!supported || !isConnected) return null;

  const hasChanges = localLlmDraftHasChanges(draft, persisted);
  const isBusy = saveMutation.isPending || testMutation.isPending;

  let badge: React.ReactNode = null;
  if (model?.status === "ready") {
    badge = <StatusBadge label={t("settings.host.localLlm.ready")} variant="success" />;
  } else if (model?.status === "error") {
    badge = <StatusBadge label={t("settings.host.localLlm.error")} variant="error" />;
  }

  return (
    <SettingsSection title={t("settings.host.localLlm.title")} testID="host-page-local-llm-card">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowHint}>{t("settings.host.localLlm.hint")}</Text>
            {model?.status === "error" ? (
              <Text style={settingsStyles.rowError} testID="host-page-local-llm-error">
                {model.message}
              </Text>
            ) : null}
            {saveMutation.error ? (
              <Text style={settingsStyles.rowError}>{String(saveMutation.error)}</Text>
            ) : null}
            {testMutation.error ? (
              <Text style={settingsStyles.rowError}>{String(testMutation.error)}</Text>
            ) : null}
          </View>
          {badge}
        </View>

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
          <FormTextInput
            size="sm"
            value={draft.model}
            onChangeText={handleModelChange}
            placeholder={t("settings.host.localLlm.modelPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!isBusy}
            testID="host-page-local-llm-model-input"
          />
        </Field>

        <View style={settingsStyles.row}>
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
            disabled={isBusy || !draft.baseUrl.trim() || !draft.model.trim()}
            loading={testMutation.isPending}
            onPress={handleTest}
            testID="host-page-local-llm-test"
          >
            {t("settings.host.localLlm.test")}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}
