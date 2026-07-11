import { useCallback } from "react";
import type { ServerDiffToolsCapability } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { getDiffToolsCapability } from "@/utils/server-info-capabilities";

// Reads the diffTools tri-state capability off the server_info snapshot, same shape as
// useIsDictationReady reads the voice capability. Returns null when the connected server
// never sent capabilities.diffTools (COMPAT: pre v0.1.107 servers) — callers treat that as
// "no non-git engines available", not as an explicit unavailable state.
export function useDiffToolsCapability(serverId: string): ServerDiffToolsCapability | null {
  return useSessionStore(
    useCallback(
      (state) => {
        const serverInfo = state.sessions[serverId]?.serverInfo ?? null;
        return getDiffToolsCapability({ serverInfo });
      },
      [serverId],
    ),
  );
}
