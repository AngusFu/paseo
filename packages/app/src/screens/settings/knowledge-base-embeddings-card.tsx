import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { resolveKnowledgeBaseEmbeddingsRpcs } from "@/knowledge-bases/resolve-knowledge-base-embeddings";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  applyOllamaDetectToDraft,
  createKnowledgeBaseEmbeddingsPatch,
  daemonConfigSupportsEmbeddings,
  knowledgeBaseEmbeddingsDraftHasChanges,
  readKnowledgeBaseEmbeddingsDraft,
} from "@/screens/settings/knowledge-base-embeddings-config";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";

type ProbeStatus = "idle" | "ready" | "error";

function resolveEmbeddingsErrorText(args: {
  saveError: unknown;
  testError: unknown;
  useOllamaError: unknown;
}): string | null {
  if (args.saveError) return String(args.saveError);
  if (args.testError) return String(args.testError);
  if (args.useOllamaError) return String(args.useOllamaError);
  return null;
}

/**
 * Host-scoped Embeddings config for Knowledge bases (vector import / search).
 * Gated on `server_info.features.knowledgeBases`. Requires E1 client methods +
 * mutable `embeddings` on daemon config — otherwise shows upgrade messaging.
 */
export function KnowledgeBaseEmbeddingsCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId);
  const knowledgeBasesSupported = useHostFeature(serverId, "knowledgeBases");
  const client = useHostRuntimeClient(serverId);
  const { config, patchConfig } = useDaemonConfig(serverId);
  const rpcs = useMemo(() => resolveKnowledgeBaseEmbeddingsRpcs(client), [client]);
  // E1 may omit `embeddings` until first save — RPC presence is the capability gate.
  // After save we still verify the field round-trips (no fake local persist).
  const hostSupportsEmbeddings = rpcs !== null;

  const persisted = useMemo(() => readKnowledgeBaseEmbeddingsDraft(config), [config]);
  const [draft, setDraft] = useState(persisted);
  const [probeStatus, setProbeStatus] = useState<ProbeStatus>("idle");

  useEffect(() => {
    setDraft(persisted);
  }, [persisted]);

  useEffect(() => {
    setProbeStatus("idle");
  }, [serverId]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!hostSupportsEmbeddings) {
        throw new Error(t("settings.hostSections.knowledgeBases.embeddings.unsupported"));
      }
      const result = await patchConfig(createKnowledgeBaseEmbeddingsPatch(draft));
      if (!result) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      if (!daemonConfigSupportsEmbeddings(result)) {
        throw new Error(t("settings.hostSections.knowledgeBases.embeddings.unsupported"));
      }
      return result;
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      if (!rpcs) {
        throw new Error(t("settings.hostSections.knowledgeBases.embeddings.unsupported"));
      }
      if (knowledgeBaseEmbeddingsDraftHasChanges(draft, persisted)) {
        await saveMutation.mutateAsync();
      }
      const payload = await rpcs.test({
        enabled: draft.enabled,
        baseUrl: draft.baseUrl.trim() || undefined,
        apiKey: draft.apiKey.trim() || undefined,
        model: draft.model.trim() || undefined,
      });
      if (!payload.ok) {
        throw new Error(
          payload.error ?? t("settings.hostSections.knowledgeBases.embeddings.testFailed"),
        );
      }
      return payload;
    },
    onSuccess: () => {
      setProbeStatus("ready");
    },
    onError: () => {
      setProbeStatus("error");
    },
  });

  const useOllamaMutation = useMutation({
    mutationFn: async () => {
      if (!rpcs) {
        throw new Error(t("settings.hostSections.knowledgeBases.embeddings.unsupported"));
      }
      const payload = await rpcs.detectOllama();
      if (!payload.available) {
        throw new Error(
          payload.error ?? t("settings.hostSections.knowledgeBases.embeddings.ollamaUnavailable"),
        );
      }
      setDraft((prev) => applyOllamaDetectToDraft(prev, payload));
      setProbeStatus("idle");
      return payload;
    },
  });

  const handleSave = useCallback(() => {
    setProbeStatus("idle");
    saveMutation.mutate();
  }, [saveMutation]);

  const handleTest = useCallback(() => {
    testMutation.mutate();
  }, [testMutation]);

  const handleUseOllama = useCallback(() => {
    useOllamaMutation.mutate();
  }, [useOllamaMutation]);

  const handleEnabledChange = useCallback((enabled: boolean) => {
    setProbeStatus("idle");
    setDraft((prev) => ({ ...prev, enabled }));
  }, []);

  const handleBaseUrlChange = useCallback((baseUrl: string) => {
    setProbeStatus("idle");
    setDraft((prev) => ({ ...prev, baseUrl }));
  }, []);

  const handleApiKeyChange = useCallback((apiKey: string) => {
    setProbeStatus("idle");
    setDraft((prev) => ({ ...prev, apiKey }));
  }, []);

  const handleModelChange = useCallback((model: string) => {
    setProbeStatus("idle");
    setDraft((prev) => ({ ...prev, model }));
  }, []);

  if (!knowledgeBasesSupported || !isConnected) return null;

  const hasChanges = knowledgeBaseEmbeddingsDraftHasChanges(draft, persisted);
  const isBusy = saveMutation.isPending || testMutation.isPending || useOllamaMutation.isPending;
  const errorText = resolveEmbeddingsErrorText({
    saveError: saveMutation.error,
    testError: testMutation.error,
    useOllamaError: useOllamaMutation.error,
  });

  let badge: React.ReactNode = null;
  if (probeStatus === "ready") {
    badge = (
      <StatusBadge
        label={t("settings.hostSections.knowledgeBases.embeddings.ready")}
        variant="success"
      />
    );
  } else if (probeStatus === "error") {
    badge = (
      <StatusBadge
        label={t("settings.hostSections.knowledgeBases.embeddings.error")}
        variant="error"
      />
    );
  }

  return (
    <SettingsSection
      title={t("settings.hostSections.knowledgeBases.embeddings.title")}
      trailing={badge}
      testID="host-kb-embeddings"
    >
      <View style={settingsStyles.card}>
        {!hostSupportsEmbeddings ? (
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowHint} testID="host-kb-embeddings-unsupported">
                {t("settings.hostSections.knowledgeBases.embeddings.unsupported")}
              </Text>
            </View>
          </View>
        ) : (
          <>
            <View style={[settingsStyles.row, styles.headerRow]}>
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>
                  {t("settings.hostSections.knowledgeBases.embeddings.enabled")}
                </Text>
                <Text style={settingsStyles.rowHint}>
                  {t("settings.hostSections.knowledgeBases.embeddings.hint")}
                </Text>
                {errorText ? (
                  <Text style={settingsStyles.rowError} testID="host-kb-embeddings-error">
                    {errorText}
                  </Text>
                ) : null}
              </View>
              <Switch
                value={draft.enabled}
                onValueChange={handleEnabledChange}
                disabled={isBusy}
                accessibilityLabel={t("settings.hostSections.knowledgeBases.embeddings.enabled")}
                testID="host-kb-embeddings-enabled"
              />
            </View>

            <View style={styles.formBody}>
              <Field
                label={t("settings.hostSections.knowledgeBases.embeddings.baseUrl")}
                testID="host-kb-embeddings-base-url"
              >
                <FormTextInput
                  size="sm"
                  value={draft.baseUrl}
                  onChangeText={handleBaseUrlChange}
                  placeholder={t(
                    "settings.hostSections.knowledgeBases.embeddings.baseUrlPlaceholder",
                  )}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isBusy}
                  testID="host-kb-embeddings-base-url-input"
                />
              </Field>

              <Field
                label={t("settings.hostSections.knowledgeBases.embeddings.apiKey")}
                testID="host-kb-embeddings-api-key"
              >
                <FormTextInput
                  size="sm"
                  value={draft.apiKey}
                  onChangeText={handleApiKeyChange}
                  placeholder={t(
                    "settings.hostSections.knowledgeBases.embeddings.apiKeyPlaceholder",
                  )}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  editable={!isBusy}
                  testID="host-kb-embeddings-api-key-input"
                />
              </Field>

              <Field
                label={t("settings.hostSections.knowledgeBases.embeddings.model")}
                testID="host-kb-embeddings-model"
              >
                <FormTextInput
                  size="sm"
                  value={draft.model}
                  onChangeText={handleModelChange}
                  placeholder={t(
                    "settings.hostSections.knowledgeBases.embeddings.modelPlaceholder",
                  )}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!isBusy}
                  testID="host-kb-embeddings-model-input"
                />
                <View style={styles.fetchRow}>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={isBusy}
                    loading={useOllamaMutation.isPending}
                    onPress={handleUseOllama}
                    testID="host-kb-embeddings-use-ollama"
                  >
                    {t("settings.hostSections.knowledgeBases.embeddings.useOllama")}
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
                testID="host-kb-embeddings-save"
              >
                {t("settings.hostSections.knowledgeBases.embeddings.save")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={isBusy || !draft.baseUrl.trim() || !draft.model.trim()}
                loading={testMutation.isPending}
                onPress={handleTest}
                testID="host-kb-embeddings-test"
              >
                {t("settings.hostSections.knowledgeBases.embeddings.test")}
              </Button>
            </View>
          </>
        )}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  headerRow: {
    alignItems: "flex-start",
  },
  formBody: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
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
