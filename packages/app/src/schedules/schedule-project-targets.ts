import type { ProjectSummary } from "@/utils/projects";
import { shortenPath } from "@/utils/shorten-path";

export const PROJECT_OPTION_PREFIX = "project:";

export interface ScheduleProjectTarget {
  optionId: string;
  serverId: string;
  serverName: string;
  projectKey: string;
  projectName: string;
  cwd: string;
  isGit: boolean;
  /** Whether this project actually lives at `cwd` — see ProjectHostEntry. */
  ownsRepoRoot: boolean;
}

export function buildProjectOptionId(serverId: string, projectKey: string): string {
  return `${PROJECT_OPTION_PREFIX}${serverId}:${projectKey}`;
}

/**
 * The project roots the schedule form can target: one per online host of each
 * project, keyed by (serverId, cwd). The schedules list reuses this set to name
 * a schedule's stored cwd; the two surfaces must agree on what "a project" is.
 */
export function buildScheduleProjectTargets(
  projects: readonly ProjectSummary[],
): ScheduleProjectTarget[] {
  const targets: ScheduleProjectTarget[] = [];
  for (const project of projects) {
    for (const host of project.hosts) {
      const cwd = host.repoRoot.trim();
      if (!host.isOnline || !cwd) {
        continue;
      }
      targets.push({
        optionId: buildProjectOptionId(host.serverId, project.projectKey),
        serverId: host.serverId,
        serverName: host.serverName,
        projectKey: project.projectKey,
        projectName: project.projectName,
        cwd,
        isGit: Boolean(host.gitRuntime),
        ownsRepoRoot: host.ownsRepoRoot,
      });
    }
  }
  return targets;
}

function projectNameKey(serverId: string, cwd: string): string {
  return `${serverId}:${cwd.trim()}`;
}

/**
 * Map (serverId, cwd) -> project name for naming a schedule's stored cwd.
 *
 * More than one project can claim a path: a project made of Paseo worktrees
 * reports the repo root it was branched from, which is the root another project
 * actually sits at. A schedule stores only the cwd, so the name has to be
 * chosen here — and it goes to the project that is really there. Letting the
 * last one win labelled a schedule with the name of a worktree project that
 * merely pointed at the same root.
 */
export function buildProjectNameByCwd(
  targets: readonly ScheduleProjectTarget[],
): Map<string, string> {
  const byCwd = new Map<string, string>();
  const claimedByOwner = new Set<string>();
  for (const target of targets) {
    const key = projectNameKey(target.serverId, target.cwd);
    if (claimedByOwner.has(key)) {
      continue;
    }
    if (target.ownsRepoRoot) {
      claimedByOwner.add(key);
    } else if (byCwd.has(key)) {
      // Keep the first borrower until an owner turns up.
      continue;
    }
    byCwd.set(key, target.projectName);
  }
  return byCwd;
}

/**
 * Name a stored cwd for display: the matching project name when the client
 * knows this root on this host, otherwise the shortened path itself. Never
 * blank, never a claim the client cannot back up.
 */
export function describeScheduleCwd(input: {
  serverId: string;
  cwd: string;
  projectNameByCwd: ReadonlyMap<string, string>;
}): string {
  return (
    input.projectNameByCwd.get(projectNameKey(input.serverId, input.cwd)) ?? shortenPath(input.cwd)
  );
}
