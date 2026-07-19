// oxlint-disable react-perf/jsx-no-new-function-as-prop
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { GitFork, Pencil, Play, Plus, Sparkles, Trash2, Folder, Info } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { WorkflowDefinition, WorkflowRun } from "@getpaseo/protocol/workflow/types";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { AgentModelField, collectAgentFeatureValues } from "@/components/agent-launch-fields";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { resolveControlInteractionStyles } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SelectFieldTrigger } from "@/components/ui/select-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DraftAgentControls } from "@/composer/agent-controls";
import { DraftAgentModeControl } from "@/composer/agent-controls/mode-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import type { AgentProvider, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { useDraftAgentFeatures } from "@/hooks/use-draft-agent-features";
import { useFormPreferences, type FormPreferences } from "@/hooks/use-form-preferences";
import { mergeCreateAgentSelectionPreferences } from "@/create-agent-preferences/preferences";
import { useProjects } from "@/hooks/use-projects";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  useBuiltinWorkflowDefinitions,
  useProjectWorkflowDefinitions,
  useWorkflowDefinitions,
  type ProjectWorkflowDefinition,
} from "@/hooks/use-workflow-definitions";
import { useWorkflowMutations } from "@/hooks/use-workflow-mutations";
import { useWorkflowRun } from "@/hooks/use-workflow-run";
import { useWorkflowRunLogs } from "@/hooks/use-workflow-run-logs";
import { useWorkflowRuns } from "@/hooks/use-workflow-runs";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import {
  resolveDefaultModelId,
  resolvePreferredAgentModeId,
} from "@/provider-selection/resolve-agent-form";
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
import {
  WORKFLOW_WORKSPACE_EMOJI_PREFIX,
  formatWorkflowWorkspaceTitle,
  stripWorkflowWorkspaceEmojiPrefix,
} from "@getpaseo/protocol/workflow/workspace-title";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";
import { WorkflowRunDetailBody } from "@/screens/workflow-run-detail";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { formatTimeAgo } from "@/utils/time";
import { buildProviderDefinitions } from "@/utils/provider-definitions";
import { requireWorkspaceDirectory } from "@/utils/workspace-directory";
import { shortenPath } from "@/utils/shorten-path";

type WorkflowTab = "definitions" | "builtins" | "runs";

export function WorkflowScreen(): ReactElement {
  const isFocused = useIsFocused();
  return isFocused ? <WorkflowScreenContent /> : <View style={styles.container} />;
}

/**
 * Read-through project workflows for every non-internal project registered on
 * this host — feature-gated by server_info.features.projectWorkflows.
 */
function useScreenProjectWorkflows(
  serverId: string | null,
  active: boolean,
): {
  projectDefinitions: ProjectWorkflowDefinition[];
  projectNameByCwd: ReadonlyMap<string, string>;
} {
  const supported = useHostFeature(serverId, "projectWorkflows");
  const { projects } = useProjects();
  const projectTargets = useMemo(
    () =>
      buildScheduleProjectTargets(projects).filter(
        (target) => (!serverId || target.serverId === serverId) && !isPaseoInternalPath(target.cwd),
      ),
    [projects, serverId],
  );
  const projectCwds = useMemo(() => projectTargets.map((target) => target.cwd), [projectTargets]);
  const projectNameByCwd = useMemo(
    () => new Map(projectTargets.map((target) => [target.cwd, target.projectName])),
    [projectTargets],
  );
  const { definitions } = useProjectWorkflowDefinitions(
    active && supported ? serverId : null,
    projectCwds,
  );
  return { projectDefinitions: definitions, projectNameByCwd };
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
  const { projectDefinitions, projectNameByCwd } = useScreenProjectWorkflows(serverId, active);
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
        .then(() => {
          toast.show(t("workflows.forkedToast", { name: definition.name }), {
            variant: "success",
          });
          setTab("definitions");
          return undefined;
        })
        .catch((error: unknown) => {
          toast.error(toErrorMessage(error));
        }),
    [mutations, t, toast],
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
        projectDefinitions={projectDefinitions}
        projectNameByCwd={projectNameByCwd}
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
          initialCwd={projectDefinitionRoot(dispatching)}
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
      <WorkflowRunDetailSheet
        serverId={serverId}
        run={inspecting}
        mutations={mutations}
        onClose={() => setInspecting(null)}
        onRunAgain={(newRun) => {
          setInspecting(newRun);
          setTab("runs");
        }}
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
  tab,
  onTabChange,
  definitions,
  projectDefinitions,
  projectNameByCwd,
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
  projectDefinitions: ProjectWorkflowDefinition[];
  projectNameByCwd: ReadonlyMap<string, string>;
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

  // Group read-through project definitions by their repo root — rendered as
  // per-project sections under the user's own definitions.
  const projectGroups = useMemo(() => {
    const groups = new Map<string, ProjectWorkflowDefinition[]>();
    for (const definition of projectDefinitions) {
      const list = groups.get(definition.projectCwd) ?? [];
      list.push(definition);
      groups.set(definition.projectCwd, list);
    }
    return [...groups.entries()];
  }, [projectDefinitions]);

  let content: ReactElement;
  if (tab === "definitions") {
    content =
      definitions.length === 0 && projectGroups.length === 0 ? (
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
          {projectGroups.map(([projectCwd, group]) => (
            <View key={projectCwd} style={styles.projectSection}>
              <Text style={styles.projectSectionTitle} numberOfLines={1}>
                {projectNameByCwd.get(projectCwd) ?? shortenPath(projectCwd)}
              </Text>
              <View style={styles.cardGrid}>
                {group.map((definition) => (
                  <View key={definition.id} style={styles.card}>
                    <View style={styles.cardBody}>
                      <View style={styles.titleRow}>
                        <Text style={styles.cardTitle} numberOfLines={2}>
                          {definition.name}
                        </Text>
                        <Text style={styles.badge}>{t("workflows.project")}</Text>
                      </View>
                      {definition.description ? (
                        <Text style={styles.meta} numberOfLines={3}>
                          {definition.description}
                        </Text>
                      ) : null}
                      {definition.sourcePath ? (
                        <Text style={styles.meta} numberOfLines={1}>
                          {shortenPath(definition.sourcePath)}
                        </Text>
                      ) : null}
                    </View>
                    <View style={styles.cardActions}>
                      <Button
                        variant="outline"
                        leftIcon={Play}
                        size="sm"
                        loading={isDispatching}
                        onPress={() => onDispatch(definition)}
                        testID={`workflow-project-run-${definition.name}`}
                      >
                        {t("workflows.actions.dispatch")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        leftIcon={GitFork}
                        loading={isCreating}
                        onPress={() => onCopyBuiltin(definition)}
                      >
                        {t("workflows.actions.forkBuiltin")}
                      </Button>
                    </View>
                  </View>
                ))}
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
                  leftIcon={Play}
                  size="sm"
                  loading={isDispatching}
                  onPress={() => onDispatch(definition)}
                  testID={`workflow-builtin-run-${definition.id}`}
                >
                  {t("workflows.actions.dispatch")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  leftIcon={GitFork}
                  loading={isCreating}
                  onPress={() => onCopyBuiltin(definition)}
                >
                  {t("workflows.actions.forkBuiltin")}
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
        <View style={styles.runList}>
          {runs.map((run) => {
            const summary = summarizeWorkflowRun(run);
            const name = definitionNameById.get(run.definitionId) ?? run.definitionId;
            const detail = summary.outcome ?? summary.task ?? t("workflows.runNoTask");
            return (
              <Pressable
                key={run.id}
                style={styles.runRow}
                onPress={() => onInspectRun(run)}
                testID={`workflow-run-${run.id}`}
              >
                <Text
                  style={
                    summary.displayStatus === "failed" ? styles.runStatusFailed : styles.runStatus
                  }
                  numberOfLines={1}
                >
                  {t(`workflows.status.${summary.displayStatus}`)}
                </Text>
                <View style={styles.runRowBody}>
                  <View style={styles.runRowTop}>
                    <Text style={styles.runRowTitle} numberOfLines={1}>
                      {name}
                    </Text>
                    <Text style={styles.meta}>{formatTimeAgo(new Date(run.queuedAt))}</Text>
                  </View>
                  <Text style={summary.outcome ? styles.errorText : styles.meta} numberOfLines={1}>
                    {detail}
                  </Text>
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
  preferences: FormPreferences,
  entries: readonly ProviderSnapshotEntry[] | undefined,
): { provider: string; model: string } | null {
  if (!entries || entries.length === 0) {
    return null;
  }
  const ready = entries.filter((entry) => entry.status === "ready");
  const preferred = preferences.provider
    ? ready.find((entry) => entry.provider === preferences.provider)
    : undefined;
  const entry = preferred ?? ready[0];
  if (!entry) {
    return null;
  }
  // Last-used model for this provider wins over the provider's default —
  // without this (and the submit-time write-back) the form reopened on the
  // first provider's default model every time.
  const savedModel = preferences.providerPreferences?.[entry.provider]?.model;
  const models = entry.models ?? null;
  const model =
    savedModel && models?.some((candidate) => candidate.id === savedModel)
      ? savedModel
      : (resolveDefaultModelId(models) ?? "");
  return { provider: entry.provider, model };
}

/**
 * Repo root of a read-through project definition — its sourcePath minus the
 * `.paseo/workflows` / `.claude/workflows` suffix. Used to default the
 * dispatch cwd to the repo the script lives in.
 */
function projectDefinitionRoot(definition: WorkflowDefinition): string | null {
  if (definition.origin !== "project" || !definition.sourcePath) {
    return null;
  }
  const normalized = definition.sourcePath.replace(/\\/g, "/");
  for (const marker of ["/.paseo/workflows/", "/.claude/workflows/"]) {
    const index = normalized.indexOf(marker);
    if (index > 0) {
      return definition.sourcePath.slice(0, index);
    }
  }
  return null;
}

function WorkflowInfoTooltip({
  accessibilityLabel,
  text,
  testID,
}: {
  accessibilityLabel: string;
  text: string;
  testID?: string;
}): ReactElement {
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
      <TooltipTrigger asChild>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          hitSlop={8}
          style={styles.infoButton}
          testID={testID}
        >
          <Info size={14} color={styles.infoIcon.color} />
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" offset={8} maxWidth={320}>
        <Text style={styles.tooltipText}>{text}</Text>
      </TooltipContent>
    </Tooltip>
  );
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
    () => resolveAuthoringProviderDefault(preferences, snapshot.entries),
    [preferences, snapshot.entries],
  );
  const modelSelectorProviders = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("workflows.createTitle"),
      actions: (
        <WorkflowInfoTooltip
          accessibilityLabel={t("workflows.authoring.hint")}
          text={t("workflows.authoring.hint")}
          testID="workflow-create-info"
        />
      ),
    }),
    [t],
  );

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

  const footer = useMemo(
    () => (
      <View style={styles.authoringFooter}>
        <Button
          variant="default"
          leftIcon={Sparkles}
          disabled={!selectedProvider || isStarting}
          loading={isStarting}
          testID="workflow-create-start"
          style={styles.authoringStartButton}
          onPress={() => void startAuthoring().catch((error) => toast.error(toErrorMessage(error)))}
        >
          {t("workflows.actions.startAuthoring")}
        </Button>
      </View>
    ),
    [isStarting, selectedProvider, startAuthoring, t, toast],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      snapPoints={AUTHORING_SNAP_POINTS}
      desktopHeight={AUTHORING_DESKTOP_HEIGHT}
      scrollable={false}
      testID="workflow-create-sheet"
    >
      <View style={styles.authoringBody}>
        <AgentModelField
          label={t("workflows.authoring.provider")}
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
        />
        <View style={styles.promptField}>
          <View style={styles.promptLabelRow}>
            <Text style={styles.promptLabel}>{t("workflows.authoring.prompt")}</Text>
            <WorkflowInfoTooltip
              accessibilityLabel={t("workflows.authoring.promptHint")}
              text={t("workflows.authoring.promptHint")}
              testID="workflow-create-prompt-info"
            />
          </View>
          <FormTextInput
            value={prompt}
            initialValue={prompt}
            resetKey={visible ? "open" : "closed"}
            onChangeText={setPrompt}
            multiline
            numberOfLines={12}
            textAlignVertical="top"
            style={styles.authoringPromptInput}
          />
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const WORKFLOW_DISPATCH_SNAP_POINTS = ["70%", "92%"];
const AUTHORING_SNAP_POINTS = ["78%", "94%"];
const AUTHORING_DESKTOP_HEIGHT = "72%" as const;

function WorkflowDispatchSheet({
  definition,
  initialCwd,
  serverId,
  isDispatching,
  onClose,
  onDispatch,
}: {
  definition: WorkflowDefinition;
  /** Preselected run cwd (e.g. the repo a project definition lives in). */
  initialCwd?: string | null;
  serverId: string | null;
  isDispatching: boolean;
  onClose: () => void;
  onDispatch: (input: DispatchWorkflowRunInput) => Promise<void> | void;
}): ReactElement {
  const { t } = useTranslation();
  const { preferences, updatePreferences } = useFormPreferences();
  const { projects } = useProjects();
  const isCompact = useIsCompactFormFactor();
  const [task, setTask] = useState("");
  const [workspaceTitleBody, setWorkspaceTitleBody] = useState(definition.name);
  const [cwd, setCwd] = useState<string | null>(null);
  const [cwdLabel, setCwdLabel] = useState<string | null>(null);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedEffort, setSelectedEffort] = useState("");
  const [selectedMode, setSelectedMode] = useState("");

  const snapshot = useProvidersSnapshot(serverId, {
    enabled: Boolean(serverId),
  });
  const providerDefault = useMemo(
    () => resolveAuthoringProviderDefault(preferences, snapshot.entries),
    [preferences, snapshot.entries],
  );
  const providerDefinitions = useMemo(
    () => buildProviderDefinitions(snapshot.entries),
    [snapshot.entries],
  );
  const modelSelectorProviders = useMemo(
    () => buildSelectableProviderSelectorProviders(snapshot.entries),
    [snapshot.entries],
  );
  const selectedProviderEntry = useMemo(
    () =>
      selectedProvider
        ? (snapshot.entries?.find((entry) => entry.provider === selectedProvider) ?? null)
        : null,
    [selectedProvider, snapshot.entries],
  );
  const availableModels = useMemo(
    () => selectedProviderEntry?.models ?? [],
    [selectedProviderEntry?.models],
  );
  const selectedModelDef = useMemo(() => {
    return availableModels.find((model) => model.id === selectedModel) ?? null;
  }, [availableModels, selectedModel]);
  const thinkingOptions = useMemo(
    () => selectedModelDef?.thinkingOptions ?? [],
    [selectedModelDef?.thinkingOptions],
  );
  const modeOptions = useMemo(
    () => selectedProviderEntry?.modes ?? [],
    [selectedProviderEntry?.modes],
  );
  const selectedProviderDefinition = useMemo(
    () =>
      selectedProvider
        ? (providerDefinitions.find((entry) => entry.id === selectedProvider) ?? undefined)
        : undefined,
    [providerDefinitions, selectedProvider],
  );
  const draftFeatures = useDraftAgentFeatures({
    serverId,
    provider: selectedProvider,
    cwd,
    modeId: selectedMode || null,
    modelId: selectedModel || null,
    thinkingOptionId: selectedEffort || null,
  });
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
      setSelectedProvider(providerDefault.provider as AgentProvider);
      setSelectedModel(providerDefault.model);
    }
  }, [providerDefault, selectedProvider]);

  useEffect(() => {
    if (thinkingOptions.length === 0) {
      setSelectedEffort("");
      return;
    }
    setSelectedEffort((current) => {
      if (current && thinkingOptions.some((option) => option.id === current)) {
        return current;
      }
      // Last-used thinking for this provider+model beats the model default.
      const saved = selectedProvider
        ? preferences.providerPreferences?.[selectedProvider]?.thinkingByModel?.[selectedModel]
        : undefined;
      if (saved && thinkingOptions.some((option) => option.id === saved)) {
        return saved;
      }
      return (
        selectedModelDef?.defaultThinkingOptionId ??
        thinkingOptions.find((option) => option.isDefault)?.id ??
        thinkingOptions[0]?.id ??
        ""
      );
    });
  }, [
    preferences.providerPreferences,
    selectedModel,
    selectedModelDef?.defaultThinkingOptionId,
    selectedProvider,
    thinkingOptions,
  ]);

  useEffect(() => {
    if (modeOptions.length === 0) {
      setSelectedMode("");
      return;
    }
    setSelectedMode((current) => {
      if (current && modeOptions.some((mode) => mode.id === current)) {
        return current;
      }
      const preferredModeId = selectedProvider
        ? preferences.providerPreferences?.[selectedProvider]?.mode
        : undefined;
      const resolved = resolvePreferredAgentModeId({
        preferredModeId,
        providerDef: selectedProviderDefinition,
      });
      if (resolved && modeOptions.some((mode) => mode.id === resolved)) {
        return resolved;
      }
      return selectedProviderEntry?.defaultModeId ?? modeOptions[0]?.id ?? "";
    });
  }, [
    modeOptions,
    preferences.providerPreferences,
    selectedProvider,
    selectedProviderDefinition,
    selectedProviderEntry?.defaultModeId,
  ]);

  useEffect(() => {
    if (cwd) {
      return;
    }
    // A project definition preselects its own repo as the run cwd.
    if (initialCwd) {
      const match = projectTargets.find((target) => target.cwd === initialCwd);
      setCwd(initialCwd);
      setCwdLabel(match && !isPaseoInternalPath(initialCwd) ? match.projectName : null);
      return;
    }
    if (projectTargets.length === 0) {
      return;
    }
    const preferred =
      projectTargets.find((target) => !isPaseoInternalPath(target.cwd)) ?? projectTargets[0];
    if (!preferred) {
      return;
    }
    setCwd(preferred.cwd);
    setCwdLabel(isPaseoInternalPath(preferred.cwd) ? null : preferred.projectName);
  }, [cwd, initialCwd, projectTargets]);

  const cwdTriggerLabel = cwdLabel ?? (cwd ? shortenPath(cwd) : t("workflows.projectPlaceholder"));
  const cwdHint = cwd && cwdLabel && shortenPath(cwd) !== cwdLabel ? shortenPath(cwd) : undefined;
  const canSubmit = Boolean(task.trim() && cwd?.trim() && selectedProvider && !isDispatching);

  const header = useMemo(
    () => ({
      title: t("workflows.dispatchTitleNamed", { name: definition.name }),
    }),
    [definition.name, t],
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
            if (selectedEffort.trim()) {
              args.effort = selectedEffort.trim();
            }
            if (selectedMode.trim()) {
              args.mode = selectedMode.trim();
            }
            const featureValues = collectAgentFeatureValues(draftFeatures.features);
            if (featureValues) {
              args.featureValues = featureValues;
              if (typeof featureValues.fast_mode === "boolean") {
                args.fast = featureValues.fast_mode;
              }
            }
            // Remember this selection — the sheet used to reopen on the first
            // provider's default model because nothing ever wrote back.
            void updatePreferences((current) =>
              mergeCreateAgentSelectionPreferences({
                preferences: current,
                provider: selectedProvider,
                modelId: selectedModel,
                modeId: selectedMode,
                thinkingOptionId: selectedEffort,
              }),
            );
            void onDispatch({
              definitionId: definition.id,
              cwd: cwd.trim(),
              workspaceTitle: formatWorkflowWorkspaceTitle(workspaceTitleBody, definition.name),
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
      definition.name,
      draftFeatures.features,
      isDispatching,
      onDispatch,
      selectedEffort,
      selectedMode,
      selectedModel,
      selectedProvider,
      t,
      task,
      updatePreferences,
      workspaceTitleBody,
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
          <Field label={t("workflows.workspaceTitle")}>
            <WorkflowWorkspaceTitleField
              value={workspaceTitleBody}
              definitionName={definition.name}
              onChangeText={setWorkspaceTitleBody}
            />
          </Field>
          <View style={styles.dispatchAgentControls} testID="workflow-dispatch-agent-controls">
            <DraftAgentControls
              providerDefinitions={providerDefinitions}
              selectedProvider={selectedProvider}
              onSelectProvider={setSelectedProvider}
              modeOptions={modeOptions}
              selectedMode={selectedMode}
              onSelectMode={setSelectedMode}
              models={availableModels}
              selectedModel={selectedModel}
              onSelectModel={setSelectedModel}
              isModelLoading={snapshot.isLoading || snapshot.isFetching}
              modelSelectorProviders={modelSelectorProviders}
              isAllModelsLoading={snapshot.isLoading || snapshot.isFetching}
              onSelectProviderAndModel={(provider, modelId) => {
                setSelectedProvider(provider);
                setSelectedModel(modelId);
              }}
              thinkingOptions={thinkingOptions}
              selectedThinkingOptionId={selectedEffort}
              onSelectThinkingOption={setSelectedEffort}
              features={draftFeatures.features}
              onSetFeature={draftFeatures.setFeatureValue}
              modelSelectorServerId={serverId}
              isCompactLayout={isCompact}
            />
            <DraftAgentModeControl
              placement="footer"
              selectedProvider={selectedProvider}
              providerDefinitions={providerDefinitions}
              modeOptions={modeOptions}
              selectedMode={selectedMode}
              onSelectMode={setSelectedMode}
              isCompactLayout={isCompact}
            />
          </View>
          <Field label={t("workflows.task")}>
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

function WorkflowWorkspaceTitleField({
  value,
  definitionName,
  onChangeText,
}: {
  value: string;
  definitionName: string;
  onChangeText: (value: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      style={({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
        styles.workspaceTitleRow,
        resolveControlInteractionStyles(
          {
            controlRest: styles.workspaceTitleControlRest,
            controlHover: styles.workspaceTitleControlHover,
            controlActive: styles.workspaceTitleControlActive,
            controlDisabled: styles.workspaceTitleControlDisabled,
          },
          { hovered, focused, disabled: false },
        ),
      ]}
    >
      <Text
        style={styles.workspaceTitlePrefix}
        accessibilityRole="text"
        accessibilityLabel={t("workflows.workspaceTitleEmojiLabel")}
      >
        {WORKFLOW_WORKSPACE_EMOJI_PREFIX.trimEnd()}
      </Text>
      <AdaptiveTextInput
        value={value}
        initialValue={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={t("workflows.workspaceTitlePlaceholder", { name: definitionName })}
        style={styles.workspaceTitleInput}
        testID="workflow-dispatch-workspace-title"
      />
    </Pressable>
  );
}

function WorkflowRunDetailSheet({
  serverId,
  run: initialRun,
  mutations,
  onClose,
  onRunAgain,
}: {
  serverId: string | null;
  run: WorkflowRun | null;
  mutations: ReturnType<typeof useWorkflowMutations>;
  onClose: () => void;
  onRunAgain: (run: WorkflowRun) => void;
}): ReactElement {
  const { t } = useTranslation();
  const liveQuery = useWorkflowRun(initialRun ? serverId : null, initialRun?.id ?? null, {
    initial: initialRun,
  });
  const run = liveQuery.run ?? initialRun;
  const summary = run ? summarizeWorkflowRun(run) : null;
  const live = liveQuery.live;
  const logs = useWorkflowRunLogs(run ? serverId : null, run?.id ?? null, { live });
  const [showDebug, setShowDebug] = useState(false);
  const header = useMemo<SheetHeader>(() => ({ title: t("workflows.runDetailTitle") }), [t]);

  const openAgent = useCallback(
    (agentId: string) => {
      if (!serverId) return;
      onClose();
      navigateToAgent({ serverId, agentId });
    },
    [onClose, serverId],
  );

  useEffect(() => {
    if (!initialRun) {
      setShowDebug(false);
    }
  }, [initialRun]);

  const footer = useMemo<ReactNode>(() => {
    if (!run) return null;
    return (
      <WorkflowRunDetailFooter
        run={run}
        serverId={serverId}
        mutations={mutations}
        onClose={onClose}
        onRunAgain={onRunAgain}
      />
    );
  }, [run, serverId, mutations, onClose, onRunAgain]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={initialRun !== null}
      onClose={onClose}
      footer={footer}
      testID="workflow-run-detail-sheet"
    >
      {run && summary ? (
        <WorkflowRunDetailBody
          run={run}
          summary={summary}
          live={live}
          logs={logs}
          serverId={serverId}
          onOpenAgent={openAgent}
          showDebug={showDebug}
          onToggleDebug={() => setShowDebug((current) => !current)}
        />
      ) : null}
    </AdaptiveModalSheet>
  );
}

function WorkflowRunDetailFooter({
  run,
  serverId,
  mutations,
  onClose,
  onRunAgain,
}: {
  run: WorkflowRun;
  serverId: string | null;
  mutations: ReturnType<typeof useWorkflowMutations>;
  onClose: () => void;
  onRunAgain: (run: WorkflowRun) => void;
}): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const [cancelRequested, setCancelRequested] = useState(false);
  const [isRunningAgain, setIsRunningAgain] = useState(false);

  useEffect(() => {
    setCancelRequested(false);
  }, [run.id]);

  const cancelRun = useCallback(() => {
    void confirmDialog({
      title: t("workflows.runCancelTitle"),
      message: t("workflows.runCancelMessage"),
      confirmLabel: t("workflows.actions.cancelRun"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    })
      .then((confirmed) => {
        if (!confirmed) return undefined;
        setCancelRequested(true);
        return mutations.cancel(run.id).catch((error: unknown) => {
          setCancelRequested(false);
          toast.error(toErrorMessage(error) || t("workflows.runCancelFailed"));
        });
      })
      .catch((error: unknown) => {
        toast.error(toErrorMessage(error));
      });
  }, [mutations, run.id, t, toast]);

  const runAgain = useCallback(() => {
    const storedTitle =
      typeof run.args.workspaceTitle === "string" ? run.args.workspaceTitle : undefined;
    setIsRunningAgain(true);
    mutations
      .dispatch({
        definitionId: run.definitionId,
        cwd: run.cwd,
        args: run.args,
        workspaceTitle: storedTitle ? stripWorkflowWorkspaceEmojiPrefix(storedTitle) : undefined,
      })
      .then((created) => onRunAgain(created))
      .catch((error: unknown) => {
        toast.error(toErrorMessage(error) || t("workflows.runAgainFailed"));
      })
      .finally(() => setIsRunningAgain(false));
  }, [mutations, onRunAgain, run, t, toast]);

  const openWorkspace = useCallback(() => {
    if (!serverId || !run.workspaceId) return;
    onClose();
    navigateToWorkspace({ serverId, workspaceId: run.workspaceId });
  }, [onClose, run, serverId]);

  const canCancel = run.status === "queued" || run.status === "running";
  const canRunAgain =
    run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
  const showCancelling = cancelRequested && canCancel;

  return (
    <View style={styles.runDetailFooter}>
      {run.workspaceId ? (
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Folder}
          onPress={openWorkspace}
          testID="workflow-run-open-workspace"
        >
          {t("workflows.runOpenWorkspace")}
        </Button>
      ) : null}
      {canCancel ? (
        <Button
          variant="destructive"
          size="sm"
          loading={showCancelling}
          disabled={showCancelling}
          onPress={cancelRun}
          testID="workflow-run-cancel"
        >
          {showCancelling ? t("workflows.runCancelling") : t("workflows.actions.cancelRun")}
        </Button>
      ) : null}
      {canRunAgain ? (
        <Button
          variant="default"
          size="sm"
          leftIcon={Play}
          loading={isRunningAgain}
          onPress={runAgain}
          testID="workflow-run-again"
        >
          {t("workflows.actions.runAgain")}
        </Button>
      ) : null}
    </View>
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
  // Full-width row inside the card grid: a per-project group of read-through
  // repo definitions, titled with the project name.
  projectSection: {
    width: "100%",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  projectSectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
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
  runList: {
    gap: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  runRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  runRowBody: { flex: 1, minWidth: 0, gap: 2 },
  runRowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  runRowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  errorText: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
  runStatus: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    width: 72,
  },
  runStatusFailed: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    width: 72,
  },
  infoButton: {
    padding: theme.spacing[1],
  },
  infoIcon: {
    color: theme.colors.foregroundMuted,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.4),
  },
  authoringBody: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[4],
  },
  authoringFooter: {
    flex: 1,
    flexDirection: "row",
  },
  runDetailFooter: {
    flexDirection: "row",
    gap: theme.spacing[2],
    justifyContent: "flex-end",
  },
  authoringStartButton: {
    flex: 1,
  },
  promptField: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[2],
  },
  promptLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  promptLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  authoringPromptInput: {
    flex: 1,
    minHeight: 220,
  },
  dispatchBody: {
    gap: theme.spacing[4],
  },
  dispatchAgentControls: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  dispatchFooter: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  cwdIcon: {
    color: theme.colors.foregroundMuted,
  },
  workspaceTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[3],
    minHeight: 40,
  },
  workspaceTitleControlRest: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  workspaceTitleControlHover: {
    borderColor: theme.colors.borderAccent,
  },
  workspaceTitleControlActive: {
    borderColor: theme.colors.borderAccent,
    outlineColor: theme.colors.accent,
    outlineOffset: 1,
    outlineStyle: "solid" as const,
    outlineWidth: 2,
  },
  workspaceTitleControlDisabled: {
    opacity: theme.opacity[50],
  },
  workspaceTitlePrefix: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: Math.round(theme.fontSize.base * 1.3),
  },
  workspaceTitleInput: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[2],
    // Kill AdaptiveTextInput's leaf focus ring — chrome owns the ring.
    outlineWidth: 0,
    outlineColor: "transparent",
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
