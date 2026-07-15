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
