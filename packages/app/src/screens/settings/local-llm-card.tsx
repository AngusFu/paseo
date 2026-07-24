import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { LlmLocalModelState } from "@getpaseo/protocol/llm/rpc-schemas";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useLocalLlmModel } from "@/hooks/use-local-llm-model";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import {
  DEFAULT_LOCAL_LLM_BASE_URL,
  createLocalLlmPatch,
  localLlmDraftHasChanges,
  readLocalLlmDraft,
  type LocalLlmDraft,
} from "@/screens/settings/local-llm-config";
import { settingsStyles } from "@/styles/settings";

function resolveLocalLlmErrorText(args: {
  model: LlmLocalModelState | null | undefined;
  saveError: unknown;
  testError: unknown;
  fetchError: unknown;
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
  if (args.fetchError) {
    return String(args.fetchError);
  }
  return null;
}

function LocalLlmModelField(props: {
  draft: LocalLlmDraft;
  selectOptions: SelectFieldOption<string>[];
  selectedDisplay: { label: string } | null;
  hasFetchedModels: boolean;
  isBusy: boolean;
  fetchPending: boolean;
  useOllamaPending: boolean;
  onModelTextChange: (value: string) => void;
  onModelSelect: (value: string, display: { label: string }) => void;
  onUseOllama: () => void;
  onFetchModels: () => void;
}) {
  const { t } = useTranslation();
  const showSelect = props.hasFetchedModels || props.selectOptions.length > 0;

  return (
    <Field label={t("settings.host.localLlm.model")} testID="host-page-local-llm-model">
      {showSelect ? (
        <SelectField
          field={false}
          label={t("settings.host.localLlm.model")}
          value={props.draft.model.trim() || null}
          selectedDisplay={props.selectedDisplay}
          options={props.selectOptions}
          onChange={props.onModelSelect}
          placeholder={t("settings.host.localLlm.modelPlaceholder")}
          emptyText={t("settings.host.localLlm.modelEmpty")}
          searchable
          searchPlaceholder={t("settings.host.localLlm.modelSearchPlaceholder")}
          loading={props.fetchPending || props.useOllamaPending}
          disabled={props.isBusy}
          size="sm"
          testID="host-page-local-llm-model-select"
          triggerTestID="host-page-local-llm-model-trigger"
        />
      ) : (
        <FormTextInput
          size="sm"
          value={props.draft.model}
          onChangeText={props.onModelTextChange}
          placeholder={t("settings.host.localLlm.modelPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!props.isBusy}
          testID="host-page-local-llm-model-input"
        />
      )}
      <View style={styles.fetchRow}>
        <Button
          size="sm"
          variant="secondary"
          disabled={props.isBusy}
          loading={props.useOllamaPending}
          onPress={props.onUseOllama}
          testID="host-page-local-llm-use-ollama"
        >
          {t("settings.host.localLlm.useOllama")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={props.isBusy}
          loading={props.fetchPending}
          onPress={props.onFetchModels}
          testID="host-page-local-llm-fetch-models"
        >
          {t("settings.host.localLlm.fetchModels")}
        </Button>
      </View>
    </Field>
  );
}

// Host-settings card for the daemon's OpenAI-compatible local LLM backend.
export function LocalLlmCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const client = useHostRuntimeClient(serverId);
  const { supported, model, refreshStatus } = useLocalLlmModel(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const persisted = useMemo(() => readLocalLlmDraft(config), [config]);
  const [draft, setDraft] = useState(persisted);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [hasFetchedModels, setHasFetchedModels] = useState(false);

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

  const applyListedModels = useCallback(
    (models: string[], preferredModel?: string) => {
      setHasFetchedModels(true);
      setModelOptions(models);
      const current = (preferredModel ?? draft.model).trim();
      if (models.length > 0 && (!current || !models.includes(current))) {
        setDraft((prev) => ({ ...prev, model: models[0] ?? prev.model }));
      }
    },
    [draft.model],
  );

  const fetchModelsMutation = useMutation({
    mutationFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const baseUrl = draft.baseUrl.trim() || DEFAULT_LOCAL_LLM_BASE_URL;
      if (!draft.baseUrl.trim()) {
        setDraft((prev) => ({ ...prev, baseUrl }));
      }
      const payload = await client.llmLocalOllamaListModels({
        baseUrl,
        apiKey: draft.apiKey.trim() || undefined,
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
      applyListedModels(payload.models);
      return payload;
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
      applyListedModels(payload.models);
      return payload;
    },
  });

  // Probe once on connect so the model select can prefill when Ollama is already up.
  useEffect(() => {
    if (!supported || !isConnected || !client) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const payload = await client.llmLocalOllamaListModels({
          baseUrl: persisted.baseUrl.trim() || undefined,
          apiKey: persisted.apiKey.trim() || undefined,
        });
        if (cancelled) {
          return;
        }
        if (payload.models.length > 0) {
          setHasFetchedModels(true);
          setModelOptions(payload.models);
        }
      } catch {
        // Probe is best-effort; manual buttons remain available.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported, isConnected, client, persisted.baseUrl, persisted.apiKey]);

  const handleSave = useCallback(() => {
    saveMutation.mutate();
  }, [saveMutation]);

  const handleTest = useCallback(() => {
    testMutation.mutate();
  }, [testMutation]);

  const handleFetchModels = useCallback(() => {
    fetchModelsMutation.mutate();
  }, [fetchModelsMutation]);

  const handleUseOllama = useCallback(() => {
    useOllamaMutation.mutate();
  }, [useOllamaMutation]);

  const handleBaseUrlChange = useCallback((baseUrl: string) => {
    setDraft((prev) => ({ ...prev, baseUrl }));
  }, []);

  const handleApiKeyChange = useCallback((apiKey: string) => {
    setDraft((prev) => ({ ...prev, apiKey }));
  }, []);

  const handleModelTextChange = useCallback((modelName: string) => {
    setDraft((prev) => ({ ...prev, model: modelName }));
  }, []);

  const handleModelSelect = useCallback((modelName: string, _display: { label: string }) => {
    setDraft((prev) => ({ ...prev, model: modelName }));
  }, []);

  const selectOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const names = new Set(modelOptions);
    const current = draft.model.trim();
    if (current) {
      names.add(current);
    }
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        id: name,
        value: name,
        label: name,
        testID: `host-page-local-llm-model-option-${name}`,
      }));
  }, [draft.model, modelOptions]);

  const selectedDisplay = useMemo(() => {
    const current = draft.model.trim();
    return current ? { label: current } : null;
  }, [draft.model]);

  if (!supported || !isConnected) return null;

  const hasChanges = localLlmDraftHasChanges(draft, persisted);
  const isBusy =
    saveMutation.isPending ||
    testMutation.isPending ||
    fetchModelsMutation.isPending ||
    useOllamaMutation.isPending;
  const errorText = resolveLocalLlmErrorText({
    model,
    saveError: saveMutation.error,
    testError: testMutation.error,
    fetchError: fetchModelsMutation.error ?? useOllamaMutation.error,
  });

  let badge: React.ReactNode = null;
  if (model?.status === "ready") {
    badge = <StatusBadge label={t("settings.host.localLlm.ready")} variant="success" />;
  } else if (model?.status === "error") {
    badge = <StatusBadge label={t("settings.host.localLlm.error")} variant="error" />;
  }

  return (
    <SettingsSection title={t("settings.host.localLlm.title")} testID="host-page-local-llm-card">
      <View style={settingsStyles.card}>
        <View style={[settingsStyles.row, styles.headerRow]}>
          <View style={settingsStyles.rowContent}>
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

          <LocalLlmModelField
            draft={draft}
            selectOptions={selectOptions}
            selectedDisplay={selectedDisplay}
            hasFetchedModels={hasFetchedModels}
            isBusy={isBusy}
            fetchPending={fetchModelsMutation.isPending}
            useOllamaPending={useOllamaMutation.isPending}
            onModelTextChange={handleModelTextChange}
            onModelSelect={handleModelSelect}
            onUseOllama={handleUseOllama}
            onFetchModels={handleFetchModels}
          />
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

const styles = StyleSheet.create((theme) => ({
  headerRow: {
    alignItems: "flex-start",
  },
  formBody: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
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
