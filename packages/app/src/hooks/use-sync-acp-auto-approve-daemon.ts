import { useEffect, useMemo, useRef } from "react";
import { readGlobalAcpAutoApprove } from "@/composer/acp-auto-approve";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useFormPreferences } from "@/hooks/use-form-preferences";

/** Mirror the desktop global Auto Approve toggle into daemon config for create-time defaults. */
export function useSyncAcpAutoApproveToDaemon(serverId: string | null): void {
  const { preferences } = useFormPreferences();
  const { patchConfig } = useDaemonConfig(serverId);
  const globalAutoApprove = useMemo(() => readGlobalAcpAutoApprove(preferences), [preferences]);
  const lastSyncedRef = useRef<boolean | undefined>(undefined);

  useEffect(() => {
    if (!serverId || globalAutoApprove === undefined) {
      return;
    }
    if (lastSyncedRef.current === globalAutoApprove) {
      return;
    }
    lastSyncedRef.current = globalAutoApprove;
    void patchConfig({ acpAutoApprove: globalAutoApprove }).catch((error) => {
      lastSyncedRef.current = undefined;
      console.warn("[useSyncAcpAutoApproveToDaemon] patch failed", error);
    });
  }, [globalAutoApprove, patchConfig, serverId]);
}
