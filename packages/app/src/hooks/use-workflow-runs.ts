import type { WorkflowRun } from "@getpaseo/protocol/workflow/types";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";

export const workflowRunsQueryBaseKey = ["workflow", "runs"] as const;
const EMPTY_RUNS: WorkflowRun[] = [];
const ACTIVE_POLL_MS = 10_000;
const IDLE_POLL_MS = 30_000;
const RUNS_PAGE_LIMIT = 50;

interface WorkflowRunsPage {
  runs: WorkflowRun[];
  pageInfo?: { nextCursor: string | null; hasMore: boolean };
}

function hasLiveRun(runs: WorkflowRun[] | undefined): boolean {
  return Boolean(runs?.some((run) => run.status === "queued" || run.status === "running"));
}

export function useWorkflowRuns(serverId: string | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const enabled = Boolean(serverId && client && connectionStatus === "online");

  const query = useInfiniteQuery<
    WorkflowRunsPage,
    Error,
    { pages: WorkflowRunsPage[] },
    readonly unknown[],
    string | null
  >({
    queryKey: [...workflowRunsQueryBaseKey, serverId ?? "none", connectionStatus],
    enabled,
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo?.hasMore && lastPage.pageInfo.nextCursor
        ? lastPage.pageInfo.nextCursor
        : null,
    queryFn: async ({ pageParam }) => {
      if (!client) throw new Error("Workflow host client unavailable");
      const payload = await client.workflowRunList({
        limit: RUNS_PAGE_LIMIT,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
      if (payload.error) throw new Error(payload.error);
      return {
        runs: (payload.value ?? []) as WorkflowRun[],
        pageInfo: payload.pageInfo,
      };
    },
    staleTime: 5_000,
    refetchInterval: (current) => {
      const runs = current.state.data?.pages.flatMap((page) => page.runs);
      return hasLiveRun(runs) ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    },
  });

  const runs = query.data?.pages.flatMap((page) => page.runs) ?? EMPTY_RUNS;
  const loadMore = useCallback(() => {
    if (!query.hasNextPage || query.isFetchingNextPage) {
      return;
    }
    void query.fetchNextPage();
  }, [query]);

  return {
    runs,
    isLoading: enabled && query.isPending,
    isError: query.isError,
    refetch: () => void query.refetch(),
    hasMore: query.hasNextPage ?? false,
    isLoadingMore: query.isFetchingNextPage,
    loadMore,
  };
}
