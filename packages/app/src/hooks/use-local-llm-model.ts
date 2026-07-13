import { useCallback, useEffect, useRef, useState } from "react";
import type { LlmLocalModelState } from "@getpaseo/protocol/llm/rpc-schemas";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

const DOWNLOAD_POLL_INTERVAL_MS = 2000;

export interface UseLocalLlmModelResult {
  // false when the daemon lacks the localLlm capability — hide the UI entirely.
  supported: boolean;
  model: LlmLocalModelState | null;
  startDownload: () => void;
  refreshStatus: () => Promise<void>;
}

// Tracks the daemon's local LLM model state (llm.local.status/download RPCs).
// Downloads never start on their own — the user explicitly triggers them.
export function useLocalLlmModel(serverId: string | null | undefined): UseLocalLlmModelResult {
  const supported = useHostFeature(serverId, "localLlm");
  const client = useHostRuntimeClient(serverId ?? "");
  const [model, setModel] = useState<LlmLocalModelState | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!client) {
      return;
    }
    try {
      const payload = await client.llmLocalStatus();
      if (mountedRef.current) {
        setModel(payload.model);
      }
    } catch {
      // Status is cosmetic; leave the last known state in place.
    }
  }, [client]);

  useEffect(() => {
    if (!supported || !client) {
      return;
    }
    void refreshStatus();
  }, [supported, client, refreshStatus]);

  // While a download is in flight, poll so the progress line moves even though
  // this hook doesn't subscribe to llm.local.status.update pushes.
  useEffect(() => {
    if (!supported || model?.status !== "downloading") {
      return;
    }
    const timer = setInterval(() => {
      void refreshStatus();
    }, DOWNLOAD_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [supported, model?.status, refreshStatus]);

  const startDownload = useCallback(() => {
    if (!client) {
      return;
    }
    void (async () => {
      try {
        const payload = await client.llmLocalDownload();
        if (mountedRef.current) {
          setModel(payload.model);
        }
      } catch {
        await refreshStatus();
      }
    })();
  }, [client, refreshStatus]);

  return { supported: supported && client !== null, model, startDownload, refreshStatus };
}
