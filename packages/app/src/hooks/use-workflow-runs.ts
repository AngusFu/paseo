import type { WorkflowRun } from "@getpaseo/protocol/workflow/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";

export const workflowRunsQueryBaseKey = ["workflow", "runs"] as const;
const EMPTY_RUNS: WorkflowRun[] = [];
const ACTIVE_POLL_MS = 10_000;
const IDLE_POLL_MS = 30_000;

function hasLiveRun(runs: WorkflowRun[] | undefined): boolean {
  return Boolean(runs?.some((run) => run.status === "queued" || run.status === "running"));
}

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
    // Poll faster while a run is queued/active, back off once the list is idle.
    refetchInterval: (current) =>
      hasLiveRun(current.state.data as WorkflowRun[] | undefined) ? ACTIVE_POLL_MS : IDLE_POLL_MS,
  });
  return {
    runs: query.data ?? EMPTY_RUNS,
    isLoading: enabled && query.isPending,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}
