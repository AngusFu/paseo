import { useCallback, useEffect, useRef, useState } from "react";
import type { LlmLocalModelState } from "@getpaseo/protocol/llm/rpc-schemas";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

export interface UseLocalLlmModelResult {
  // false when the daemon lacks the localLlm capability — hide the UI entirely.
  supported: boolean;
  model: LlmLocalModelState | null;
  // COMPAT(localLlmGguf): kept for callers that still expose a download affordance.
  startDownload: () => void;
  refreshStatus: () => Promise<void>;
}

// Tracks the daemon's local LLM backend state (llm.local.status RPC).
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

  const startDownload = useCallback(() => {
    void refreshStatus();
  }, [refreshStatus]);

  return { supported: supported && client !== null, model, startDownload, refreshStatus };
}
