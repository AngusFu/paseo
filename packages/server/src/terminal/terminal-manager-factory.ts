import type { TerminalManager } from "./terminal-manager.js";
import { createWorkerTerminalManager } from "./worker-terminal-manager.js";

export interface ConfiguredTerminalManagerOptions {
  /** Daemon home — used to prepend `$PASEO_HOME/mcp-cli/bin` into new terminals. */
  paseoHome?: string;
  getTerminalActivityUrl?: () => string | null;
}

export function createConfiguredTerminalManager(
  options: ConfiguredTerminalManagerOptions = {},
): TerminalManager {
  return createWorkerTerminalManager(options);
}
