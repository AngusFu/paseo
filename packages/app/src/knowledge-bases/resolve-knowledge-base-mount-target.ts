import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

/**
 * Pick a same-host workspace for detail → mounts-sheet deep-link.
 * Prefer the active workspace, then the last-remembered workspace.
 */
export function resolveKnowledgeBaseMountTarget(input: {
  detailServerId: string;
  active: ActiveWorkspaceSelection | null;
  last: ActiveWorkspaceSelection | null;
}): ActiveWorkspaceSelection | null {
  const detailServerId = input.detailServerId.trim();
  if (!detailServerId) {
    return null;
  }
  if (input.active?.serverId === detailServerId && input.active.workspaceId.trim()) {
    return input.active;
  }
  if (input.last?.serverId === detailServerId && input.last.workspaceId.trim()) {
    return input.last;
  }
  return null;
}
