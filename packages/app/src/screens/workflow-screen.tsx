// oxlint-disable react-perf/jsx-no-new-function-as-prop
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { Pencil, Play, Plus, Sparkles, Trash2, Folder } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { WorkflowDefinition, WorkflowRun } from "@getpaseo/protocol/workflow/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SelectFieldTrigger } from "@/components/ui/select-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useToast } from "@/contexts/toast-context";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useProjects } from "@/hooks/use-projects";
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
import { WorkflowDirectoryPickerSheet } from "@/screens/workflow-directory-picker-sheet";
import { summarizeWorkflowRun } from "@/screens/workflow-run-summary";
import { buildScheduleProjectTargets } from "@/schedules/schedule-project-targets";
import type { DispatchWorkflowRunInput } from "@getpaseo/protocol/workflow/types";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { formatTimeAgo } from "@/utils/time";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";
import { shortenPath } from "@/utils/shorten-path";

type WorkflowTab = "definitions" | "builtins" | "runs";

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
  const [dispatching, setDispatching] = useState<WorkflowDefinition | null>(null);
  const [inspecting, setInspecting] = useState<WorkflowRun | null>(null);
  const [tab, setTab] = useState<WorkflowTab>("definitions");

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
        tab={tab}
        onTabChange={setTab}
        definitions={definitions.definitions}
        builtins={builtins.definitions}
        runs={runs.runs}
        isCreating={mutations.isCreating}
        isDispatching={mutations.isDispatching}
        isRemoving={mutations.isRemoving}
        onCreate={() => setCreateOpen(true)}
        onDispatch={setDispatching}
        onCopyBuiltin={copyBuiltin}
        onEdit={setEditing}
        onDelete={removeDefinition}
        onInspectRun={setInspecting}
      />
      <WorkflowAuthoringSheet
        visible={createOpen}
        serverId={serverId}
        onClose={() => setCreateOpen(false)}
      />
      {dispatching ? (
        <WorkflowDispatchSheet
          key={dispatching.id}
          definition={dispatching}
          serverId={serverId}
          isDispatching={mutations.isDispatching}
          onClose={() => setDispatching(null)}
          onDispatch={(input) =>
            mutations
              .dispatch(input)
              .then(() => {
                setDispatching(null);
                setTab("runs");
                return undefined;
              })
              .catch((error: unknown) => {
                toast.error(toErrorMessage(error));
              })
          }
        />
      ) : null}
      <WorkflowRunDetailSheet run={inspecting} onClose={() => setInspecting(null)} />
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
  tab,
  onTabChange,
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
  onInspectRun,
}: {
  tab: WorkflowTab;
  onTabChange: (tab: WorkflowTab) => void;
  definitions: WorkflowDefinition[];
  builtins: WorkflowDefinition[];
  runs: WorkflowRun[];
  isCreating: boolean;
  isDispatching: boolean;
  isRemoving: boolean;
  onCreate: () => void;
  onDispatch: (definition: WorkflowDefinition) => void;
  onCopyBuiltin: (definition: WorkflowDefinition) => void;
  onEdit: (definition: WorkflowDefinition) => void;
  onDelete: (definition: WorkflowDefinition) => void;
  onInspectRun: (run: WorkflowRun) => void;
}): ReactElement {
  const { t } = useTranslation();
  const tabOptions = useMemo<SegmentedControlOption<WorkflowTab>[]>(
    () => [
      { value: "definitions", label: t("workflows.tabs.definitions") },
      { value: "builtins", label: t("workflows.tabs.builtins") },
      { value: "runs", label: t("workflows.tabs.runs") },
    ],
    [t],
  );
  const definitionNameById = useMemo(() => {
    const names = new Map<string, string>();
    for (const definition of definitions) {
      names.set(definition.id, definition.name);
    }
    for (const definition of builtins) {
      names.set(definition.id, definition.name);
    }
    return names;
  }, [builtins, definitions]);

  let content: ReactElement;
  if (tab === "definitions") {
    content =
      definitions.length === 0 ? (
        <Text style={styles.empty}>{t("workflows.emptyDefinitions")}</Text>
      ) : (
        <View style={styles.cardGrid}>
          {definitions.map((definition) => (
            <View key={definition.id} style={styles.card}>
              <View style={styles.cardBody}>
                <View style={styles.titleRow}>
                  <Text style={styles.cardTitle} numberOfLines={2}>
                    {definition.name}
                  </Text>
                  {definition.builtin ? (
                    <Text style={styles.badge}>{t("workflows.builtin")}</Text>
                  ) : null}
                </View>
                {definition.description ? (
                  <Text style={styles.meta} numberOfLines={3}>
                    {definition.description}
                  </Text>
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
                  onPress={() => onDispatch(definition)}
                >
                  {t("workflows.actions.dispatch")}
                </Button>
              </View>
            </View>
          ))}
        </View>
      );
  } else if (tab === "builtins") {
    content =
      builtins.length === 0 ? (
        <Text style={styles.empty}>{t("workflows.emptyBuiltins")}</Text>
      ) : (
        <View style={styles.cardGrid}>
          {builtins.map((definition) => (
            <View key={definition.id} style={styles.card}>
              <View style={styles.cardBody}>
                <Text style={styles.cardTitle} numberOfLines={2}>
                  {definition.name}
                </Text>
                {definition.description ? (
                  <Text style={styles.meta} numberOfLines={3}>
                    {definition.description}
                  </Text>
                ) : null}
              </View>
              <View style={styles.cardActions}>
                <Button
                  variant="outline"
                  size="sm"
                  loading={isCreating}
                  onPress={() => onCopyBuiltin(definition)}
                >
                  {t("workflows.actions.copyBuiltin")}
                </Button>
              </View>
            </View>
          ))}
        </View>
      );
  } else {
    content =
      runs.length === 0 ? (
        <Text style={styles.empty}>{t("workflows.emptyRuns")}</Text>
      ) : (
        <View style={styles.cardGrid}>
          {runs.map((run) => {
            const summary = summarizeWorkflowRun(run);
            const name = definitionNameById.get(run.definitionId) ?? run.definitionId;
            return (
              <Pressable
                key={run.id}
                style={styles.card}
                onPress={() => onInspectRun(run)}
                testID={`workflow-run-${run.id}`}
              >
                <View style={styles.cardBody}>
                  <View style={styles.titleRow}>
                    <Text
                      style={
                        summary.displayStatus === "failed"
                          ? styles.runStatusFailed
                          : styles.runStatus
                      }
                    >
                      {t(`workflows.status.${summary.displayStatus}`)}
                    </Text>
                    <Text style={styles.meta}>{formatTimeAgo(new Date(run.queuedAt))}</Text>
                  </View>
                  <Text style={styles.cardTitle} numberOfLines={2}>
                    {name}
                  </Text>
                  {summary.task ? (
                    <Text style={styles.meta} numberOfLines={2}>
                      {t("workflows.runTask", { task: summary.task })}
                    </Text>
                  ) : (
                    <Text style={styles.meta}>{t("workflows.runNoTask")}</Text>
                  )}
                  {summary.outcome ? (
                    <Text style={styles.errorText} numberOfLines={3}>
                      {summary.outcome}
                    </Text>
                  ) : null}
                  {summary.agentCalls !== null ? (
                    <Text style={styles.meta}>
                      {t("workflows.runAgentCalls", { count: summary.agentCalls })}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      );
  }

  return (
    <View style={styles.body}>
      <View style={styles.toolbar}>
        <SegmentedControl
          size="sm"
          value={tab}
          onValueChange={onTabChange}
          options={tabOptions}
          testID="workflow-tabs"
        />
        {tab === "definitions" ? (
          <Button leftIcon={Plus} onPress={onCreate} size="sm">
            {t("workflows.actions.create")}
          </Button>
        ) : null}
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        testID="workflow-list"
      >
        {content}
      </ScrollView>
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
  const [prompt, setPrompt] = useState(() => t("workflows.authoring.defaultPrompt"));
  const [isStarting, setIsStarting] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const snapshot = useProvidersSnapshot(serverId, {
    enabled: Boolean(visible && serverId),
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
    if (!visible) {
      setIsStarting(false);
      return;
    }
    setPrompt(t("workflows.authoring.defaultPrompt"));
    setSelectedProvider("");
    setSelectedModel("");
  }, [t, visible]);

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
    if (!selectedProvider) {
      throw new Error(t("workflows.authoring.selectProvider"));
    }
    setIsStarting(true);
    try {
      const preparedPayload = await client.workflowAuthoringPrepare();
      if (preparedPayload.error || !preparedPayload.value) {
        throw new Error(preparedPayload.error ?? t("workflows.authoring.prepareFailed"));
      }
      const cwd = (preparedPayload.value as { cwd: string }).cwd;
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
  }, [client, onClose, prompt, selectedModel, selectedProvider, serverId, t]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="workflow-create-sheet"
    >
      <Text style={styles.sheetHeading}>{t("workflows.authoring.hint")}</Text>
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
        disabled={!selectedProvider || isStarting}
        loading={isStarting}
        onPress={() => void startAuthoring().catch((error) => toast.error(toErrorMessage(error)))}
      >
        {t("workflows.actions.startAuthoring")}
      </Button>
    </AdaptiveModalSheet>
  );
}

const WORKFLOW_DISPATCH_SNAP_POINTS = ["70%", "92%"];

function WorkflowDispatchSheet({
  definition,
  serverId,
  isDispatching,
  onClose,
  onDispatch,
}: {
  definition: WorkflowDefinition;
  serverId: string | null;
  isDispatching: boolean;
  onClose: () => void;
  onDispatch: (input: DispatchWorkflowRunInput) => Promise<void> | void;
}): ReactElement {
  const { t } = useTranslation();
  const { preferences } = useFormPreferences();
  const { projects } = useProjects();
  const [task, setTask] = useState("");
  const [cwd, setCwd] = useState<string | null>(null);
  const [cwdLabel, setCwdLabel] = useState<string | null>(null);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [selectedModel, setSelectedModel] = useState("");

  const snapshot = useProvidersSnapshot(serverId, {
    enabled: Boolean(serverId),
  });
  const providerDefault = useMemo(
    () => resolveAuthoringProviderDefault(preferences.provider, snapshot.entries),
    [preferences.provider, snapshot.entries],
  );
  const modelSelectorProviders = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );

  const projectTargets = useMemo(() => {
    const all = buildScheduleProjectTargets(projects);
    if (!serverId) {
      return all;
    }
    return all.filter((target) => target.serverId === serverId);
  }, [projects, serverId]);

  const directoryShortcuts = useMemo(
    () =>
      projectTargets
        .filter((target) => !isPaseoInternalPath(target.cwd))
        .map((target) => ({
          id: target.optionId,
          label: target.projectName,
          path: target.cwd,
        })),
    [projectTargets],
  );

  useEffect(() => {
    if (!selectedProvider && providerDefault) {
      setSelectedProvider(providerDefault.provider);
      setSelectedModel(providerDefault.model);
    }
  }, [providerDefault, selectedProvider]);

  useEffect(() => {
    if (cwd || projectTargets.length === 0) {
      return;
    }
    const preferred =
      projectTargets.find((target) => !isPaseoInternalPath(target.cwd)) ?? projectTargets[0];
    if (!preferred) {
      return;
    }
    setCwd(preferred.cwd);
    setCwdLabel(isPaseoInternalPath(preferred.cwd) ? null : preferred.projectName);
  }, [cwd, projectTargets]);

  const cwdTriggerLabel = cwdLabel ?? (cwd ? shortenPath(cwd) : t("workflows.projectPlaceholder"));
  const cwdHint = cwd && cwdLabel && shortenPath(cwd) !== cwdLabel ? shortenPath(cwd) : undefined;
  const canSubmit = Boolean(task.trim() && cwd?.trim() && selectedProvider && !isDispatching);

  const header = useMemo(
    () => ({
      title: t("workflows.dispatchTitleNamed", { name: definition.name }),
    }),
    [definition.name, t],
  );

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

  const cwdLeading = useMemo(() => <Folder size={16} color={styles.cwdIcon.color} />, []);

  const renderCwdTrigger = useCallback(
    ({
      hovered = false,
      pressed = false,
    }: PressableStateCallbackType & { hovered?: boolean }): ReactElement => (
      <SelectFieldTrigger
        label={cwdTriggerLabel}
        isPlaceholder={!cwd}
        placeholder={t("workflows.projectPlaceholder")}
        leading={cwdLeading}
        active={hovered || pressed || pickingDirectory}
        size="sm"
        testID="workflow-dispatch-cwd-trigger"
      />
    ),
    [cwd, cwdLeading, cwdTriggerLabel, pickingDirectory, t],
  );

  const footer = useMemo(
    () => (
      <View style={styles.dispatchFooter}>
        <Button
          variant="default"
          leftIcon={Play}
          disabled={!canSubmit}
          loading={isDispatching}
          testID="workflow-dispatch-confirm"
          onPress={() => {
            if (!cwd?.trim()) {
              return;
            }
            const args: Record<string, unknown> = {
              task: task.trim(),
              provider: selectedProvider,
            };
            if (selectedModel.trim()) {
              args.model = selectedModel.trim();
            }
            void onDispatch({
              definitionId: definition.id,
              cwd: cwd.trim(),
              args,
            });
          }}
        >
          {t("workflows.actions.confirmDispatch")}
        </Button>
      </View>
    ),
    [
      canSubmit,
      cwd,
      definition.id,
      isDispatching,
      onDispatch,
      selectedModel,
      selectedProvider,
      t,
      task,
    ],
  );

  return (
    <>
      <AdaptiveModalSheet
        header={header}
        visible
        onClose={onClose}
        footer={footer}
        snapPoints={WORKFLOW_DISPATCH_SNAP_POINTS}
        testID="workflow-dispatch-sheet"
      >
        <View style={styles.dispatchBody}>
          <Field label={t("workflows.project")} hint={cwdHint} testID="workflow-dispatch-project">
            <Pressable onPress={() => setPickingDirectory(true)} testID="workflow-dispatch-cwd">
              {renderCwdTrigger}
            </Pressable>
          </Field>
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
          <Field label={t("workflows.task")} hint={t("workflows.taskHint")} hintWrap>
            <FormTextInput
              value={task}
              initialValue={task}
              onChangeText={setTask}
              placeholder={t("workflows.taskPlaceholder")}
              multiline
              numberOfLines={5}
              textAlignVertical="top"
              style={styles.taskInput}
              testID="workflow-dispatch-task-input"
            />
          </Field>
        </View>
      </AdaptiveModalSheet>
      <WorkflowDirectoryPickerSheet
        visible={pickingDirectory}
        serverId={serverId}
        initialPath={cwd}
        shortcuts={directoryShortcuts}
        onClose={() => setPickingDirectory(false)}
        onSelect={(path) => {
          const match = projectTargets.find((target) => target.cwd === path);
          setCwd(path);
          setCwdLabel(match && !isPaseoInternalPath(path) ? match.projectName : null);
          setPickingDirectory(false);
        }}
      />
    </>
  );
}

function isPaseoInternalPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.includes("/.paseo/workflows") || normalized.includes("/.paseo/worktrees");
}

function WorkflowRunDetailSheet({
  run,
  onClose,
}: {
  run: WorkflowRun | null;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const summary = run ? summarizeWorkflowRun(run) : null;
  const header = useMemo<SheetHeader>(() => ({ title: t("workflows.runDetailTitle") }), [t]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={run !== null}
      onClose={onClose}
      testID="workflow-run-detail-sheet"
    >
      {run ? (
        <View style={styles.detailStack}>
          <Text
            style={summary?.displayStatus === "failed" ? styles.runStatusFailed : styles.cardTitle}
          >
            {t(`workflows.status.${summary?.displayStatus ?? run.status}`)}
          </Text>
          <Text style={styles.meta}>
            {t("workflows.runQueuedAt", { time: formatTimeAgo(new Date(run.queuedAt)) })}
          </Text>
          {summary?.task ? (
            <Field label={t("workflows.task")}>
              <Text style={styles.detailBody}>{summary.task}</Text>
            </Field>
          ) : (
            <Text style={styles.meta}>{t("workflows.runNoTask")}</Text>
          )}
          {summary?.outcome ? (
            <Field label={t("workflows.runOutcome")}>
              <Text style={styles.errorText}>{summary.outcome}</Text>
            </Field>
          ) : null}
          {summary?.agentCalls !== null && summary ? (
            <Text style={styles.meta}>
              {t("workflows.runAgentCalls", { count: summary.agentCalls })}
            </Text>
          ) : null}
          <Field label={t("workflows.runArgs")}>
            <Text style={styles.detailMono}>{JSON.stringify(run.args ?? {}, null, 2)}</Text>
          </Field>
          <Field label={t("workflows.runResult")}>
            <Text style={styles.detailMono}>{JSON.stringify(run.result ?? null, null, 2)}</Text>
          </Field>
        </View>
      ) : null}
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
          multiline
          numberOfLines={4}
          textAlignVertical="top"
          style={styles.descriptionInput}
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
  body: { flex: 1, minHeight: 0 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  spinner: { color: theme.colors.foreground },
  message: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    flexWrap: "wrap",
  },
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: {
    flexGrow: 1,
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  empty: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  cardGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  card: {
    width: {
      xs: "100%",
      md: "48%",
      lg: "31%",
    },
    flexGrow: 1,
    minWidth: {
      xs: "100%",
      md: 240,
    },
    maxWidth: {
      xs: "100%",
      md: "48%",
      lg: "32%",
    },
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
  },
  cardBody: { gap: theme.spacing[2], flexGrow: 1 },
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexWrap: "wrap",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  badge: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  errorText: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
  runStatus: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  runStatusFailed: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  detailStack: { gap: theme.spacing[3] },
  detailBody: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  detailMono: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  sheetHeading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[2],
  },
  dispatchBody: {
    gap: theme.spacing[4],
  },
  dispatchFooter: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  cwdIcon: {
    color: theme.colors.foregroundMuted,
  },
  taskInput: {
    minHeight: 120,
  },
  descriptionInput: {
    minHeight: 88,
  },
  sourceInput: {
    minHeight: 220,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
}));
