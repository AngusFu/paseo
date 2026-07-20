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
import { AgentModelField } from "@/components/agent-launch-fields";
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
import { useFormPreferences } from "@/hooks/use-form-preferences";
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
import { useHostFeature } from "@/runtime/host-features";
import {
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { WorkflowDirectoryPickerSheet } from "@/screens/workflow-directory-picker-sheet";
import {
  isPaseoInternalPath,
  resolveAuthoringProviderDefault,
  useWorkflowDispatchForm,
} from "@/screens/workflow-dispatch-form";
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
  const isCompact = useIsCompactFormFactor();
  const [workspaceTitleBody, setWorkspaceTitleBody] = useState(definition.name);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const form = useWorkflowDispatchForm({ serverId, initialCwd });
  const {
    task,
    setTask,
    cwd,
    cwdLabel,
    selectCwd,
    selectedProvider,
    setSelectedProvider,
    selectedModel,
    setSelectedModel,
    selectedEffort,
    setSelectedEffort,
    selectedMode,
    setSelectedMode,
    snapshot,
    providerDefinitions,
    modelSelectorProviders,
    availableModels,
    thinkingOptions,
    modeOptions,
    features: draftFeatures,
    directoryShortcuts,
  } = form;

  const cwdTriggerLabel = cwdLabel ?? (cwd ? shortenPath(cwd) : t("workflows.projectPlaceholder"));
  const cwdHint = cwd && cwdLabel && shortenPath(cwd) !== cwdLabel ? shortenPath(cwd) : undefined;
  const canSubmit = form.isReady && !isDispatching;

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
            form.rememberSelection();
            void onDispatch({
              definitionId: definition.id,
              cwd: cwd.trim(),
              workspaceTitle: formatWorkflowWorkspaceTitle(workspaceTitleBody, definition.name),
              args: form.buildArgs(),
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
      form,
      isDispatching,
      onDispatch,
      t,
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
          selectCwd(path);
          setPickingDirectory(false);
        }}
      />
    </>
  );
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
  const [isResuming, setIsResuming] = useState(false);
  // COMPAT(workflowRunResume): added in v0.1.112, drop the gate when floor >= v0.1.112.
  const resumeSupported = useHostFeature(serverId, "workflowRunResume");

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

  const resumeRun = useCallback(() => {
    setIsResuming(true);
    mutations
      .dispatch({
        definitionId: run.definitionId,
        resumeFromRunId: run.id,
      })
      .then((created) => onRunAgain(created))
      .catch((error: unknown) => {
        toast.error(toErrorMessage(error) || t("workflows.runResumeFailed"));
      })
      .finally(() => setIsResuming(false));
  }, [mutations, onRunAgain, run.definitionId, run.id, t, toast]);

  const openWorkspace = useCallback(() => {
    if (!serverId || !run.workspaceId) return;
    onClose();
    navigateToWorkspace({ serverId, workspaceId: run.workspaceId });
  }, [onClose, run, serverId]);

  const canCancel = run.status === "queued" || run.status === "running";
  const canRunAgain =
    run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
  // Resume only makes sense when something remains to redo — a failed or
  // cancelled run whose successful stages can replay from its journal.
  const canResume = resumeSupported && (run.status === "failed" || run.status === "cancelled");
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
          variant={canResume ? "outline" : "default"}
          size="sm"
          leftIcon={Play}
          loading={isRunningAgain}
          onPress={runAgain}
          testID="workflow-run-again"
        >
          {t("workflows.actions.runAgain")}
        </Button>
      ) : null}
      {canResume ? (
        <Button
          variant="default"
          size="sm"
          leftIcon={Play}
          loading={isResuming}
          onPress={resumeRun}
          testID="workflow-run-resume"
        >
          {t("workflows.actions.resume")}
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
