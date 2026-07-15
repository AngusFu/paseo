import type { WorkflowRun } from "@getpaseo/protocol/workflow/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";

export const workflowRunsQueryBaseKey = ["workflow", "runs"] as const;
const EMPTY_RUNS: WorkflowRun[] = [];

export function useWorkflowRuns(serverId: string | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const enabled = Boolean(serverId && client && connectionStatus === "online");
  const query = useFetchQuery({
    queryKey: [...workflowRunsQueryBaseKey, serverId ?? "none", connectionStatus],
    enabled,
    queryFn: async () => {
      if (!client) throw new Error("Workflow host client unavailable");
      const payload = await client.workflowRunList();
      if (payload.error) throw new Error(payload.error);
      return payload.value as WorkflowRun[];
    },
    dataShape: "list",
    staleTimeMs: 5_000,
    refetchInterval: 10_000,
  });
  return {
    runs: query.data ?? EMPTY_RUNS,
    isLoading: enabled && query.isPending,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}
