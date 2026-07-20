/**
 * Workflow definitions offered inside a workspace: the ones checked into the
 * workspace's own repo root first, then the host's stored definitions and the
 * built-in templates. Feeds both the new-tab menu and the workflow draft tab.
 */
import { useMemo } from "react";
import type { WorkflowDefinition } from "@getpaseo/protocol/workflow/types";
import {
  useBuiltinWorkflowDefinitions,
  useProjectWorkflowDefinitions,
  useWorkflowDefinitions,
} from "@/hooks/use-workflow-definitions";
import { useHostFeature } from "@/runtime/host-features";

const EMPTY_CWDS: string[] = [];

export function useWorkspaceWorkflowDefinitions(input: {
  serverId: string | null;
  /** Repo root of the workspace — project definitions are read from here. */
  cwd: string | null;
  enabled?: boolean;
}): { definitions: WorkflowDefinition[]; isLoading: boolean } {
  const { serverId, cwd, enabled = true } = input;
  const supported = useHostFeature(serverId, "workflow");
  const projectsSupported = useHostFeature(serverId, "projectWorkflows");
  const active = Boolean(enabled && serverId && supported);
  const projectCwds = useMemo(() => (cwd ? [cwd] : EMPTY_CWDS), [cwd]);
  const project = useProjectWorkflowDefinitions(
    active && projectsSupported ? serverId : null,
    projectCwds,
  );
  const stored = useWorkflowDefinitions(active ? serverId : null);
  const builtins = useBuiltinWorkflowDefinitions(active ? serverId : null);

  const definitions = useMemo(
    () => [...project.definitions, ...stored.definitions, ...builtins.definitions],
    [builtins.definitions, project.definitions, stored.definitions],
  );

  return {
    definitions,
    isLoading: project.isLoading || stored.isLoading || builtins.isLoading,
  };
}
