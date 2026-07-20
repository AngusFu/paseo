/**
 * Workspace tab panel for composing a workflow run — the workflow counterpart
 * of the agent draft tab. Picks a definition, a repo root and an agent
 * provider/model, takes the task text, then retargets itself to the
 * `workflow_run` tab the dispatch returns.
 *
 * The cwd is the workspace's own repo root (a worktree workspace dispatches
 * into that worktree). The platform never mints an extra worktree for the run —
 * flows that want one manage it themselves.
 */
import { useCallback, useMemo, useState, type ReactElement } from "react";
import {
  ScrollView,
  Text,
  View,
  type NativeSyntheticEvent,
  type PressableStateCallbackType,
  type TextInputKeyPressEventData,
} from "react-native";
import { Folder, Play, Workflow } from "lucide-react-native";
import { Pressable } from "react-native";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { StyleSheet } from "react-native-unistyles";
import type { WorkflowDefinition } from "@getpaseo/protocol/workflow/types";
import { formatWorkflowWorkspaceTitle } from "@getpaseo/protocol/workflow/workspace-title";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectFieldTrigger } from "@/components/ui/select-field";
import { DraftAgentControls } from "@/composer/agent-controls";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useWorkflowMutations } from "@/hooks/use-workflow-mutations";
import { useWorkspaceWorkflowDefinitions } from "@/hooks/use-workspace-workflow-definitions";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { WorkflowDirectoryPickerSheet } from "@/screens/workflow-directory-picker-sheet";
import { useWorkflowDispatchForm } from "@/screens/workflow-dispatch-form";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { toErrorMessage } from "@/utils/error-messages";
import { shortenPath } from "@/utils/shorten-path";

/** Modifier flags exist on web (react-native-web) only; native carries just `key`. */
type WorkflowDraftKeyPressEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & { metaKey?: boolean; ctrlKey?: boolean }
>;

interface WorkflowDraftTarget {
  kind: "workflow_draft";
  draftId: string;
  definitionId: string;
}

function useWorkspaceRepoRoot(serverId: string, workspaceId: string): string | null {
  const fields = useWorkspaceFields(serverId, workspaceId, (workspace) => ({
    workspaceDirectory: workspace.workspaceDirectory,
  }));
  return fields?.workspaceDirectory || null;
}

function useWorkflowDraftPanelDescriptor(
  target: WorkflowDraftTarget,
  context: { serverId: string; workspaceId: string },
): PanelDescriptor {
  const { t } = useTranslation();
  const cwd = useWorkspaceRepoRoot(context.serverId, context.workspaceId);
  const { definitions } = useWorkspaceWorkflowDefinitions({ serverId: context.serverId, cwd });
  const definition = definitions.find((entry) => entry.id === target.definitionId) ?? null;

  return {
    label: definition?.name || t("workflows.draftTabLabel"),
    subtitle: "",
    titleState: "ready",
    icon: Workflow,
    statusBucket: null,
  };
}

function WorkflowDraftPanel(): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const { serverId, workspaceId, target, retargetCurrentTab } = usePaneContext();
  invariant(target.kind === "workflow_draft", "WorkflowDraftPanel requires workflow_draft target");

  const repoRoot = useWorkspaceRepoRoot(serverId, workspaceId);
  const { definitions } = useWorkspaceWorkflowDefinitions({ serverId, cwd: repoRoot });
  const definition = definitions.find((entry) => entry.id === target.definitionId) ?? null;
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const mutations = useWorkflowMutations({ serverId });
  const form = useWorkflowDispatchForm({ serverId, initialCwd: repoRoot });
  const { cwd, cwdLabel, selectCwd } = form;

  const cwdTriggerLabel = cwdLabel ?? (cwd ? shortenPath(cwd) : t("workflows.projectPlaceholder"));
  const canSubmit = form.isReady && Boolean(definition) && !mutations.isDispatching;

  const handleSelectDefinition = useCallback(
    (next: WorkflowDefinition) => {
      retargetCurrentTab({
        kind: "workflow_draft",
        draftId: target.draftId,
        definitionId: next.id,
      });
    },
    [retargetCurrentTab, target.draftId],
  );

  const handleDispatch = useCallback(async () => {
    if (!definition || !cwd?.trim()) {
      return;
    }
    form.rememberSelection();
    try {
      const run = await mutations.dispatch({
        definitionId: definition.id,
        cwd: cwd.trim(),
        workspaceTitle: formatWorkflowWorkspaceTitle(definition.name, definition.name),
        args: form.buildArgs(),
      });
      // Replace this draft tab in place — the run's own workspace opens its own
      // tab separately, this keeps the user where they started.
      retargetCurrentTab({ kind: "workflow_run", runId: run.id });
    } catch (error) {
      toast.show(toErrorMessage(error), { variant: "error" });
    }
  }, [cwd, definition, form, mutations, retargetCurrentTab, toast]);

  // Plain Enter stays a newline in the multiline task box; Cmd/Ctrl+Enter sends,
  // matching the agent composer. The modifier flags are web-only — on native the
  // key event carries no modifiers, so this simply never fires there.
  const handleTaskKeyPress = useCallback(
    (event: WorkflowDraftKeyPressEvent) => {
      const { key, metaKey, ctrlKey } = event.nativeEvent;
      if (key !== "Enter" || !(metaKey || ctrlKey) || !canSubmit) {
        return;
      }
      event.preventDefault?.();
      void handleDispatch();
    },
    [canSubmit, handleDispatch],
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
        testID="workflow-draft-cwd-trigger"
      />
    ),
    [cwd, cwdLeading, cwdTriggerLabel, pickingDirectory, t],
  );

  const definitionTriggerLabel = definition?.name ?? t("workflows.draftTabLabel");
  const definitionLeading = useMemo(() => <Workflow size={16} color={styles.cwdIcon.color} />, []);
  const openDirectoryPicker = useCallback(() => setPickingDirectory(true), []);
  const closeDirectoryPicker = useCallback(() => setPickingDirectory(false), []);
  const handleSelectDirectory = useCallback(
    (path: string) => {
      selectCwd(path);
      setPickingDirectory(false);
    },
    [selectCwd],
  );

  const definitionItems = useMemo(
    () =>
      definitions.map((entry) => (
        <WorkflowDefinitionMenuItem
          key={entry.id}
          definition={entry}
          onSelect={handleSelectDefinition}
        />
      )),
    [definitions, handleSelectDefinition],
  );

  return (
    <>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        testID="workflow-draft-panel"
      >
        <Text style={styles.title}>{definitionTriggerLabel}</Text>
        <View style={styles.pickerRow}>
          <DropdownMenu>
            <DropdownMenuTrigger testID="workflow-draft-definition-trigger">
              <SelectFieldTrigger
                label={definitionTriggerLabel}
                placeholder={t("workflows.draftTabLabel")}
                leading={definitionLeading}
                size="sm"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start" offset={4} minWidth={220}>
              {definitionItems}
            </DropdownMenuContent>
          </DropdownMenu>
          <Pressable onPress={openDirectoryPicker} testID="workflow-draft-cwd">
            {renderCwdTrigger}
          </Pressable>
          <DraftAgentControls
            providerDefinitions={form.providerDefinitions}
            selectedProvider={form.selectedProvider}
            onSelectProvider={form.setSelectedProvider}
            modeOptions={form.modeOptions}
            selectedMode={form.selectedMode}
            onSelectMode={form.setSelectedMode}
            models={form.availableModels}
            selectedModel={form.selectedModel}
            onSelectModel={form.setSelectedModel}
            isModelLoading={form.snapshot.isLoading || form.snapshot.isFetching}
            modelSelectorProviders={form.modelSelectorProviders}
            isAllModelsLoading={form.snapshot.isLoading || form.snapshot.isFetching}
            onSelectProviderAndModel={form.setProviderAndModel}
            thinkingOptions={form.thinkingOptions}
            selectedThinkingOptionId={form.selectedEffort}
            onSelectThinkingOption={form.setSelectedEffort}
            features={form.features.features}
            onSetFeature={form.features.setFeatureValue}
            modelSelectorServerId={serverId}
            isCompactLayout={isCompact}
          />
        </View>
        <Field label={t("workflows.task")}>
          <FormTextInput
            value={form.task}
            initialValue={form.task}
            onChangeText={form.setTask}
            onKeyPress={handleTaskKeyPress}
            placeholder={t("workflows.taskPlaceholder")}
            multiline
            numberOfLines={10}
            textAlignVertical="top"
            style={styles.taskInput}
            testID="workflow-draft-task-input"
          />
        </Field>
        <View style={styles.footer}>
          <Button
            variant="default"
            leftIcon={Play}
            disabled={!canSubmit}
            loading={mutations.isDispatching}
            testID="workflow-draft-confirm"
            onPress={handleDispatch}
          >
            {t("workflows.actions.confirmDispatch")}
          </Button>
        </View>
      </ScrollView>
      <WorkflowDirectoryPickerSheet
        visible={pickingDirectory}
        serverId={serverId}
        initialPath={cwd}
        shortcuts={form.directoryShortcuts}
        onClose={closeDirectoryPicker}
        onSelect={handleSelectDirectory}
      />
    </>
  );
}

function WorkflowDefinitionMenuItem({
  definition,
  onSelect,
}: {
  definition: WorkflowDefinition;
  onSelect: (definition: WorkflowDefinition) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(definition), [definition, onSelect]);
  return <DropdownMenuItem onSelect={handleSelect}>{definition.name}</DropdownMenuItem>;
}

export const workflowDraftPanelRegistration: PanelRegistration<"workflow_draft"> = {
  kind: "workflow_draft",
  component: WorkflowDraftPanel,
  useDescriptor: useWorkflowDraftPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  taskInput: {
    minHeight: 160,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  cwdIcon: {
    color: theme.colors.foregroundMuted,
  },
}));
