import type { ScheduleProjectTarget } from "@/schedules/schedule-project-targets";

export interface WorkflowProjectRoots {
  /** Each repo root once, in the order the projects were listed. */
  cwds: string[];
  /** Repo root -> the name of the first project that claimed it. */
  nameByCwd: Map<string, string>;
}

/**
 * Collapses the project list down to the repo roots the workflows screen should
 * read.
 *
 * Several projects can point at one root: a worktree and the checkout it was
 * branched from are separate projects over the same files, and both report the
 * same `repoRoot`. Reading a root once per project listed the same definitions
 * as many times as there were projects, all under a single heading, since the
 * screen groups by root.
 *
 * The first project to claim a root also names the section. Letting later ones
 * overwrite it meant a worktree could end up labelling its parent's workflows.
 */
export function resolveWorkflowProjectRoots(
  targets: readonly ScheduleProjectTarget[],
): WorkflowProjectRoots {
  const cwds: string[] = [];
  const nameByCwd = new Map<string, string>();
  for (const target of targets) {
    if (nameByCwd.has(target.cwd)) {
      continue;
    }
    nameByCwd.set(target.cwd, target.projectName);
    cwds.push(target.cwd);
  }
  return { cwds, nameByCwd };
}
