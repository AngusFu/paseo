/**
 * Shared state for the two workflow dispatch surfaces: the sheet on the
 * workflows screen and the `workflow_draft` workspace tab. Both need the same
 * provider/model/effort/mode resolution, the same cwd picker plumbing and the
 * same `args` packing, so the state lives here instead of being duplicated.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentProvider, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { collectAgentFeatureValues } from "@/components/agent-launch-fields";
import { mergeCreateAgentSelectionPreferences } from "@/create-agent-preferences/preferences";
import { useDraftAgentFeatures } from "@/hooks/use-draft-agent-features";
import { useFormPreferences, type FormPreferences } from "@/hooks/use-form-preferences";
import { useProjects } from "@/hooks/use-projects";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import {
  resolveDefaultModelId,
  resolvePreferredAgentModeId,
} from "@/provider-selection/resolve-agent-form";
import { buildScheduleProjectTargets } from "@/schedules/schedule-project-targets";
import { buildProviderDefinitions } from "@/utils/provider-definitions";

export function isPaseoInternalPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.includes("/.paseo/workflows") || normalized.includes("/.paseo/worktrees");
}

export function resolveAuthoringProviderDefault(
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

export interface WorkflowDispatchFormDirectoryShortcut {
  id: string;
  label: string;
  path: string;
}

export function useWorkflowDispatchForm(input: {
  serverId: string | null;
  /** Preselected run cwd (e.g. the repo root the run should execute in). */
  initialCwd?: string | null;
}) {
  const { serverId, initialCwd = null } = input;
  const { preferences, updatePreferences } = useFormPreferences();
  const { projects } = useProjects();
  const [task, setTask] = useState("");
  const [cwd, setCwd] = useState<string | null>(null);
  const [cwdLabel, setCwdLabel] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedEffort, setSelectedEffort] = useState("");
  const [selectedMode, setSelectedMode] = useState("");

  const snapshot = useProvidersSnapshot(serverId, { enabled: Boolean(serverId) });
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
  const selectedModelDef = useMemo(
    () => availableModels.find((model) => model.id === selectedModel) ?? null,
    [availableModels, selectedModel],
  );
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
  const features = useDraftAgentFeatures({
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

  const directoryShortcuts = useMemo<WorkflowDispatchFormDirectoryShortcut[]>(
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

  const setProviderAndModel = useCallback((provider: AgentProvider, modelId: string) => {
    setSelectedProvider(provider);
    setSelectedModel(modelId);
  }, []);

  const selectCwd = useCallback(
    (path: string) => {
      const match = projectTargets.find((target) => target.cwd === path);
      setCwd(path);
      setCwdLabel(match && !isPaseoInternalPath(path) ? match.projectName : null);
    },
    [projectTargets],
  );

  const featureList = features.features;
  /** Packs task + agent selection into the run `args` the engine reads. */
  const buildArgs = useCallback((): Record<string, unknown> => {
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
    const featureValues = collectAgentFeatureValues(featureList);
    if (featureValues) {
      args.featureValues = featureValues;
      if (typeof featureValues.fast_mode === "boolean") {
        args.fast = featureValues.fast_mode;
      }
    }
    return args;
  }, [featureList, selectedEffort, selectedMode, selectedModel, selectedProvider, task]);

  /**
   * Remember this selection — the form used to reopen on the first provider's
   * default model because nothing ever wrote back.
   */
  const rememberSelection = useCallback(() => {
    void updatePreferences((current) =>
      mergeCreateAgentSelectionPreferences({
        preferences: current,
        provider: selectedProvider,
        modelId: selectedModel,
        modeId: selectedMode,
        thinkingOptionId: selectedEffort,
      }),
    );
  }, [selectedEffort, selectedMode, selectedModel, selectedProvider, updatePreferences]);

  return {
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
    setProviderAndModel,
    snapshot,
    providerDefinitions,
    modelSelectorProviders,
    availableModels,
    thinkingOptions,
    modeOptions,
    features,
    directoryShortcuts,
    isReady: Boolean(task.trim() && cwd?.trim() && selectedProvider),
    buildArgs,
    rememberSelection,
  };
}
