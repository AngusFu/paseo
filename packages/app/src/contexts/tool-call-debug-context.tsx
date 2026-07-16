import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

interface ToolCallDebugValue {
  isDebugEnabled: boolean;
  toggleDebug: () => void;
}

const ToolCallDebugContext = createContext<ToolCallDebugValue>({
  isDebugEnabled: false,
  toggleDebug: () => {},
});

/**
 * Per-transcript debug switch. Scoped to the agent stream (not persisted) so
 * turning it on to inspect one chat never leaks into others or survives a
 * reload — it exists to answer "what did the provider actually send us?".
 */
export function ToolCallDebugProvider({ children }: { children: ReactNode }) {
  const [isDebugEnabled, setIsDebugEnabled] = useState(false);
  const value = useMemo<ToolCallDebugValue>(
    () => ({
      isDebugEnabled,
      toggleDebug: () => setIsDebugEnabled((previous) => !previous),
    }),
    [isDebugEnabled],
  );
  return <ToolCallDebugContext.Provider value={value}>{children}</ToolCallDebugContext.Provider>;
}

export function useToolCallDebug(): ToolCallDebugValue {
  return useContext(ToolCallDebugContext);
}
