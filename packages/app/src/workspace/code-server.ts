import { useCallback } from "react";
import { useFetchQuery } from "@/data/query";
import {
  type DesktopCodeServerBridge,
  type DesktopCodeServerStatus,
  getDesktopHost,
} from "@/desktop/host";

interface AvailableCodeServerBridge {
  getStatus: NonNullable<DesktopCodeServerBridge["getStatus"]>;
  start: NonNullable<DesktopCodeServerBridge["start"]>;
  stop: NonNullable<DesktopCodeServerBridge["stop"]>;
  openWindow: NonNullable<DesktopCodeServerBridge["openWindow"]>;
}

function getCodeServerBridge(): AvailableCodeServerBridge | null {
  const bridge = getDesktopHost()?.codeServer;
  if (!bridge?.getStatus || !bridge.start || !bridge.stop || !bridge.openWindow) {
    return null;
  }
  return {
    getStatus: bridge.getStatus,
    start: bridge.start,
    stop: bridge.stop,
    openWindow: bridge.openWindow,
  };
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

  const statusQuery = useFetchQuery<DesktopCodeServerStatus>({
    queryKey: CODE_SERVER_STATUS_QUERY_KEY,
    dataShape: "value",
    staleTimeMs: 5_000,
    enabled: isAvailable,
    refetchInterval: 10_000,
    retry: false,
    queryFn: () => requireCodeServerBridge().getStatus(),
  });

  const openWorkspace = useCallback(async (cwd: string): Promise<void> => {
    const bridge = requireCodeServerBridge();
    let status: DesktopCodeServerStatus = await bridge.getStatus();
    if (!status.running) {
      status = await bridge.start();
    }
    await bridge.openWindow({
      url: buildCodeServerFolderUrl(status.url, cwd),
      cwd,
    });
  }, []);

  return {
    isAvailable,
    isRunning: statusQuery.data?.running === true,
    openWorkspace,
  };
}
