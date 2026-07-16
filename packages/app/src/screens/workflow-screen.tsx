// oxlint-disable react-perf/jsx-no-new-function-as-prop
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { Pencil, Play, Plus, Sparkles, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { WorkflowDefinition } from "@getpaseo/protocol/workflow/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SelectFieldTrigger } from "@/components/ui/select-field";
import { useToast } from "@/contexts/toast-context";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  useBuiltinWorkflowDefinitions,
  useWorkflowDefinitions,
} from "@/hooks/use-workflow-definitions";
import { useWorkflowMutations } from "@/hooks/use-workflow-mutations";
import { useWorkflowRuns } from "@/hooks/use-workflow-runs";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { resolveDefaultModelId } from "@/provider-selection/resolve-agent-form";
import { useHostFeature } from "@/runtime/host-features";
import {
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";

export function WorkflowScreen(): ReactElement {
  const isFocused = useIsFocused();
  return isFocused ? <WorkflowScreenContent /> : <View style={styles.container} />;
}

function WorkflowScreenContent(): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? null;
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const status = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const supported = useHostFeature(serverId, "workflow");
  const active = Boolean(serverId && status === "online" && supported);
  const definitions = useWorkflowDefinitions(active ? serverId : null);
  const builtins = useBuiltinWorkflowDefinitions(active ? serverId : null);
  const runs = useWorkflowRuns(active ? serverId : null);
  const mutations = useWorkflowMutations({ serverId: serverId ?? "" });
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowDefinition | null>(null);

  const dispatch = useCallback(
    (definitionId: string) => void mutations.dispatch({ definitionId }).catch(() => undefined),
    [mutations],
  );
  const copyBuiltin = useCallback(
    (definition: WorkflowDefinition) =>
      void mutations
        .create({
          name: definition.name,
          description: definition.description,
          source: definition.source,
        })
        .catch(() => undefined),
    [mutations],
  );
  const removeDefinition = useCallback(
    (definition: WorkflowDefinition) => {
      void confirmDialog({
        title: t("workflows.deleteTitle"),
        message: t("workflows.deleteMessage", { name: definition.name }),
        confirmLabel: t("workflows.actions.delete"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      })
        .then((confirmed) => {
          if (!confirmed) return undefined;
          return mutations.remove(definition.id);
        })
        .catch((error: unknown) => {
          toast.error(toErrorMessage(error));
        });
    },
    [mutations, t, toast],
  );

  const showUnsupported = Boolean(serverId && status === "online" && !supported);
  const showLoading = status === "connecting" || status === "idle" || definitions.isLoading;

  if (showUnsupported || showLoading) {
    return (
      <View style={styles.container}>
        <MenuHeader title={t("workflows.title")} />
        <View style={styles.centered}>
          {showUnsupported ? (
            <Text style={styles.message}>{t("workflows.unsupported")}</Text>
          ) : (
            <LoadingSpinner size="large" color={styles.spinner.color} />
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <MenuHeader title={t("workflows.title")} />
      <WorkflowLists
        definitions={definitions.definitions}
        builtins={builtins.definitions}
        runs={runs.runs}
        isCreating={mutations.isCreating}
        isDispatching={mutations.isDispatching}
        isRemoving={mutations.isRemoving}
        onCreate={() => setCreateOpen(true)}
        onDispatch={dispatch}
        onCopyBuiltin={copyBuiltin}
        onEdit={setEditing}
        onDelete={removeDefinition}
      />
      <WorkflowAuthoringSheet
        visible={createOpen}
        serverId={serverId}
        onClose={() => setCreateOpen(false)}
      />
      <WorkflowEditSheet
        definition={editing}
        isSaving={mutations.isUpdating}
        onClose={() => setEditing(null)}
        onSave={(input) =>
          mutations
            .update(input)
            .then(() => setEditing(null))
            .catch((error: unknown) => {
              toast.error(toErrorMessage(error));
            })
        }
      />
    </View>
  );
}

function WorkflowLists({
  definitions,
  builtins,
  runs,
  isCreating,
  isDispatching,
  isRemoving,
  onCreate,
  onDispatch,
  onCopyBuiltin,
  onEdit,
  onDelete,
}: {
  definitions: WorkflowDefinition[];
  builtins: WorkflowDefinition[];
  runs: ReturnType<typeof useWorkflowRuns>["runs"];
  isCreating: boolean;
  isDispatching: boolean;
  isRemoving: boolean;
  onCreate: () => void;
  onDispatch: (definitionId: string) => void;
  onCopyBuiltin: (definition: WorkflowDefinition) => void;
  onEdit: (definition: WorkflowDefinition) => void;
  onDelete: (definition: WorkflowDefinition) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.body}>
      <View style={styles.actions}>
        <Button leftIcon={Plus} onPress={onCreate} size="sm">
          {t("workflows.actions.create")}
        </Button>
      </View>
      <Text style={styles.sectionTitle}>{t("workflows.definitions")}</Text>
      {definitions.length === 0 ? (
        <Text style={styles.empty}>{t("workflows.emptyDefinitions")}</Text>
      ) : (
        definitions.map((definition) => (
          <View key={definition.id} style={styles.card}>
            <View style={styles.cardText}>
              <View style={styles.titleRow}>
                <Text style={styles.cardTitle}>{definition.name}</Text>
                {definition.builtin ? (
                  <Text style={styles.badge}>{t("workflows.builtin")}</Text>
                ) : null}
              </View>
              {definition.description ? (
                <Text style={styles.meta}>{definition.description}</Text>
              ) : null}
            </View>
            <View style={styles.cardActions}>
              {!definition.builtin ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={Pencil}
                    onPress={() => onEdit(definition)}
                  >
                    {t("workflows.actions.edit")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    leftIcon={Trash2}
                    loading={isRemoving}
                    onPress={() => onDelete(definition)}
                  >
                    {t("workflows.actions.delete")}
                  </Button>
                </>
              ) : null}
              <Button
                variant="outline"
                leftIcon={Play}
                size="sm"
                loading={isDispatching}
                onPress={() => onDispatch(definition.id)}
              >
                {t("workflows.actions.dispatch")}
              </Button>
            </View>
          </View>
        ))
      )}
      <Text style={styles.sectionTitle}>{t("workflows.builtins")}</Text>
      {builtins.length === 0 ? (
        <Text style={styles.empty}>{t("workflows.emptyBuiltins")}</Text>
      ) : (
        builtins.map((definition) => (
          <View key={definition.id} style={styles.card}>
            <View style={styles.cardText}>
              <Text style={styles.cardTitle}>{definition.name}</Text>
              {definition.description ? (
                <Text style={styles.meta}>{definition.description}</Text>
              ) : null}
            </View>
            <Button
              variant="outline"
              size="sm"
              loading={isCreating}
              onPress={() => onCopyBuiltin(definition)}
            >
              {t("workflows.actions.copyBuiltin")}
            </Button>
          </View>
        ))
      )}
      <Text style={styles.sectionTitle}>{t("workflows.recentRuns")}</Text>
      {runs.length === 0 ? (
        <Text style={styles.empty}>{t("workflows.emptyRuns")}</Text>
      ) : (
        runs.slice(0, 10).map((run) => (
          <View key={run.id} style={styles.run}>
            <Text style={styles.runStatus}>{t(`workflows.status.${run.status}`)}</Text>
            <Text style={styles.meta} numberOfLines={1}>
              {run.workspacePath}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

function resolveAuthoringProviderDefault(
  preferredProvider: string | undefined,
  entries: readonly ProviderSnapshotEntry[] | undefined,
): { provider: string; model: string } | null {
  if (!entries || entries.length === 0) {
    return null;
  }
  const ready = entries.filter((entry) => entry.status === "ready");
  const preferred = preferredProvider
    ? ready.find((entry) => entry.provider === preferredProvider)
    : undefined;
  const entry = preferred ?? ready[0];
  if (!entry) {
    return null;
  }
  return {
    provider: entry.provider,
    model: resolveDefaultModelId(entry.models ?? null) ?? "",
  };
}

function WorkflowAuthoringSheet({
  visible,
  serverId,
  onClose,
}: {
  visible: boolean;
  serverId: string | null;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId ?? "");
  const { preferences } = useFormPreferences();
  const [cwd, setCwd] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(() => t("workflows.authoring.defaultPrompt"));
  const [isStarting, setIsStarting] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const snapshot = useProvidersSnapshot(serverId, {
    enabled: Boolean(visible && serverId),
    cwd: cwd ?? undefined,
  });
  const providerDefault = useMemo(
    () => resolveAuthoringProviderDefault(preferences.provider, snapshot.entries),
    [preferences.provider, snapshot.entries],
  );
  const modelSelectorProviders = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );
  const header = useMemo<SheetHeader>(() => ({ title: t("workflows.createTitle") }), [t]);

  useEffect(() => {
    if (!visible || !client) {
      return;
    }
    let cancelled = false;
    void client
      .workflowAuthoringPrepare()
      .then((payload) => {
        if (cancelled) {
          return undefined;
        }
        if (payload.error || !payload.value) {
          throw new Error(payload.error ?? t("workflows.authoring.prepareFailed"));
        }
        const prepared = payload.value as { cwd: string };
        setCwd(prepared.cwd);
        return undefined;
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          toast.error(toErrorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, t, toast, visible]);

  useEffect(() => {
    if (!selectedProvider && providerDefault) {
      setSelectedProvider(providerDefault.provider);
      setSelectedModel(providerDefault.model);
    }
  }, [providerDefault, selectedProvider]);

  const renderModelTrigger = useCallback(
    (input: {
      selectedModelLabel: string;
      disabled: boolean;
      hovered: boolean;
      pressed: boolean;
      isOpen: boolean;
    }): ReactElement => (
      <SelectFieldTrigger
        label={input.selectedModelLabel}
        isPlaceholder={!selectedModel}
        placeholder={input.selectedModelLabel}
        disabled={input.disabled}
        active={input.hovered || input.pressed || input.isOpen}
        size="sm"
      />
    ),
    [selectedModel],
  );

  const startAuthoring = useCallback(async () => {
    if (!client || !serverId) {
      throw new Error(t("common.errors.daemonClientUnavailable"));
    }
    if (!cwd) {
      throw new Error(t("workflows.authoring.prepareFailed"));
    }
    if (!selectedProvider) {
      throw new Error(t("workflows.authoring.selectProvider"));
    }
    setIsStarting(true);
    try {
      const workspacePayload = await client.createWorkspace({
        source: { kind: "directory", path: cwd },
      });
      if (workspacePayload.error || !workspacePayload.workspace) {
        throw new Error(workspacePayload.error ?? t("workflows.authoring.workspaceFailed"));
      }
      const workspace = normalizeWorkspaceDescriptor(workspacePayload.workspace);
      useSessionStore.getState().mergeWorkspaces(serverId, [workspace]);
      const workspaceDirectory = requireWorkspaceDirectory({
        workspaceId: workspace.id,
        workspaceDirectory: workspace.workspaceDirectory,
      });
      const created = await client.createAgent({
        provider: selectedProvider,
        model: selectedModel || undefined,
        cwd: workspaceDirectory,
        workspaceId: workspace.id,
        ...(prompt.trim() ? { initialPrompt: prompt.trim() } : {}),
      });
      onClose();
      navigateToAgent({ serverId, agentId: created.id, pin: true });
    } finally {
      setIsStarting(false);
    }
  }, [client, cwd, onClose, prompt, selectedModel, selectedProvider, serverId, t]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="workflow-create-sheet"
    >
      <Text style={styles.sheetHeading}>{t("workflows.authoring.hint")}</Text>
      {cwd ? (
        <Text style={styles.meta} numberOfLines={2}>
          {cwd}
        </Text>
      ) : (
        <LoadingSpinner size="small" color={styles.spinner.color} />
      )}
      <Field label={t("workflows.authoring.provider")}>
        <CombinedModelSelector
          providers={modelSelectorProviders}
          selectedProvider={selectedProvider}
          selectedModel={selectedModel}
          onSelect={(provider, modelId) => {
            setSelectedProvider(provider);
            setSelectedModel(modelId);
          }}
          isLoading={snapshot.isLoading || snapshot.isFetching}
          serverId={serverId}
          renderTrigger={renderModelTrigger}
          triggerFill
        />
      </Field>
      <Field label={t("workflows.authoring.prompt")} hint={t("workflows.authoring.promptHint")}>
        <FormTextInput
          value={prompt}
          initialValue={prompt}
          onChangeText={setPrompt}
          multiline
          numberOfLines={5}
          textAlignVertical="top"
        />
      </Field>
      <Button
        leftIcon={Sparkles}
        disabled={!cwd || !selectedProvider || isStarting}
        loading={isStarting}
        onPress={() => void startAuthoring().catch((error) => toast.error(toErrorMessage(error)))}
      >
        {t("workflows.actions.startAuthoring")}
      </Button>
    </AdaptiveModalSheet>
  );
}

function WorkflowEditSheet({
  definition,
  isSaving,
  onClose,
  onSave,
}: {
  definition: WorkflowDefinition | null;
  isSaving: boolean;
  onClose: () => void;
  onSave: (input: {
    id: string;
    name: string;
    description: string | null;
    source: string;
  }) => Promise<void> | void;
}): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState("");
  const header = useMemo<SheetHeader>(() => ({ title: t("workflows.editTitle") }), [t]);

  useEffect(() => {
    if (!definition) return;
    setName(definition.name);
    setDescription(definition.description ?? "");
    setSource(definition.source);
  }, [definition]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={definition !== null}
      onClose={onClose}
      testID="workflow-edit-sheet"
    >
      <Field label={t("workflows.name")}>
        <FormTextInput
          value={name}
          initialValue={name}
          onChangeText={setName}
          placeholder={t("workflows.namePlaceholder")}
        />
      </Field>
      <Field label={t("workflows.description")}>
        <FormTextInput
          value={description}
          initialValue={description}
          onChangeText={setDescription}
          placeholder={t("workflows.descriptionPlaceholder")}
        />
      </Field>
      <Field label={t("workflows.source")} hint={t("workflows.sourceHint")}>
        <FormTextInput
          value={source}
          initialValue={source}
          onChangeText={setSource}
          multiline
          numberOfLines={12}
          textAlignVertical="top"
          style={styles.sourceInput}
        />
      </Field>
      <Button
        disabled={!name.trim() || !source.trim() || isSaving}
        loading={isSaving}
        onPress={() => {
          if (!definition) return;
          void onSave({
            id: definition.id,
            name: name.trim(),
            description: description.trim() ? description.trim() : null,
            source,
          });
        }}
      >
        {t("workflows.actions.save")}
      </Button>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.background },
  body: { flex: 1, padding: theme.spacing[4], gap: theme.spacing[3] },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  spinner: { color: theme.colors.foreground },
  message: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", gap: theme.spacing[2] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    marginTop: theme.spacing[2],
  },
  empty: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.base,
  },
  cardText: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  cardTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  badge: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  run: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  runStatus: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, minWidth: 72 },
  sheetHeading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[2],
  },
  sourceInput: {
    minHeight: 220,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
}));
