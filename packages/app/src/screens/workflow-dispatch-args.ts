/**
 * Pure dispatch-form logic shared by the workflows-screen sheet and the
 * `workflow_draft` workspace tab. Kept free of React and react-native imports
 * so it stays directly unit-testable — `workflow-dispatch-form.ts` holds the
 * hook that wires this into component state.
 */

export function isPaseoInternalPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.includes("/.paseo/workflows") || normalized.includes("/.paseo/worktrees");
}

export interface WorkflowDispatchCwdSelection {
  cwd: string;
  /** Project name when the cwd maps to a known, non-internal project. */
  label: string | null;
}

/** Project entry the cwd resolution needs — a slice of ScheduleProjectTarget. */
interface WorkflowDispatchProjectTarget {
  cwd: string;
  projectName: string;
}

/**
 * Picks the cwd the form opens on: an explicit `initialCwd` (a workflow's own
 * repo, or the workspace root a draft tab dispatches from) wins, otherwise the
 * first project that is not Paseo's internal storage. Returns null when there
 * is nothing sensible to preselect, which leaves the picker empty.
 */
export function resolveInitialDispatchCwd(input: {
  initialCwd: string | null;
  projectTargets: readonly WorkflowDispatchProjectTarget[];
}): WorkflowDispatchCwdSelection | null {
  const { initialCwd, projectTargets } = input;
  if (initialCwd) {
    const match = projectTargets.find((target) => target.cwd === initialCwd);
    return {
      cwd: initialCwd,
      label: match && !isPaseoInternalPath(initialCwd) ? match.projectName : null,
    };
  }
  const preferred =
    projectTargets.find((target) => !isPaseoInternalPath(target.cwd)) ?? projectTargets[0];
  if (!preferred) {
    return null;
  }
  return {
    cwd: preferred.cwd,
    label: isPaseoInternalPath(preferred.cwd) ? null : preferred.projectName,
  };
}

/**
 * Packs task + agent selection into the run `args` the engine reads. Blank
 * optional fields are omitted rather than sent empty, and `fast_mode` is
 * mirrored to the top-level `fast` flag the backend reads.
 */
export function buildWorkflowDispatchArgs(input: {
  task: string;
  provider: string | null;
  model: string;
  effort: string;
  mode: string;
  featureValues: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  const args: Record<string, unknown> = {
    task: input.task.trim(),
    provider: input.provider,
  };
  if (input.model.trim()) {
    args.model = input.model.trim();
  }
  if (input.effort.trim()) {
    args.effort = input.effort.trim();
  }
  if (input.mode.trim()) {
    args.mode = input.mode.trim();
  }
  if (input.featureValues) {
    args.featureValues = input.featureValues;
    if (typeof input.featureValues.fast_mode === "boolean") {
      args.fast = input.featureValues.fast_mode;
    }
  }
  return args;
}
