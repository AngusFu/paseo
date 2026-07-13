import { useTranslation } from "react-i18next";
import type { ScheduleRun } from "@getpaseo/protocol/schedule/types";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";

export const scheduleLogsQueryBaseKey = ["schedule-logs"] as const;

export interface UseScheduleLogsResult {
  runs: ScheduleRun[];
  isLoading: boolean;
  isRefetching: boolean;
  isError: boolean;
  refetch: () => void;
}

// Fetches a single schedule's run history (status, timing, captured output) from
// its host. Only enabled while the logs modal is open — the list screen never
// carries run data (ScheduleSummary omits `runs`). Runs come back newest-last
// from the daemon; the modal reverses for display.
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

  const query = useFetchQuery<ScheduleRun[]>({
    queryKey: [...scheduleLogsQueryBaseKey, serverId, scheduleId],
    dataShape: "list",
    staleTimeMs: 0,
    enabled: isEnabled,
    retry: false,
    queryFn: async () => {
      const client = useSessionStore.getState().sessions[serverId ?? ""]?.client ?? null;
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.scheduleLogs({ id: scheduleId ?? "" });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.runs;
    },
  });

  return {
    runs: query.data ?? [],
    isLoading: query.isLoading,
    isRefetching: query.isFetching && !query.isLoading,
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
  };
}
