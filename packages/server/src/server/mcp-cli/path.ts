import { delimiter } from "node:path";
import { mcpCliBinDir } from "./paths.js";

function getPathEnvKey(env: Record<string, string>): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

export function prependPathEntry(currentPath: string, entry: string): string {
  const entries = currentPath.split(delimiter).filter((value) => value && value !== entry);
  return [entry, ...entries].join(delimiter);
}

/**
 * Prepend `$PASEO_HOME/mcp-cli/bin` for agent + terminal processes.
 * Never writes into ~/.local/bin — only mutates the env PATH for this process tree.
 */
export function prependMcpCliBinPath(
  env: Record<string, string>,
  paseoHome: string,
): Record<string, string> {
  const binDir = mcpCliBinDir(paseoHome);
  const pathKey = getPathEnvKey(env);
  const currentPath = env[pathKey] ?? "";
  return {
    ...env,
    [pathKey]: prependPathEntry(currentPath, binDir),
  };
}
