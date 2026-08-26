import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import {
  type DesktopDeepseekHarnessBridge,
  type DesktopDeepseekHarnessOpenResult,
  type DesktopDeepseekHarnessStatus,
  getDesktopHost,
} from "@/desktop/host";
import { useDesktopSettings } from "@/desktop/settings/desktop-settings";
import { useToast } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";

interface AvailableDeepseekHarnessBridge {
  getStatus: NonNullable<DesktopDeepseekHarnessBridge["getStatus"]>;
  install: NonNullable<DesktopDeepseekHarnessBridge["install"]>;
  start: NonNullable<DesktopDeepseekHarnessBridge["start"]>;
  stop: NonNullable<DesktopDeepseekHarnessBridge["stop"]>;
  openWorkspace: NonNullable<DesktopDeepseekHarnessBridge["openWorkspace"]>;
}

const STATUS_QUERY_KEY = ["deepseek-harness-status"] as const;

function getDeepseekHarnessBridge(): AvailableDeepseekHarnessBridge | null {
  const bridge = getDesktopHost()?.deepseekHarness;
  if (
    !bridge?.getStatus ||
    !bridge.install ||
    !bridge.start ||
    !bridge.stop ||
    !bridge.openWorkspace
  ) {
    return null;
  }
  return {
    getStatus: bridge.getStatus,
    install: bridge.install,
    start: bridge.start,
    stop: bridge.stop,
    openWorkspace: bridge.openWorkspace,
  };
}

export function hasDeepseekHarnessBridge(): boolean {
  return getDeepseekHarnessBridge() !== null;
}

function requireDeepseekHarnessBridge(): AvailableDeepseekHarnessBridge {
  const bridge = getDeepseekHarnessBridge();
  if (!bridge) {
    throw new Error("DeepSeek Harness bridge is unavailable");
  }
  return bridge;
}

export function useDeepseekHarness() {
  const queryClient = useQueryClient();
  const { show } = useToast();
  const { settings, updateSettings, isSaving } = useDesktopSettings();
  const isAvailable = hasDeepseekHarnessBridge();

  const statusQuery = useFetchQuery<DesktopDeepseekHarnessStatus>({
    queryKey: STATUS_QUERY_KEY,
    dataShape: "value",
    staleTimeMs: 5_000,
    enabled: isAvailable,
    refetchInterval: 10_000,
    retry: false,
    queryFn: () => requireDeepseekHarnessBridge().getStatus(),
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
  }, [queryClient]);

  const installMutation = useMutation({
    mutationFn: () => requireDeepseekHarnessBridge().install(),
    onSuccess: async (status) => {
      queryClient.setQueryData(STATUS_QUERY_KEY, status);
      show(
        i18n.t("settings.deepseekHarness.toast.installed", {
          version: status.version ?? "",
        }),
      );
    },
    onError: (error) => {
      show(
        error instanceof Error
          ? error.message
          : i18n.t("settings.deepseekHarness.toast.installFailed"),
      );
    },
  });

  const startMutation = useMutation({
    mutationFn: () => requireDeepseekHarnessBridge().start(),
    onSuccess: async (status) => {
      queryClient.setQueryData(STATUS_QUERY_KEY, status);
    },
    onError: (error) => {
      show(
        error instanceof Error
          ? error.message
          : i18n.t("settings.deepseekHarness.toast.startFailed"),
      );
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => requireDeepseekHarnessBridge().stop(),
    onSuccess: async (status) => {
      queryClient.setQueryData(STATUS_QUERY_KEY, status);
    },
    onError: (error) => {
      show(
        error instanceof Error
          ? error.message
          : i18n.t("settings.deepseekHarness.toast.stopFailed"),
      );
    },
  });

  const openWorkspace = useCallback(
    async (input: {
      cwd: string;
      title?: string | null;
    }): Promise<DesktopDeepseekHarnessOpenResult> => {
      const result = await requireDeepseekHarnessBridge().openWorkspace(input);
      queryClient.setQueryData(STATUS_QUERY_KEY, result.status);
      return result;
    },
    [queryClient],
  );

  const setStartWithDesktop = useCallback(
    async (startWithDesktop: boolean) => {
      await updateSettings({ deepseekHarness: { startWithDesktop } });
      await invalidate();
    },
    [invalidate, updateSettings],
  );

  return {
    isAvailable,
    status: statusQuery.data ?? null,
    isLoading: statusQuery.isPending,
    isBusy:
      installMutation.isPending || startMutation.isPending || stopMutation.isPending || isSaving,
    startWithDesktop: settings.deepseekHarness.startWithDesktop,
    refresh: invalidate,
    install: () => installMutation.mutateAsync(),
    start: () => startMutation.mutateAsync(),
    stop: () => stopMutation.mutateAsync(),
    openWorkspace,
    setStartWithDesktop,
  };
}
