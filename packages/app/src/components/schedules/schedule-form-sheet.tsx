import equal from "fast-deep-equal";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, Text, View } from "react-native";
import { Brain, Folder, GitBranch, Plus, X } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ComboboxItem } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import {
  AgentModeField,
  AgentModelField,
  AgentThinkingField,
} from "@/components/agent-launch-fields";
import { useIsCompactFormFactor } from "@/constants/layout";
import { HostStatusDotSlot } from "@/components/hosts/host-picker";
import { createControlGeometry, type FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { getProviderIcon } from "@/components/provider-icons";
import { CadenceEditor } from "@/components/schedules/cadence-editor";
import {
  SelectField,
  SelectFieldTrigger,
  type SelectFieldDisplay,
  type SelectFieldOption,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import {
  mergeProviderPreferences,
  useFormPreferences,
  type FormPreferences,
} from "@/hooks/use-form-preferences";
import { useScheduleMutations } from "@/hooks/use-schedule-mutations";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { useProjects } from "@/hooks/use-projects";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { buildScheduleProjectTargets } from "@/schedules/schedule-project-targets";
import { useScheduleFormModel } from "@/schedules/use-schedule-form-model";
import { useScheduleFormProviderSnapshot } from "@/schedules/use-schedule-form-provider-snapshot";
import {
  buildCommandEnvRecord,
  parseCommandTimeoutMs,
  type ScheduleFormDisplay,
  type ScheduleFormHost,
  type ScheduleFormModel,
  type ScheduleFormSnapshot,
  type ScheduleFormState,
  type ScheduleFormTargetKind,
} from "@/schedules/schedule-form-model";
import { validateCron } from "@/utils/schedule-format";
import { toErrorMessage } from "@/utils/error-messages";
import { getDeviceTimeZone } from "@/utils/device-timezone";

export interface ScheduleFormSheetProps {
  serverId?: string;
  visible: boolean;
  onClose: () => void;
  mode: "create" | "edit";
  schedule?: ScheduleSummary;
}

function parseMaxRuns(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveCreateServerId(input: {
  mode: "create" | "edit";
  serverId: string | null | undefined;
  hosts: readonly ScheduleFormHost[];
}): string | null {
  if (input.mode === "edit") {
    return input.serverId ?? null;
  }
  if (input.serverId !== undefined) {
    return input.serverId;
  }
  if (input.hosts.length === 1) {
    return input.hosts[0]?.serverId ?? null;
  }
  return null;
}

function buildScheduleHostOptionTestId(serverId: string): string {
  return `schedule-host-option-${serverId}`;
}

function buildThinkingOptionTestId(optionId: string): string {
  return `schedule-thinking-option-${optionId}`;
}

function openKey(props: ScheduleFormSheetProps): string {
  if (props.mode === "edit") {
    return `edit:${props.serverId ?? ""}:${props.schedule?.id ?? ""}`;
  }
  return `create:${props.serverId ?? ""}`;
}

function selectScheduleHosts(
  hosts: readonly { serverId: string; label: string }[],
): (state: ReturnType<typeof useSessionStore.getState>) => ScheduleFormHost[] {
  return (state) =>
    hosts.map((host) => ({
      serverId: host.serverId,
      label: host.label,
      supportsWorkspaceMultiplicity:
        state.sessions[host.serverId]?.serverInfo?.features?.workspaceMultiplicity === true,
      supportsCommandSchedules:
        state.sessions[host.serverId]?.serverInfo?.features?.commandSchedules === true,
    }));
}

function buildSnapshot(input: {
  mode: "create" | "edit";
  serverId: string | undefined;
  schedule: ScheduleSummary | undefined;
  hosts: readonly ScheduleFormHost[];
  projectTargets: ReturnType<typeof buildScheduleProjectTargets>;
  preferences: FormPreferences;
  timezone: string;
}): ScheduleFormSnapshot {
  const schedule = input.schedule
    ? { ...input.schedule, serverId: input.serverId, serverName: undefined }
    : undefined;
  return {
    mode: input.mode,
    schedule,
    hosts: input.hosts,
    defaults: {
      serverId: resolveCreateServerId({
        mode: input.mode,
        serverId: input.serverId,
        hosts: input.hosts,
      }),
      projectTargets: input.projectTargets,
      preferences: input.preferences,
      timezone: input.timezone,
    },
  };
}

function updateSelectionPreferences(input: {
  preferences: FormPreferences;
  provider: AgentProvider;
  model: string;
  mode: string;
  thinkingOptionId: string;
  isolation: "local" | "worktree";
}): FormPreferences {
  const model = input.model.trim();
  const mode = input.mode.trim();
  const thinkingOptionId = input.thinkingOptionId.trim();
  return {
    ...mergeProviderPreferences({
      preferences: input.preferences,
      provider: input.provider,
      updates: {
        model: model || undefined,
        mode: mode || undefined,
        ...(model && thinkingOptionId ? { thinkingByModel: { [model]: thinkingOptionId } } : {}),
      },
    }),
    isolation: input.isolation,
  };
}

export function ScheduleFormSheet(props: ScheduleFormSheetProps): ReactElement | null {
  const [renderedProps, setRenderedProps] = useState<ScheduleFormSheetProps | null>(() =>
    props.visible ? props : null,
  );
  const [sheetVisible, setSheetVisible] = useState(props.visible);
  const livePropsRef = useRef(props);
  const closeRequestedRef = useRef(false);
  livePropsRef.current = props;

  useEffect(() => {
    if (props.visible) {
      if (closeRequestedRef.current) {
        return;
      }
      setRenderedProps(props);
      setSheetVisible(true);
      return;
    }
    if (renderedProps) {
      setSheetVisible(false);
    }
  }, [props, renderedProps]);

  const requestClose = useCallback(() => {
    closeRequestedRef.current = true;
    setSheetVisible(false);
  }, []);

  const handleDismiss = useCallback(() => {
    const dismissedProps = livePropsRef.current;
    closeRequestedRef.current = false;
    setRenderedProps(null);
    setSheetVisible(false);
    if (dismissedProps.visible) {
      dismissedProps.onClose();
    }
  }, []);

  if (!renderedProps) {
    return null;
  }

  return (
    <OpenScheduleFormSheet
      key={openKey(renderedProps)}
      {...renderedProps}
      visible={sheetVisible}
      onClose={requestClose}
      onDismiss={handleDismiss}
    />
  );
}

function OpenScheduleFormSheet({
  serverId,
  visible,
  onClose,
  onDismiss,
  mode,
  schedule,
}: ScheduleFormSheetProps & { onDismiss: () => void }): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const { projects } = useProjects();
  const hostProfiles = useHosts();
  const hosts = useStoreWithEqualityFn(
    useSessionStore,
    useMemo(() => selectScheduleHosts(hostProfiles), [hostProfiles]),
    equal,
  );
  const { preferences, updatePreferences } = useFormPreferences();
  const projectTargets = useMemo(() => buildScheduleProjectTargets(projects), [projects]);
  const timezone = useMemo(getDeviceTimeZone, []);
  const snapshot = useMemo(
    () =>
      buildSnapshot({
        mode,
        serverId,
        schedule,
        hosts,
        projectTargets,
        preferences,
        timezone,
      }),
    [hosts, mode, preferences, projectTargets, schedule, serverId, timezone],
  );
  const model = useScheduleFormModel(snapshot);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const providerSnapshot = useScheduleFormProviderSnapshot(model, state);
  const { agents } = useAggregatedAgents({ includeArchived: true });
  const mutationServerId = state.selectedServerId ?? serverId ?? "";
  const { createSchedule, updateSchedule, isCreating, isUpdating } = useScheduleMutations({
    serverId: mutationServerId,
  });

  const isSubmitting = isCreating || isUpdating;
  const cadenceError =
    state.cadence.type === "cron" ? validateCron(state.cadence.expression) : null;
  const canSubmit = state.canSubmit && cadenceError === null && !isSubmitting;
  const agentTargetLabel = useMemo(() => {
    if (!schedule || schedule.target.type !== "agent") {
      return null;
    }
    const { agentId } = schedule.target;
    const agent = agents.find(
      (entry) => entry.serverId === (state.selectedServerId ?? serverId) && entry.id === agentId,
    );
    if (!agent) {
      return t("schedule.form.agentUnavailable");
    }
    return agent.title?.trim() || t("schedule.form.untitledAgent");
  }, [agents, schedule, serverId, state.selectedServerId, t]);

  const persistPreferences = useCallback(async () => {
    const provider = state.selectedProvider;
    if (!provider) {
      return;
    }
    await updatePreferences((current) =>
      updateSelectionPreferences({
        preferences: current,
        provider,
        model: state.selectedModel,
        mode: state.selectedMode,
        thinkingOptionId: state.selectedThinkingOptionId,
        isolation: state.isolation,
      }),
    );
  }, [
    state.isolation,
    state.selectedMode,
    state.selectedModel,
    state.selectedProvider,
    state.selectedThinkingOptionId,
    updatePreferences,
  ]);

  const submitAgentTarget = useCallback(async (): Promise<boolean> => {
    if (!schedule) {
      return false;
    }
    await updateSchedule({
      id: schedule.id,
      name: state.name.trim() || null,
      prompt: state.prompt.trim(),
      cadence: state.submitCadence,
      maxRuns: parseMaxRuns(state.maxRuns),
    });
    return true;
  }, [schedule, state.maxRuns, state.name, state.prompt, state.submitCadence, updateSchedule]);

  const submitNewAgent = useCallback(async (): Promise<boolean> => {
    const provider = state.selectedProvider;
    const cwd = state.workingDir.trim();
    if (!provider || !cwd) {
      return false;
    }

    await persistPreferences();
    const maxRuns = parseMaxRuns(state.maxRuns);
    if (mode === "edit" && schedule) {
      await updateSchedule({
        id: schedule.id,
        name: state.name.trim() || null,
        prompt: state.prompt.trim(),
        cadence: state.submitCadence,
        newAgentConfig: {
          provider,
          model: state.selectedModel || null,
          modeId: state.selectedMode || null,
          thinkingOptionId: state.selectedThinkingOptionId || null,
          cwd,
          ...(state.submitArchiveOnFinish !== undefined
            ? { archiveOnFinish: state.submitArchiveOnFinish }
            : {}),
          ...(state.submitIsolation !== undefined ? { isolation: state.submitIsolation } : {}),
        },
        maxRuns,
      });
      return true;
    }

    await createSchedule({
      prompt: state.prompt.trim(),
      name: state.name.trim() || undefined,
      cadence: state.submitCadence,
      target: {
        type: "new-agent",
        config: {
          provider,
          cwd,
          model: state.selectedModel || undefined,
          modeId: state.selectedMode || undefined,
          thinkingOptionId: state.selectedThinkingOptionId || undefined,
          ...(state.submitArchiveOnFinish !== undefined
            ? { archiveOnFinish: state.submitArchiveOnFinish }
            : {}),
          ...(state.submitIsolation !== undefined ? { isolation: state.submitIsolation } : {}),
          title: state.name.trim() || undefined,
        },
      },
      ...(maxRuns != null ? { maxRuns } : {}),
    });
    return true;
  }, [createSchedule, mode, persistPreferences, schedule, state, updateSchedule]);

  const submitCommand = useCallback(async (): Promise<boolean> => {
    const cwd = state.workingDir.trim();
    const command = state.command.trim();
    if (!cwd || !command) {
      return false;
    }
    const env = buildCommandEnvRecord(state.commandEnvRows);
    const hasEnv = Object.keys(env).length > 0;
    const timeoutMs = parseCommandTimeoutMs(state.commandTimeoutSeconds);
    const maxRuns = parseMaxRuns(state.maxRuns);
    // The daemon runs `target.command`; the create path mirrors it into prompt
    // so old clients still have something to show. On update the daemon rejects
    // a prompt field for command targets (it lives on the command now), so we
    // must not send one.
    if (mode === "edit" && schedule) {
      await updateSchedule({
        id: schedule.id,
        name: state.name.trim() || null,
        cadence: state.submitCadence,
        commandConfig: {
          command,
          cwd,
          env: hasEnv ? env : null,
          timeoutMs: timeoutMs ?? null,
        },
        maxRuns,
      });
      return true;
    }
    await createSchedule({
      prompt: command,
      name: state.name.trim() || undefined,
      cadence: state.submitCadence,
      target: {
        type: "command",
        command,
        cwd,
        ...(hasEnv ? { env } : {}),
        ...(timeoutMs != null ? { timeoutMs } : {}),
      },
      ...(maxRuns != null ? { maxRuns } : {}),
    });
    return true;
  }, [createSchedule, mode, schedule, state, updateSchedule]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    model.setSubmitError(null);
    try {
      let submitted: boolean;
      if (state.targetKind === "agent") {
        submitted = await submitAgentTarget();
      } else if (state.targetKind === "command") {
        submitted = await submitCommand();
      } else {
        submitted = await submitNewAgent();
      }
      if (submitted) {
        onClose();
      }
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    }
  }, [
    canSubmit,
    model,
    onClose,
    state.targetKind,
    submitAgentTarget,
    submitCommand,
    submitNewAgent,
  ]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: mode === "edit" ? t("schedule.form.editTitle") : t("schedule.form.createTitle"),
    }),
    [mode, t],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isSubmitting}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSubmitPress}
          disabled={!canSubmit}
          loading={isSubmitting}
          testID="schedule-form-submit"
        >
          {mode === "edit" ? t("schedule.form.save") : t("schedule.form.create")}
        </Button>
      </View>
    ),
    [canSubmit, handleSubmitPress, isSubmitting, mode, onClose, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      footer={footer}
      webScrollbar
      testID="schedule-form-sheet"
    >
      <ScheduleFormFields
        model={model}
        state={state}
        providerSnapshot={providerSnapshot}
        agentTargetLabel={agentTargetLabel}
        controlSize={controlSize}
        cadenceError={cadenceError}
        mutationServerId={mutationServerId}
      />
    </AdaptiveModalSheet>
  );
}

interface ScheduleFormFieldsProps {
  model: ScheduleFormModel;
  state: ScheduleFormState;
  providerSnapshot: ReturnType<typeof useScheduleFormProviderSnapshot>;
  agentTargetLabel: string | null;
  controlSize: FieldControlSize;
  cadenceError: string | null;
  mutationServerId: string;
}

function ScheduleFormFields({
  model,
  state,
  providerSnapshot,
  agentTargetLabel,
  controlSize,
  cadenceError,
  mutationServerId,
}: ScheduleFormFieldsProps): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t("schedule.form.name.label")}>
        <FormTextInput
          size={controlSize}
          testID="schedule-name-input"
          accessibilityLabel={t("schedule.form.name.accessibility")}
          initialValue={state.name}
          value={state.name}
          onChangeText={model.setName}
          placeholder={t("schedule.form.name.placeholder")}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>

      <ScheduleTargetFields
        model={model}
        state={state}
        providerSnapshot={providerSnapshot}
        agentTargetLabel={agentTargetLabel}
        controlSize={controlSize}
        mutationServerId={mutationServerId}
      />

      {state.targetKind === "command" ? null : (
        <Field label={t("schedule.form.prompt.label")}>
          <FormTextInput
            size={controlSize}
            testID="schedule-prompt-input"
            accessibilityLabel={t("schedule.form.prompt.label")}
            initialValue={state.prompt}
            value={state.prompt}
            onChangeText={model.setPrompt}
            placeholder={t("schedule.form.prompt.placeholder")}
            style={styles.multilineInput}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </Field>
      )}

      <CadenceEditor
        value={state.cadence}
        onChange={model.setCadence}
        error={cadenceError ?? undefined}
        size={controlSize}
        serverId={mutationServerId}
      />

      <Field label={t("schedule.form.maxRuns.label")}>
        <FormTextInput
          size={controlSize}
          testID="schedule-max-runs-input"
          accessibilityLabel={t("schedule.form.maxRuns.label")}
          initialValue={state.maxRuns}
          value={state.maxRuns}
          onChangeText={model.setMaxRuns}
          placeholder={t("schedule.form.maxRuns.placeholder")}
          keyboardType="number-pad"
        />
      </Field>

      {state.submitError ? <Text style={styles.submitError}>{state.submitError}</Text> : null}
    </>
  );
}

interface ScheduleTargetFieldsProps {
  model: ScheduleFormModel;
  state: ScheduleFormState;
  providerSnapshot: ReturnType<typeof useScheduleFormProviderSnapshot>;
  agentTargetLabel: string | null;
  controlSize: FieldControlSize;
  mutationServerId: string;
}

function ScheduleTargetFields({
  model,
  state,
  providerSnapshot,
  agentTargetLabel,
  controlSize,
  mutationServerId,
}: ScheduleTargetFieldsProps): ReactElement {
  const { t } = useTranslation();
  const hostOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      state.hosts.map((host) => ({
        id: host.serverId,
        value: host.serverId,
        label: host.label,
        testID: buildScheduleHostOptionTestId(host.serverId),
      })),
    [state.hosts],
  );
  const selectedHost = state.hosts.find((host) => host.serverId === state.selectedServerId) ?? null;
  const selectedHostDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (selectedHost) {
      return { label: selectedHost.label };
    }
    if (state.selectedServerId) {
      return { label: state.selectedServerId };
    }
    return null;
  }, [selectedHost, state.selectedServerId]);
  const projectOptions = state.projectOptions;
  const handleSelectHost = useCallback(
    (nextServerId: string) => {
      model.setHost(nextServerId);
    },
    [model],
  );
  const handleSelectProject = useCallback(
    (optionId: string, display: ScheduleFormDisplay) => {
      model.setProject(optionId, display);
    },
    [model],
  );
  const handleSelectModel = useCallback(
    (provider: AgentProvider, modelId: string) => {
      model.setModel(provider, modelId);
    },
    [model],
  );
  const handleSelectMode = useCallback(
    (modeId: string) => {
      model.setSessionMode(modeId);
    },
    [model],
  );
  const handleSelectThinking = useCallback(
    (thinkingOptionId: string) => {
      model.setThinking(thinkingOptionId);
    },
    [model],
  );
  const handleModelOpen = useCallback(() => {
    providerSnapshot.refetchIfStale(state.selectedProvider);
  }, [providerSnapshot, state.selectedProvider]);
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => {
      void providerSnapshot.refresh([provider]);
    },
    [providerSnapshot],
  );
  const renderHostOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <HostOptionItem {...input} />,
    [],
  );
  const renderProjectOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <ProjectOptionItem {...input} />,
    [],
  );
  const renderThinkingOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => <ThinkingOptionItem {...input} />,
    [],
  );
  const modelTriggerLeading = useMemo(
    () => <ProviderGlyph provider={state.selectedProvider} />,
    [state.selectedProvider],
  );
  const renderModelTrigger = useCallback(
    ({
      selectedModelLabel,
      disabled,
      isOpen,
      hovered,
      pressed,
    }: {
      selectedModelLabel: string;
      onPress: () => void;
      disabled: boolean;
      isOpen: boolean;
      hovered: boolean;
      pressed: boolean;
    }): ReactNode => {
      const displayLabel = state.selectedModelDisplay?.label ?? selectedModelLabel;
      return (
        <SelectFieldTrigger
          label={displayLabel}
          isPlaceholder={!state.selectedModel}
          placeholder={displayLabel}
          leading={modelTriggerLeading}
          disabled={disabled}
          active={hovered || pressed || isOpen}
          size={controlSize}
          testID="schedule-model-trigger"
        />
      );
    },
    [controlSize, modelTriggerLeading, state.selectedModel, state.selectedModelDisplay],
  );

  if (state.targetKind === "agent") {
    return <ScheduleAgentTargetField label={agentTargetLabel} size={controlSize} />;
  }

  return (
    <>
      {state.mode === "create" ? (
        <ScheduleKindField model={model} state={state} controlSize={controlSize} />
      ) : null}

      {state.mode === "edit" || state.hosts.length > 1 ? (
        <SelectField
          label={t("schedule.form.host.label")}
          value={state.selectedServerId}
          selectedDisplay={selectedHostDisplay}
          options={hostOptions}
          onChange={handleSelectHost}
          placeholder={t("schedule.form.host.placeholder")}
          emptyText={t("schedule.form.host.empty")}
          disabled={state.mode === "edit"}
          searchable={false}
          title={t("schedule.form.host.label")}
          size={controlSize}
          triggerTestID="schedule-host-trigger"
          renderOption={renderHostOption}
        />
      ) : null}

      {state.disclosure.showProjectField ? (
        <SelectField
          label={t("schedule.form.project.label")}
          value={state.selectedProjectOptionId || null}
          selectedDisplay={state.projectDisplay}
          options={projectOptions}
          onChange={handleSelectProject}
          placeholder={t("schedule.form.project.placeholder")}
          emptyText={t("schedule.form.project.empty")}
          disabled={!state.selectedServerId}
          hint={!state.selectedServerId ? t("schedule.form.project.chooseHostFirst") : undefined}
          searchable
          searchPlaceholder={t("schedule.form.project.search")}
          title={t("schedule.form.project.placeholder")}
          size={controlSize}
          triggerTestID="schedule-project-trigger"
          renderOption={renderProjectOption}
        />
      ) : null}

      {state.targetKind === "command" ? (
        <ScheduleCommandFields model={model} state={state} controlSize={controlSize} />
      ) : null}

      {state.disclosure.showModelField ? (
        <AgentModelField
          label={t("schedule.form.model.label")}
          providers={state.modelSelectorProviders}
          selectedProvider={state.selectedProvider ?? ""}
          selectedModel={state.selectedModel}
          onSelect={handleSelectModel}
          isLoading={providerSnapshot.isLoading || providerSnapshot.isFetching}
          renderTrigger={renderModelTrigger}
          serverId={mutationServerId}
          disabled={!state.selectedServerId}
          onOpen={handleModelOpen}
          onRetryProvider={handleRetryProvider}
          isRetryingProvider={providerSnapshot.isRefreshing}
        />
      ) : null}

      {state.disclosure.showThinkingField ? (
        <AgentThinkingField
          options={state.availableThinkingOptions}
          value={state.selectedThinkingOptionId || null}
          selectedDisplay={state.selectedThinkingDisplay}
          onChange={handleSelectThinking}
          label={t("schedule.form.thinking.label")}
          placeholder={t("schedule.form.thinking.placeholder")}
          emptyText={t("schedule.form.thinking.empty")}
          size={controlSize}
          triggerTestID="schedule-thinking-trigger"
          renderOption={renderThinkingOption}
          getOptionTestId={buildThinkingOptionTestId}
        />
      ) : null}

      {state.disclosure.showModeField ? (
        <AgentModeField
          options={state.modeOptions}
          value={state.selectedMode || null}
          selectedDisplay={state.selectedModeDisplay}
          onChange={handleSelectMode}
          label={t("schedule.form.mode.label")}
          placeholder={t("schedule.form.mode.placeholder")}
          emptyText={t("schedule.form.mode.empty")}
          hint={state.modeOptions.length === 0 ? t("schedule.form.mode.unavailable") : undefined}
          size={controlSize}
          triggerTestID="schedule-mode-trigger"
          allowEmpty
        />
      ) : null}

      {state.disclosure.showIsolationField ? (
        <ScheduleIsolationField model={model} state={state} size={controlSize} />
      ) : null}

      {state.disclosure.showArchiveOnFinishField ? (
        <Field label={t("schedule.form.archiveOnFinish")}>
          <Switch
            value={state.archiveOnFinish}
            onValueChange={model.setArchiveOnFinish}
            accessibilityLabel={t("schedule.form.archiveOnFinish")}
            testID="schedule-archive-on-finish-switch"
          />
        </Field>
      ) : null}
    </>
  );
}

function ScheduleKindField({
  model,
  state,
  controlSize,
}: {
  model: ScheduleFormModel;
  state: ScheduleFormState;
  controlSize: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelectKind = useCallback(
    (kind: ScheduleFormTargetKind) => {
      model.setTargetKind(kind);
    },
    [model],
  );
  const kindOptions = useMemo<SegmentedControlOption<ScheduleFormTargetKind>[]>(
    () => [
      {
        value: "new-agent",
        label: t("schedule.target.newAgent"),
        testID: "schedule-kind-new-agent",
      },
      {
        value: "command",
        label: t("schedule.target.command"),
        disabled: !state.commandSchedulesSupported,
        testID: "schedule-kind-command",
      },
    ],
    [state.commandSchedulesSupported, t],
  );
  const commandKindHint =
    state.selectedServerId && !state.commandSchedulesSupported
      ? t("schedule.target.commandUnsupported")
      : undefined;

  return (
    <Field label={t("schedule.target.label")} hint={commandKindHint} testID="schedule-kind">
      <SegmentedControl
        options={kindOptions}
        value={state.targetKind === "command" ? "command" : "new-agent"}
        onValueChange={handleSelectKind}
        size={controlSize}
        testID="schedule-kind-control"
      />
    </Field>
  );
}

function ScheduleCommandFields({
  model,
  state,
  controlSize,
}: {
  model: ScheduleFormModel;
  state: ScheduleFormState;
  controlSize: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const handleAddEnvRow = useCallback(() => {
    model.addCommandEnvRow();
  }, [model]);

  return (
    <>
      <Field label={t("schedule.command.label")}>
        <FormTextInput
          size={controlSize}
          testID="schedule-command-input"
          accessibilityLabel={t("schedule.command.label")}
          initialValue={state.command}
          value={state.command}
          onChangeText={model.setCommand}
          placeholder={t("schedule.command.placeholder")}
          style={styles.multilineInput}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          numberOfLines={3}
          textAlignVertical="top"
        />
      </Field>

      <Field label={t("schedule.command.env.label")}>
        <View style={styles.envRows}>
          {state.commandEnvRows.map((row) => (
            <ScheduleCommandEnvRow key={row.id} model={model} row={row} controlSize={controlSize} />
          ))}
          <Pressable
            onPress={handleAddEnvRow}
            style={styles.envAddButton}
            accessibilityRole="button"
            accessibilityLabel={t("schedule.command.env.add")}
            testID="schedule-command-env-add"
          >
            <Plus size={14} color={styles.providerIcon.color} />
            <Text style={styles.envAddLabel}>{t("schedule.command.env.add")}</Text>
          </Pressable>
        </View>
      </Field>

      <Field label={t("schedule.command.timeout.label")}>
        <FormTextInput
          size={controlSize}
          testID="schedule-command-timeout-input"
          accessibilityLabel={t("schedule.command.timeout.label")}
          initialValue={state.commandTimeoutSeconds}
          value={state.commandTimeoutSeconds}
          onChangeText={model.setCommandTimeout}
          placeholder={t("schedule.command.timeout.placeholder")}
          keyboardType="number-pad"
        />
      </Field>
    </>
  );
}

function ScheduleCommandEnvRow({
  model,
  row,
  controlSize,
}: {
  model: ScheduleFormModel;
  row: { id: string; key: string; value: string };
  controlSize: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const handleKeyChange = useCallback(
    (value: string) => {
      model.setCommandEnvKey(row.id, value);
    },
    [model, row.id],
  );
  const handleValueChange = useCallback(
    (value: string) => {
      model.setCommandEnvValue(row.id, value);
    },
    [model, row.id],
  );
  const handleRemove = useCallback(() => {
    model.removeCommandEnvRow(row.id);
  }, [model, row.id]);

  return (
    <View style={styles.envRow}>
      <View style={styles.envInput}>
        <FormTextInput
          size={controlSize}
          testID={`schedule-command-env-key-${row.id}`}
          accessibilityLabel={t("schedule.command.env.keyPlaceholder")}
          initialValue={row.key}
          value={row.key}
          onChangeText={handleKeyChange}
          placeholder={t("schedule.command.env.keyPlaceholder")}
          autoCapitalize="characters"
          autoCorrect={false}
        />
      </View>
      <View style={styles.envInput}>
        <FormTextInput
          size={controlSize}
          testID={`schedule-command-env-value-${row.id}`}
          accessibilityLabel={t("schedule.command.env.valuePlaceholder")}
          initialValue={row.value}
          value={row.value}
          onChangeText={handleValueChange}
          placeholder={t("schedule.command.env.valuePlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>
      <Pressable
        onPress={handleRemove}
        style={styles.envRemoveButton}
        accessibilityRole="button"
        accessibilityLabel={t("schedule.command.env.remove")}
        testID={`schedule-command-env-remove-${row.id}`}
      >
        <X size={14} color={styles.providerIcon.color} />
      </Pressable>
    </View>
  );
}

function ScheduleIsolationField({
  model,
  state,
  size,
}: {
  model: ScheduleFormModel;
  state: ScheduleFormState;
  size: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const options = useMemo<SelectFieldOption<"local" | "worktree">[]>(
    () => [
      {
        id: "local",
        value: "local",
        label: t("schedule.form.isolation.local"),
        testID: "schedule-isolation-local",
      },
      {
        id: "worktree",
        value: "worktree",
        label: t("schedule.form.isolation.worktree"),
        testID: "schedule-isolation-worktree",
      },
    ],
    [t],
  );
  const selectedDisplay = useMemo<SelectFieldDisplay>(
    () => ({
      label:
        state.effectiveIsolation === "worktree"
          ? t("schedule.form.isolation.worktree")
          : t("schedule.form.isolation.local"),
    }),
    [state.effectiveIsolation, t],
  );
  const triggerLeading = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        {state.effectiveIsolation === "worktree" ? (
          <GitBranch size={16} color={styles.providerIcon.color} />
        ) : (
          <Folder size={16} color={styles.providerIcon.color} />
        )}
      </View>
    ),
    [state.effectiveIsolation],
  );
  const handleSelectIsolation = useCallback(
    (value: "local" | "worktree") => {
      model.setIsolation(value);
    },
    [model],
  );
  const renderIsolationOption = useCallback(
    (input: SelectFieldRenderOptionInput<"local" | "worktree">) => (
      <IsolationOptionItem {...input} />
    ),
    [],
  );

  return (
    <SelectField
      label={t("schedule.form.isolation.label")}
      value={state.effectiveIsolation}
      selectedDisplay={selectedDisplay}
      options={options}
      onChange={handleSelectIsolation}
      placeholder={t("schedule.form.isolation.placeholder")}
      emptyText={t("schedule.form.isolation.empty")}
      searchable={false}
      title={t("schedule.form.isolation.label")}
      size={size}
      testID="schedule-isolation"
      triggerTestID="schedule-isolation-trigger"
      triggerLeading={triggerLeading}
      renderOption={renderIsolationOption}
    />
  );
}

function ScheduleAgentTargetField({
  label,
  size,
}: {
  label: string | null;
  size: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const fieldStyle = useMemo(
    () => [styles.readonlyField, size === "sm" ? styles.readonlyFieldSm : styles.readonlyFieldMd],
    [size],
  );
  const textStyle = useMemo(
    () => [styles.readonlyText, size === "sm" ? styles.readonlyTextSm : styles.readonlyTextMd],
    [size],
  );

  return (
    <Field label={t("schedule.target.label")}>
      <View style={fieldStyle} testID="schedule-agent-target">
        <Text style={textStyle} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </Field>
  );
}

function IsolationOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<"local" | "worktree">): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        {option.value === "worktree" ? (
          <GitBranch size={16} color={styles.providerIcon.color} />
        ) : (
          <Folder size={16} color={styles.providerIcon.color} />
        )}
      </View>
    ),
    [option.value],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function HostOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(() => <HostStatusDotSlot serverId={option.value} />, [option.value]);

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ProjectOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        <Folder size={16} color={styles.providerIcon.color} />
      </View>
    ),
    [],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ThinkingOptionItem({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const leadingSlot = useMemo(
    () => (
      <View style={styles.optionIconBox}>
        <Brain size={16} color={styles.providerIcon.color} />
      </View>
    ),
    [],
  );

  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ProviderGlyph({ provider }: { provider: string | null }): ReactElement | null {
  if (!provider) {
    return null;
  }
  const Icon = getProviderIcon(provider);
  return <Icon size={16} color={styles.providerIcon.color} />;
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    multilineInput: {
      minHeight: 96,
    },
    readonlyField: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: theme.colors.surface2,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    readonlyFieldSm: {
      ...geometry.formTextInputSm,
    },
    readonlyFieldMd: {
      ...geometry.formTextInputMd,
    },
    readonlyText: {
      flex: 1,
      minWidth: 0,
      color: theme.colors.foreground,
    },
    readonlyTextSm: {
      fontSize: theme.fontSize.sm,
    },
    readonlyTextMd: {
      fontSize: theme.fontSize.base,
    },
    optionIconBox: {
      width: 18,
      height: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    envRows: {
      gap: theme.spacing[2],
    },
    envRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    envInput: {
      flex: 1,
      minWidth: 0,
    },
    envRemoveButton: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: theme.borderRadius.base,
    },
    envAddButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingVertical: theme.spacing[1],
    },
    envAddLabel: {
      color: theme.colors.foregroundMuted,
      fontSize: theme.fontSize.sm,
    },
    footer: {
      flex: 1,
      flexDirection: "row",
      gap: theme.spacing[3],
    },
    footerButton: {
      flex: 1,
    },
    submitError: {
      color: theme.colors.palette.red[300],
      fontSize: theme.fontSize.xs,
    },
    providerIcon: {
      color: theme.colors.foregroundMuted,
    },
  };
});
