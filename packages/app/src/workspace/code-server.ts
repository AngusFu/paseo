import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import {
  type DesktopCodeServerBridge,
  type DesktopCodeServerStatus,
  getDesktopHost,
} from "@/desktop/host";
import { openExternalUrl } from "@/utils/open-external-url";

interface AvailableCodeServerBridge {
  getStatus: NonNullable<DesktopCodeServerBridge["getStatus"]>;
  start: NonNullable<DesktopCodeServerBridge["start"]>;
  stop: NonNullable<DesktopCodeServerBridge["stop"]>;
}

function getCodeServerBridge(): AvailableCodeServerBridge | null {
  const bridge = getDesktopHost()?.codeServer;
  if (!bridge?.getStatus || !bridge.start || !bridge.stop) {
    return null;
  }
  return { getStatus: bridge.getStatus, start: bridge.start, stop: bridge.stop };
}

export function hasCodeServerBridge(): boolean {
  return getCodeServerBridge() !== null;
}

function requireCodeServerBridge(): AvailableCodeServerBridge {
  const bridge = getCodeServerBridge();
  if (!bridge) {
    throw new Error("code-server bridge is unavailable");
  }
  return bridge;
}

function buildCodeServerFolderUrl(baseUrl: string, cwd: string): string {
  return `${baseUrl}/?folder=${encodeURIComponent(cwd)}`;
}

const CODE_SERVER_STATUS_QUERY_KEY = ["code-server-status"];

export function useCodeServer(input: { isLocalExecution: boolean }) {
  const isAvailable = hasCodeServerBridge() && input.isLocalExecution;
  const queryClient = useQueryClient();

  const statusQuery = useFetchQuery<DesktopCodeServerStatus>({
    queryKey: CODE_SERVER_STATUS_QUERY_KEY,
    dataShape: "value",
    staleTimeMs: 5_000,
    enabled: isAvailable,
    // Poll so the toggle reflects the process dying (or being started/stopped
    // outside the app) without an event channel.
    refetchInterval: 10_000,
    retry: false,
    queryFn: () => requireCodeServerBridge().getStatus(),
  });

  const setStatus = useCallback(
    (status: DesktopCodeServerStatus) => {
      queryClient.setQueryData(CODE_SERVER_STATUS_QUERY_KEY, status);
    },
    [queryClient],
  );

  const toggleMutation = useMutation({
    mutationFn: async (): Promise<DesktopCodeServerStatus> => {
      const bridge = requireCodeServerBridge();
      const current = await bridge.getStatus();
      return current.running ? bridge.stop() : bridge.start();
    },
    onSuccess: setStatus,
  });

  const openWorkspace = useCallback(
    async (cwd: string): Promise<void> => {
      const bridge = requireCodeServerBridge();
      let status = await bridge.getStatus();
      if (!status.running) {
        status = await bridge.start();
      }
      setStatus(status);
      await openExternalUrl(buildCodeServerFolderUrl(status.url, cwd));
    },
    [setStatus],
  );

  return {
    isAvailable,
    isRunning: statusQuery.data?.running ?? false,
    isToggling: toggleMutation.isPending,
    toggle: toggleMutation.mutate,
    openWorkspace,
  };
}
