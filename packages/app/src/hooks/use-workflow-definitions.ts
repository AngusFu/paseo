import type { WorkflowDefinition } from "@getpaseo/protocol/workflow/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";

export const workflowDefinitionsQueryBaseKey = ["workflow", "definitions"] as const;
const EMPTY_DEFINITIONS: WorkflowDefinition[] = [];

export function useWorkflowDefinitions(serverId: string | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const enabled = Boolean(serverId && client && connectionStatus === "online");
  const query = useFetchQuery({
    queryKey: [...workflowDefinitionsQueryBaseKey, serverId ?? "none", connectionStatus],
    enabled,
    queryFn: async () => {
      if (!client) throw new Error("Workflow host client unavailable");
      const payload = await client.workflowDefinitionList();
      if (payload.error) throw new Error(payload.error);
      return payload.value as WorkflowDefinition[];
    },
    dataShape: "list",
    staleTimeMs: 5_000,
  });
  return {
    definitions: query.data ?? EMPTY_DEFINITIONS,
    isLoading: enabled && query.isPending,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}

export interface ProjectWorkflowDefinition extends WorkflowDefinition {
  /** Repo root the definition was read from (the list-request cwd). */
  projectCwd: string;
}

const EMPTY_PROJECT_DEFINITIONS: ProjectWorkflowDefinition[] = [];

/**
 * Read-through project definitions (`.paseo/workflows` + `.claude/workflows`)
 * for a set of project roots. One list RPC per cwd, sequential — project
 * counts are small. Requires server_info.features.projectWorkflows (gate with
 * useHostFeature before enabling); a daemon without it just never returns
 * `origin: "project"` entries, so this degrades to empty.
 */
export function useProjectWorkflowDefinitions(serverId: string | null, cwds: readonly string[]) {
  const client = useHostRuntimeClient(serverId ?? "");
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const enabled = Boolean(serverId && client && connectionStatus === "online" && cwds.length > 0);
  const query = useFetchQuery({
    queryKey: [
      ...workflowDefinitionsQueryBaseKey,
      "project",
      serverId ?? "none",
      connectionStatus,
      cwds.join("|"),
    ],
    enabled,
    queryFn: async () => {
      if (!client) throw new Error("Workflow host client unavailable");
      const definitions: ProjectWorkflowDefinition[] = [];
      for (const cwd of cwds) {
        try {
          const payload = await client.workflowDefinitionList(undefined, { cwd });
          if (payload.error) continue; // one unreadable project must not sink the rest
          for (const definition of payload.value as WorkflowDefinition[]) {
            if (definition.origin === "project") {
              definitions.push({ ...definition, projectCwd: cwd });
            }
          }
        } catch {
          /* per-project failure — skip */
        }
      }
      return definitions;
    },
    dataShape: "list",
    staleTimeMs: 5_000,
  });
  return {
    definitions: query.data ?? EMPTY_PROJECT_DEFINITIONS,
    isLoading: enabled && query.isPending,
  };
}

export function useBuiltinWorkflowDefinitions(serverId: string | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const enabled = Boolean(serverId && client && connectionStatus === "online");
  const query = useFetchQuery({
    queryKey: ["workflow", "builtins", serverId ?? "none", connectionStatus],
    enabled,
    queryFn: async () => {
      if (!client) throw new Error("Workflow host client unavailable");
      const payload = await client.workflowDefinitionListBuiltins();
      if (payload.error) throw new Error(payload.error);
      return payload.value as WorkflowDefinition[];
    },
    dataShape: "list",
    staleTimeMs: 30_000,
  });
  return { definitions: query.data ?? EMPTY_DEFINITIONS, isLoading: enabled && query.isPending };
}
