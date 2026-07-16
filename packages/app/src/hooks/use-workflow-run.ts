import type { WorkflowRun } from "@getpaseo/protocol/workflow/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";

export const workflowRunQueryBaseKey = ["workflow", "run"] as const;

function isLiveRun(run: WorkflowRun | null | undefined): boolean {
  return run?.status === "queued" || run?.status === "running";
}

export function useWorkflowRun(
  serverId: string | null,
  runId: string | null,
  options?: { initial?: WorkflowRun | null },
) {
  const client = useHostRuntimeClient(serverId ?? "");
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const enabled = Boolean(serverId && runId && client && connectionStatus === "online");
  const runQuery = useFetchQuery({
    queryKey: [...workflowRunQueryBaseKey, serverId ?? "none", runId ?? "none", connectionStatus],
    enabled,
    queryFn: async () => {
      if (!client || !runId) throw new Error("Workflow run unavailable");
      const payload = await client.workflowRunGet(runId);
      if (payload.error) throw new Error(payload.error);
      return payload.value as WorkflowRun | null;
    },
    dataShape: "value",
    staleTimeMs: 1_000,
    // Keep polling while the run is in-flight; stop once it reaches a terminal status.
    refetchInterval: (current) => {
      const run = (current.state.data as WorkflowRun | null | undefined) ?? options?.initial;
      return isLiveRun(run) ? 1_000 : false;
    },
  });
  const run = runQuery.data ?? options?.initial ?? null;
  return {
    run,
    live: isLiveRun(run),
    isLoading: enabled && runQuery.isPending,
    isError: runQuery.isError,
    refetch: () => void runQuery.refetch(),
  };
}
