import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ScheduleRun } from "@getpaseo/protocol/schedule/types";
import { useSessionStore } from "@/stores/session-store";

export const scheduleLogsQueryBaseKey = ["schedule-logs"] as const;
const LOGS_PAGE_LIMIT = 50;

interface ScheduleLogsPage {
  runs: ScheduleRun[];
  pageInfo?: { nextCursor: string | null; hasMore: boolean };
}

export interface UseScheduleLogsResult {
  runs: ScheduleRun[];
  isLoading: boolean;
  isRefetching: boolean;
  isError: boolean;
  refetch: () => void;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => void;
}

// Fetches a single schedule's run history (status, timing, captured output) from
// its host. Only enabled while the logs modal is open — the list screen never
// carries run data (ScheduleSummary omits `runs`). Runs come back newest-first
// when paginated; unpaged legacy daemons return oldest-first and the modal
// reverses for display.
export function useScheduleLogs({
  serverId,
  scheduleId,
  enabled,
}: {
  serverId: string | null;
  scheduleId: string | null;
  enabled: boolean;
}): UseScheduleLogsResult {
  const { t } = useTranslation();
  const isEnabled = enabled && Boolean(serverId) && Boolean(scheduleId);

  const query = useInfiniteQuery<
    ScheduleLogsPage,
    Error,
    { pages: ScheduleLogsPage[] },
    readonly unknown[],
    string | null
  >({
    queryKey: [...scheduleLogsQueryBaseKey, serverId, scheduleId],
    enabled: isEnabled,
    staleTime: 0,
    retry: false,
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.pageInfo?.hasMore && lastPage.pageInfo.nextCursor
        ? lastPage.pageInfo.nextCursor
        : null,
    queryFn: async ({ pageParam }) => {
      const client = useSessionStore.getState().sessions[serverId ?? ""]?.client ?? null;
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.scheduleLogs({
        id: scheduleId ?? "",
        limit: LOGS_PAGE_LIMIT,
        ...(pageParam ? { cursor: pageParam } : {}),
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return {
        runs: payload.runs,
        pageInfo: payload.pageInfo,
      };
    },
  });

  const runs = query.data?.pages.flatMap((page) => page.runs) ?? [];
  const loadMore = useCallback(() => {
    if (!query.hasNextPage || query.isFetchingNextPage) {
      return;
    }
    void query.fetchNextPage();
  }, [query]);

  return {
    runs,
    isLoading: query.isLoading,
    isRefetching: query.isFetching && !query.isLoading,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
    hasMore: query.hasNextPage ?? false,
    isLoadingMore: query.isFetchingNextPage,
    loadMore,
  };
}
