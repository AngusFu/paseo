import { useCallback, useEffect, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  InstallDifftasticProgressMessage,
  InstallDifftasticResponse,
} from "@getpaseo/protocol/messages";

export type InstallDifftasticStatus =
  | "idle"
  | InstallDifftasticProgressMessage["payload"]["phase"]
  | "success"
  | "error";

interface UseInstallDifftasticResult {
  status: InstallDifftasticStatus;
  error: string | null;
  // False on a client build that hasn't shipped the install RPC yet — the caller falls back
  // to a disabled/tooltip state instead of a broken button (see DiffEngineMenu).
  isSupported: boolean;
  install: () => void;
}

// Duck-typed against DaemonClient.installDifftastic (the RPC exists in @getpaseo/client).
// The runtime check keeps this hook degrading gracefully (isSupported: false) against an
// older client build that predates the install RPC, instead of throwing on call.
interface DifftasticInstallCapableClient {
  installDifftastic(options: { requestId: string }): Promise<InstallDifftasticResponse["payload"]>;
}

function asDifftasticInstallClient(
  client: DaemonClient | null,
): DifftasticInstallCapableClient | null {
  if (!client) {
    return null;
  }
  const candidate = client as unknown as Partial<DifftasticInstallCapableClient>;
  return typeof candidate.installDifftastic === "function"
    ? (candidate as DifftasticInstallCapableClient)
    : null;
}

export function useInstallDifftastic(client: DaemonClient | null): UseInstallDifftasticResult {
  const [status, setStatus] = useState<InstallDifftasticStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const activeRequestIdRef = useRef<string | null>(null);
  const installCapableClient = asDifftasticInstallClient(client);

  useEffect(() => {
    if (!client) {
      return;
    }
    const unsubscribeProgress = client.on("install_difftastic_progress", (message) => {
      if (message.payload.requestId !== activeRequestIdRef.current) {
        return;
      }
      setStatus(message.payload.phase);
    });
    const unsubscribeResponse = client.on("install_difftastic_response", (message) => {
      if (message.payload.requestId !== activeRequestIdRef.current) {
        return;
      }
      activeRequestIdRef.current = null;
      if (message.payload.success) {
        setStatus("success");
        setError(null);
      } else {
        setStatus("error");
        setError(message.payload.error);
      }
    });
    return () => {
      unsubscribeProgress();
      unsubscribeResponse();
    };
  }, [client]);

  // All in-flight phases — re-entrancy guard must cover the whole install, not just the
  // first two phases, or a click during verify/install would fire a second request.
  const busy =
    status === "starting" ||
    status === "downloading" ||
    status === "verifying" ||
    status === "installing";

  const install = useCallback(() => {
    if (!installCapableClient || busy) {
      return;
    }
    const requestId = crypto.randomUUID();
    activeRequestIdRef.current = requestId;
    setStatus("starting");
    setError(null);
    void installCapableClient.installDifftastic({ requestId }).catch((installError: unknown) => {
      if (activeRequestIdRef.current !== requestId) {
        return;
      }
      activeRequestIdRef.current = null;
      setStatus("error");
      setError(installError instanceof Error ? installError.message : String(installError));
    });
  }, [installCapableClient, busy]);

  return {
    status,
    error,
    isSupported: installCapableClient !== null,
    install,
  };
}
