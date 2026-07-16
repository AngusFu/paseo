import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkflowLogEntry } from "@getpaseo/protocol/workflow/types";
import { useHostRuntimeClient, useHostRuntimeConnectionStatuses } from "@/runtime/host-runtime";

export const workflowRunLogsQueryBaseKey = ["workflow", "run-logs"] as const;

const PAGE_LIMIT = 200;
/** Cap auto-drain so a huge finished run still leaves room for "Load more". */
const MAX_AUTO_PAGES = 50;
const LIVE_POLL_MS = 1_000;

interface LogsPage {
  entries: WorkflowLogEntry[];
  nextSeq: number;
  hasMore: boolean;
}

const EMPTY_LOGS: WorkflowLogEntry[] = [];

function mergeEntries(
  current: WorkflowLogEntry[],
  incoming: WorkflowLogEntry[],
): WorkflowLogEntry[] {
  if (incoming.length === 0) return current;
  if (current.length === 0) return incoming;
  const seen = new Set(current.map((entry) => entry.seq));
  const appended = incoming.filter((entry) => !seen.has(entry.seq));
  if (appended.length === 0) return current;
  return [...current, ...appended];
}

export function useWorkflowRunLogs(
  serverId: string | null,
  runId: string | null,
  options?: { live?: boolean },
) {
  const client = useHostRuntimeClient(serverId ?? "");
  const statuses = useHostRuntimeConnectionStatuses(serverId ? [serverId] : []);
  const connectionStatus = serverId ? (statuses.get(serverId) ?? "connecting") : "disconnected";
  const enabled = Boolean(serverId && runId && client && connectionStatus === "online");
  const live = Boolean(options?.live);

  const [entries, setEntries] = useState<WorkflowLogEntry[]>(EMPTY_LOGS);
  const [nextSeq, setNextSeq] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [isError, setIsError] = useState(false);

  const nextSeqRef = useRef(0);
  const hasMoreRef = useRef(false);
  const busyRef = useRef(false);
  const generationRef = useRef(0);

  const fetchPage = useCallback(
    async (afterSeq: number): Promise<LogsPage | null> => {
      if (!client || !runId) return null;
      const payload = await client.workflowRunLogs(runId, {
        afterSeq,
        limit: PAGE_LIMIT,
      });
      if (payload.error) throw new Error(payload.error);
      const value = payload.value as LogsPage;
      return {
        entries: value.entries ?? [],
        nextSeq: typeof value.nextSeq === "number" ? value.nextSeq : afterSeq,
        hasMore: Boolean(value.hasMore),
      };
    },
    [client, runId],
  );

  const applyPage = useCallback((page: LogsPage) => {
    nextSeqRef.current = page.nextSeq;
    hasMoreRef.current = page.hasMore;
    setNextSeq(page.nextSeq);
    setHasMore(page.hasMore);
    setEntries((current) => mergeEntries(current, page.entries));
  }, []);

  const pull = useCallback(
    async (generation: number, maxPages: number) => {
      if (busyRef.current || generationRef.current !== generation) return;
      busyRef.current = true;
      setIsFetchingMore(true);
      setIsError(false);
      try {
        let pages = 0;
        do {
          if (generationRef.current !== generation) return;
          const page = await fetchPage(nextSeqRef.current);
          if (!page || generationRef.current !== generation) return;
          applyPage(page);
          pages += 1;
          if (page.entries.length === 0) break;
        } while (hasMoreRef.current && pages < maxPages);
      } catch {
        if (generationRef.current === generation) setIsError(true);
      } finally {
        busyRef.current = false;
        if (generationRef.current === generation) {
          setIsFetchingMore(false);
        }
      }
    },
    [applyPage, fetchPage],
  );

  const loadMore = useCallback(() => {
    if (!enabled || !hasMoreRef.current) return;
    void pull(generationRef.current, 1);
  }, [enabled, pull]);

  useEffect(() => {
    if (!enabled || !runId) {
      generationRef.current += 1;
      nextSeqRef.current = 0;
      hasMoreRef.current = false;
      busyRef.current = false;
      setEntries(EMPTY_LOGS);
      setNextSeq(0);
      setHasMore(false);
      setIsLoading(false);
      setIsFetchingMore(false);
      setIsError(false);
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    nextSeqRef.current = 0;
    hasMoreRef.current = false;
    busyRef.current = false;
    setEntries(EMPTY_LOGS);
    setNextSeq(0);
    setHasMore(false);
    setIsLoading(true);
    setIsFetchingMore(false);
    setIsError(false);

    let cancelled = false;
    void (async () => {
      await pull(generation, MAX_AUTO_PAGES);
      if (!cancelled && generationRef.current === generation) {
        setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, pull, runId]);

  // Live tail: poll for new pages after the first drain settles.
  useEffect(() => {
    if (!enabled || !live || !runId || isLoading) return;
    const timer = setInterval(() => {
      void pull(generationRef.current, MAX_AUTO_PAGES);
    }, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, isLoading, live, pull, runId]);

  // When a live run finishes, finish draining any remaining pages.
  useEffect(() => {
    if (!enabled || live || isLoading || !hasMore) return;
    void pull(generationRef.current, MAX_AUTO_PAGES);
  }, [enabled, hasMore, isLoading, live, pull]);

  return {
    entries,
    nextSeq,
    hasMore,
    isLoading: enabled && isLoading,
    isFetchingMore,
    isError,
    loadMore,
  };
}
